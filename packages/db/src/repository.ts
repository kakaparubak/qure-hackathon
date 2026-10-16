import { eq, and, inArray, sql, desc } from 'drizzle-orm';
import { ALLOWED_TRANSITIONS, type SessionStatus, type TriageTier, type Decision, type InboundMessage } from '@qure/core';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { readIntake } from '@qure/core/intake/engine';
import * as schema from './schema';
import { deriveQueueRows } from './queue';
import { decisionToRow, inboundToRow } from './mapping';

export function assertSessionUpdate(current: {status:SessionStatus; priority:TriageTier; wantsHuman:boolean}, next: {status?:SessionStatus; priority?:TriageTier; wantsHuman?:boolean}) {
  if (next.status && next.status !== current.status && !ALLOWED_TRANSITIONS[current.status].includes(next.status)) {
    throw new Error(`Illegal session transition: ${current.status} -> ${next.status}`);
  }
  const ranks = {P1:1,P2:2,P3:3};
  if (current.priority !== null && next.priority !== undefined && (next.priority === null || ranks[next.priority] > ranks[current.priority])) {
    throw new Error('Session priority cannot de-escalate');
  }
  if (current.wantsHuman && next.wantsHuman === false) throw new Error('Human request cannot be cleared');
}

/** All read/check/write steps share a transaction and row lock. SQL guards also protect direct writers. */
export function createRepository<T extends PgQueryResultHKT>(db:PgDatabase<T, typeof schema>) {
  return {
    /** Marks a session served and its queue entry done. Idempotent for already-finished sessions. */
    async serveSession(id:string):Promise<'served'|'already_finished'|'missing'> {
      return db.transaction(async tx=>{
        const [current]=await tx.select().from(schema.sessions).where(eq(schema.sessions.id,id)).for('update');
        if(!current) return 'missing';
        if(current.status==='served'||current.status==='closed') return 'already_finished';
        // Waiting and escalated are the live states a nurse can finish; the
        // contracts' ALLOWED_TRANSITIONS allow both -> served.
        if(current.status!=='waiting'&&current.status!=='escalated'&&current.status!=='green_lane') return 'missing';
        const [updated]=await tx.update(schema.sessions).set({status:current.status==='green_lane'?'closed':'served',closedAt:new Date(),nextCheckIn:null}).where(eq(schema.sessions.id,id)).returning();
        await tx.update(schema.queueEntries).set({status:'served',completedAt:new Date()}).where(and(eq(schema.queueEntries.sessionId,id),inArray(schema.queueEntries.status,['waiting','called'])));
        await tx.update(schema.messages).set({meta:sql`${schema.messages.meta} || '{"delivery":"cancelled"}'::jsonb`}).where(and(
          eq(schema.messages.sessionId,id),sql`${schema.messages.meta}->>'checkInKey' is not null`,sql`${schema.messages.meta}->>'delivery' = 'pending'`));
        return updated?'served':'missing';
      });
    },
    async sessionDetail(id:string) {
      const [row]=await db.select({
        sessionId:schema.sessions.id, startedAt:schema.sessions.createdAt,
        patientId:schema.patients.id, name:schema.patients.name, birthDate:schema.patients.birthDate,
        intake:schema.sessions.intake, assignedNurse:schema.sessions.assignedNurse,
      }).from(schema.sessions).innerJoin(schema.patients,eq(schema.patients.id,schema.sessions.patientId)).where(eq(schema.sessions.id,id));
      if(!row) return null;
      const conditions=await db.select({display:schema.patientConditions.display}).from(schema.patientConditions)
        .where(and(eq(schema.patientConditions.patientId,row.patientId),eq(schema.patientConditions.clinicalStatus,'active')));
      // Age: intake is the live source (patients may give age without a birth date).
      const intakeAge=(row.intake as {fields?:{ageYears?:number}}|null)?.fields?.ageYears;
      const age=intakeAge ?? (row.birthDate ? Math.floor((Date.now()-new Date(row.birthDate).getTime())/(365.25*24*3600*1000)) : null);
      const allergy = reportedAllergy(row.intake);
      return {sessionId:row.sessionId,startedAt:row.startedAt.toISOString(),staffHandling:row.assignedNurse !== null,patient:{name:row.name,age},conditions:[
        ...conditions.map(c=>c.display),
        ...(allergy ? [`Alergi (dilaporkan pasien): ${allergy}`] : []),
      ]};
    },
    async sessionTriage(id:string) {
      const rows=await db.select({
        id:schema.triageResults.id, tier:schema.triageResults.tier, family:schema.triageResults.redFlagFamily,
        escalated:schema.triageResults.escalated, flowAction:schema.triageResults.flowAction, createdAt:schema.triageResults.createdAt,
      }).from(schema.triageResults).where(eq(schema.triageResults.sessionId,id)).orderBy(desc(schema.triageResults.createdAt));
      return rows.map(r=>({id:r.id,tier:r.tier,family:r.family,reason:r.escalated?r.flowAction:null,createdAt:r.createdAt.toISOString()}));
    },
    async sessionMessages(id:string) {
      const rows=await db.select({
        id:schema.messages.id, sender:schema.messages.sender, body:schema.messages.body, createdAt:schema.messages.createdAt,
      }).from(schema.messages).where(and(eq(schema.messages.sessionId,id),eq(schema.messages.kind,'text'))).orderBy(schema.messages.createdAt);
      return rows.map(r=>({id:r.id,role:r.sender,content:r.body,createdAt:r.createdAt.toISOString()}));
    },
    /** Claim before sending. Use the same patient -> session lock order as intake. */
    async claimStaffSession(id:string):Promise<string|null> {
      return db.transaction(async tx=>{
        const [visit]=await tx.select({patientId:schema.sessions.patientId}).from(schema.sessions).where(eq(schema.sessions.id,id));
        if(!visit) return null;
        const [patient]=await tx.select().from(schema.patients).where(eq(schema.patients.id,visit.patientId)).for('update');
        const [session]=await tx.select().from(schema.sessions).where(eq(schema.sessions.id,id)).for('update');
        if(!session || !['waiting','escalated','green_lane'].includes(session.status)) return null;
        await tx.update(schema.sessions).set({assignedNurse:session.assignedNurse ?? 'staff',nextCheckIn:null}).where(eq(schema.sessions.id,id));
        await tx.update(schema.messages).set({meta:sql`${schema.messages.meta} || '{"delivery":"cancelled"}'::jsonb`}).where(and(
          eq(schema.messages.sessionId,id),sql`${schema.messages.meta}->>'checkInKey' is not null`,sql`${schema.messages.meta}->>'delivery' = 'pending'`));
        return patient!.waNumber;
      });
    },
    /** The E.164 a session's patient chats from; null when the session does not exist. */
    async sessionPhone(id:string):Promise<string|null> {
      const [row]=await db.select({wa:schema.patients.waNumber}).from(schema.sessions)
        .innerJoin(schema.patients,eq(schema.patients.id,schema.sessions.patientId)).where(eq(schema.sessions.id,id));
      return row?.wa ?? null;
    },
    /** Persists a message a nurse sent from the dashboard, after the transport accepted it. */
    async recordNurseMessage(sessionId:string, body:string) {
      const [row]=await db.insert(schema.messages).values({
        sessionId,direction:'outbound',kind:'text',sender:'nurse',body,
        meta:{purpose:'reply',delivery:'sent',sentAt:new Date().toISOString()},
      }).returning();
      return row!;
    },
    async readQueueBoard(now=new Date(), serviceMinutes?:number) {
      const entries = await db.select({
        sessionId:schema.sessions.id, patientName:schema.patients.name,
        tier:schema.sessions.priority, lane:schema.queueEntries.lane,
        joinedAt:schema.queueEntries.joinedAt,
        ticketNumber:schema.queueEntries.queueNumber, ticketDate:schema.queueEntries.queueDate,
        callbackSlot:schema.queueEntries.callbackSlot,
        intake:schema.sessions.intake,
        hasAllergies:sql<boolean>`exists(select 1 from ${schema.patientConditions} where ${schema.patientConditions.patientId} = ${schema.patients.id} and ${schema.patientConditions.kind} = 'allergy' and ${schema.patientConditions.clinicalStatus} = 'active')`,
      }).from(schema.queueEntries)
        .innerJoin(schema.sessions,eq(schema.sessions.id,schema.queueEntries.sessionId))
        .innerJoin(schema.patients,eq(schema.patients.id,schema.sessions.patientId))
        .where(and(inArray(schema.queueEntries.status,['waiting','called']),inArray(schema.sessions.status,['waiting','escalated','green_lane'])));
      return deriveQueueRows(entries.map(({intake,...entry})=>({
        ...entry,hasAllergies:entry.hasAllergies || reportedAllergy(intake) !== null,
      })),now,serviceMinutes);
    },
    async updateSession(id:string, next: {status?:SessionStatus; priority?:TriageTier; wantsHuman?:boolean}) {
      return db.transaction(async tx => {
        const [current] = await tx.select().from(schema.sessions).where(eq(schema.sessions.id,id)).for('update');
        if (!current) throw new Error('Session not found');
        assertSessionUpdate(current,next);
        const stopCheckIns=(next.status !== undefined && next.status !== 'waiting') || next.wantsHuman === true || (next.priority !== undefined && next.priority !== null && next.priority !== 'P3');
        const [updated] = await tx.update(schema.sessions).set({...next, ...(stopCheckIns ? {nextCheckIn:null} : {}), ...(next.status === 'closed' ? {closedAt:new Date()} : {})}).where(eq(schema.sessions.id,id)).returning();
        if(stopCheckIns) await tx.update(schema.messages).set({meta:sql`${schema.messages.meta} || '{"delivery":"cancelled"}'::jsonb`}).where(and(
          eq(schema.messages.sessionId,id),sql`${schema.messages.meta}->>'checkInKey' is not null`,sql`${schema.messages.meta}->>'delivery' = 'pending'`));
        return updated!;
      });
    },
    async recordInbound(sessionId:string, msg:InboundMessage) {
      const [row] = await db.insert(schema.messages).values(inboundToRow(sessionId,msg)).onConflictDoNothing({target:schema.messages.waMessageId}).returning();
      return row ?? null;
    },
    async appendDecision(sessionId:string, decision:Decision, context:Parameters<typeof decisionToRow>[2]) {
      const [row] = await db.insert(schema.triageResults).values(decisionToRow(sessionId,decision,context)).returning();
      return row!;
    },
  };
}

/** Patient reports remain intake data; displaying them does not confirm a clinical Condition. */
function reportedAllergy(intake:unknown):string|null {
  const value=readIntake(intake).fields.allergies?.trim();
  if (!value || /^(?:(?:tidak|gak|nggak|tdk|enggak)(?: ada| punya| tahu)?(?: alergi)?|belum tahu|none|no|unknown)[.!?\s]*$/i.test(value)) return null;
  return value;
}
