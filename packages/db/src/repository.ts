import { eq, and, inArray, sql } from 'drizzle-orm';
import { ALLOWED_TRANSITIONS, type SessionStatus, type TriageTier, type Decision, type InboundMessage } from '@qure/core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
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
export function createRepository(db:PostgresJsDatabase<typeof schema>) {
  return {
    async readQueueBoard(now=new Date(), serviceMinutes?:number) {
      const entries = await db.select({
        sessionId:schema.sessions.id, patientName:schema.patients.name,
        tier:schema.sessions.priority, lane:schema.queueEntries.lane,
        joinedAt:schema.queueEntries.joinedAt,
        ticketNumber:schema.queueEntries.queueNumber, ticketDate:schema.queueEntries.queueDate,
        hasAllergies:sql<boolean>`exists(select 1 from ${schema.patientConditions} where ${schema.patientConditions.patientId} = ${schema.patients.id} and ${schema.patientConditions.kind} = 'allergy' and ${schema.patientConditions.clinicalStatus} = 'active')`,
      }).from(schema.queueEntries)
        .innerJoin(schema.sessions,eq(schema.sessions.id,schema.queueEntries.sessionId))
        .innerJoin(schema.patients,eq(schema.patients.id,schema.sessions.patientId))
        .where(and(inArray(schema.queueEntries.status,['waiting','called']),inArray(schema.sessions.status,['waiting','escalated','green_lane'])));
      return deriveQueueRows(entries,now,serviceMinutes);
    },
    async updateSession(id:string, next: {status?:SessionStatus; priority?:TriageTier; wantsHuman?:boolean}) {
      return db.transaction(async tx => {
        const [current] = await tx.select().from(schema.sessions).where(eq(schema.sessions.id,id)).for('update');
        if (!current) throw new Error('Session not found');
        assertSessionUpdate(current,next);
        const [updated] = await tx.update(schema.sessions).set({...next, ...(next.status === 'closed' ? {closedAt:new Date()} : {})}).where(eq(schema.sessions.id,id)).returning();
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
