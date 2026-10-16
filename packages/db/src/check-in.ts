import { and, eq, inArray, asc, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { CHECK_IN_TEXT, CHECK_IN_HANDOFF_TEXT, CHECK_IN_WINDOW_MS, DEFAULT_CHECK_IN_OPTIONS, nextCheckInAt, validateCheckInOptions, type CheckInOptions } from '@qure/core/check-in/policy';
import type { QueueNotice } from './queue-engine';
import * as s from './schema';

type Session=typeof s.sessions.$inferSelect;
function eligible(session:Session,hasStaff:boolean,entry:typeof s.queueEntries.$inferSelect|undefined):boolean {
  return session.status === 'waiting' && !session.isEmergency && !session.wantsHuman && session.assignedNurse === null && !hasStaff
    && (session.priority === null || session.priority === 'P3') && entry?.lane === 'normal' && entry.status === 'waiting';
}
function inWindow(session:Session,now:Date):boolean {
  return session.lastPatientMessageAt !== null && session.lastPatientMessageAt.getTime() <= now.getTime()
    && now.getTime()-session.lastPatientMessageAt.getTime()<CHECK_IN_WINDOW_MS;
}
export interface CheckInEngine {
  refresh(now?:Date):Promise<void>;
  claimNotice(now?:Date):Promise<QueueNotice|null>;
  finishNotice(id:string,delivery:'sent'|'failed',now?:Date):Promise<void>;
}

/** Durable per-visit schedules and outbox. Locks follow patient -> session -> message. */
export function createCheckInEngine<T extends PgQueryResultHKT>(db:PgDatabase<T,typeof s>,options:CheckInOptions=DEFAULT_CHECK_IN_OPTIONS):CheckInEngine {
  validateCheckInOptions(options);
  type Tx=Parameters<Parameters<typeof db.transaction>[0]>[0];
  async function cancelPending(tx:Tx,id:string,remindersOnly=false) {
    await tx.update(s.messages).set({meta:sql`${s.messages.meta} || '{"delivery":"cancelled"}'::jsonb`}).where(and(
      eq(s.messages.sessionId,id),sql`${s.messages.meta}->>'checkInKey' is not null`,sql`${s.messages.meta}->>'delivery' = 'pending'`,...(remindersOnly ? [sql`${s.messages.meta}->>'checkInPhase' = 'reminder'`] : [])));
  }
  async function handoff(tx:Tx,session:Session,phone:string,reason:string,now:Date,notify:boolean) {
    await cancelPending(tx,session.id);
    await tx.update(s.sessions).set({status:'escalated',priority:session.priority === 'P1' ? 'P1' : 'P2',wantsHuman:true,nextCheckIn:null}).where(eq(s.sessions.id,session.id));
    await tx.update(s.queueEntries).set({lane:'priority',tierAtJoin:'P2',callbackSlot:null,nursePagedAt:now}).where(eq(s.queueEntries.sessionId,session.id));
    await tx.insert(s.messages).values({sessionId:session.id,direction:'outbound',sender:notify?'bot':'system',kind:'text',createdAt:now,
      body:notify?CHECK_IN_HANDOFF_TEXT:'Pemeriksaan berkala dihentikan; kunjungan perlu ditinjau petugas.',
      meta:{phone,purpose:'reply',delivery:notify?'pending':'internal',checkInEvent:'handoff',reason,
        ...(notify?{checkInKey:`${session.id}:handoff`,checkInPhase:'handoff'}:{})}});
  }
  return {
    async refresh(now=new Date()) {
      // Non-locking candidate scan; each visit is re-read under the same lock
      // order as inbound processing and staff takeover. Skip busy patients.
      const candidates=await db.select({id:s.sessions.id,patientId:s.sessions.patientId}).from(s.sessions)
        .where(and(inArray(s.sessions.status,['waiting','escalated','green_lane','served','closed']),
          sql`(${s.sessions.nextCheckIn} <= ${now.toISOString()} or (${s.sessions.nextCheckIn} is null and ${s.sessions.status} = 'waiting' and ${s.sessions.checkInCount} = 0
            and ${s.sessions.assignedNurse} is null and not ${s.sessions.wantsHuman} and not ${s.sessions.isEmergency}
            and (${s.sessions.priority} is null or ${s.sessions.priority} = 'P3')
            and exists(select 1 from ${s.queueEntries} q where q.session_id = ${s.sessions.id} and q.lane = 'normal' and q.status = 'waiting')
            and not exists(select 1 from ${s.messages} m where m.session_id = ${s.sessions.id} and m.sender = 'nurse')))`))
        .orderBy(asc(s.sessions.nextCheckIn),asc(s.sessions.id)).limit(200);
      for(const candidate of candidates) await db.transaction(async tx=>{
        const [patient]=await tx.select().from(s.patients).where(eq(s.patients.id,candidate.patientId)).for('update',{skipLocked:true});
        if(!patient) return;
        const [session]=await tx.select().from(s.sessions).where(eq(s.sessions.id,candidate.id)).for('update');
        if(!session) return;
        const [entry]=await tx.select().from(s.queueEntries).where(eq(s.queueEntries.sessionId,session.id));
        const [staff]=await tx.select({id:s.messages.id}).from(s.messages).where(and(eq(s.messages.sessionId,session.id),eq(s.messages.sender,'nurse'))).limit(1);
        if(!eligible(session,Boolean(staff),entry)) {
          await tx.update(s.sessions).set({nextCheckIn:null}).where(eq(s.sessions.id,session.id));
          await cancelPending(tx,session.id,session.status === 'escalated' && session.wantsHuman && !session.isEmergency && session.assignedNurse === null && !staff);return;
        }
        if(!inWindow(session,now)) {
          await handoff(tx,session,patient.waNumber,'contact_window_expired',now,false);return;
        }
        const due=session.nextCheckIn ?? nextCheckInAt(new Date(Math.max(entry!.joinedAt.getTime(),session.lastPatientMessageAt!.getTime())),options);
        if(due > now) {
          if(!session.nextCheckIn) await tx.update(s.sessions).set({nextCheckIn:due}).where(eq(s.sessions.id,session.id));
          return;
        }
        const [unfinished]=await tx.select({id:s.messages.id}).from(s.messages).where(and(eq(s.messages.sessionId,session.id),
          sql`${s.messages.meta}->>'checkInKey' is not null`,sql`${s.messages.meta}->>'delivery' in ('pending','sending')`)).limit(1);
        if(unfinished || session.checkInCount>=options.maxReminders) {
          await handoff(tx,session,patient.waNumber,unfinished?'delivery_unresolved':'reminder_limit',now,true);return;
        }
        const attempt=session.checkInCount+1;
        await tx.insert(s.messages).values({sessionId:session.id,direction:'outbound',sender:'bot',kind:'text',body:CHECK_IN_TEXT,createdAt:now,
          meta:{phone:patient.waNumber,purpose:'reply',delivery:'pending',checkInKey:`${session.id}:${attempt}`,checkInPhase:'reminder',attempt,
            activityAt:session.lastPatientMessageAt!.toISOString()}});
        // Count reserved attempts, including failed/uncertain delivery, so a
        // restart or provider outage cannot reset the bound or spam retries.
        await tx.update(s.sessions).set({checkInCount:attempt,nextCheckIn:nextCheckInAt(now,options)}).where(eq(s.sessions.id,session.id));
      });
    },
    async claimNotice(now=new Date()) {
      for(let i=0;i<20;i++) {
        const [candidate]=await db.select({id:s.messages.id,sessionId:s.messages.sessionId,patientId:s.sessions.patientId}).from(s.messages)
          .innerJoin(s.sessions,eq(s.sessions.id,s.messages.sessionId))
          .where(and(sql`${s.messages.meta}->>'checkInKey' is not null`,sql`${s.messages.meta}->>'delivery' = 'pending'`))
          .orderBy(asc(s.messages.createdAt),asc(s.messages.id)).limit(1);
        if(!candidate) return null;
        const result=await db.transaction(async tx=>{
          const [patient]=await tx.select().from(s.patients).where(eq(s.patients.id,candidate.patientId)).for('update',{skipLocked:true});
          if(!patient) return null;
          const [session]=await tx.select().from(s.sessions).where(eq(s.sessions.id,candidate.sessionId)).for('update');
          const [message]=await tx.select().from(s.messages).where(eq(s.messages.id,candidate.id)).for('update');
          if(!session || !message || message.meta?.delivery !== 'pending') return null;
          const [staff]=await tx.select({id:s.messages.id}).from(s.messages).where(and(eq(s.messages.sessionId,session.id),eq(s.messages.sender,'nurse'))).limit(1);
          const [entry]=await tx.select().from(s.queueEntries).where(eq(s.queueEntries.sessionId,session.id));
          const valid=inWindow(session,now) && session.assignedNurse === null && !staff && !session.isEmergency &&
            (message.meta.checkInPhase === 'handoff'
              ? session.status === 'escalated' && session.wantsHuman
              : eligible(session,false,entry) && message.meta.activityAt === session.lastPatientMessageAt?.toISOString());
          await tx.update(s.messages).set({meta:{...message.meta,delivery:valid?'sending':'cancelled'}}).where(eq(s.messages.id,message.id));
          return valid ? {id:message.id,sessionId:session.id,reply:{phone:patient.waNumber,text:message.body,purpose:'reply' as const}} : null;
        });
        if(result) return result;
      }
      return null;
    },
    async finishNotice(id,delivery,now=new Date()) {
      await db.transaction(async tx=>{
        const [candidate]=await tx.select({patientId:s.sessions.patientId,sessionId:s.sessions.id}).from(s.messages)
          .innerJoin(s.sessions,eq(s.sessions.id,s.messages.sessionId)).where(eq(s.messages.id,id));
        if(!candidate) return;
        const [patient]=await tx.select().from(s.patients).where(eq(s.patients.id,candidate.patientId)).for('update');
        const [session]=await tx.select().from(s.sessions).where(eq(s.sessions.id,candidate.sessionId)).for('update');
        const [message]=await tx.select().from(s.messages).where(eq(s.messages.id,id)).for('update');
        if(!message || message.meta?.delivery !== 'sending') return;
        await tx.update(s.messages).set({meta:{...message.meta,delivery,...(delivery === 'sent'?{sentAt:now.toISOString()}:{})}}).where(eq(s.messages.id,id));
        const [staff]=await tx.select({id:s.messages.id}).from(s.messages).where(and(eq(s.messages.sessionId,candidate.sessionId),eq(s.messages.sender,'nurse'))).limit(1);
        const [entry]=await tx.select().from(s.queueEntries).where(eq(s.queueEntries.sessionId,candidate.sessionId));
        if(session && message.meta.checkInPhase === 'reminder' && eligible(session,Boolean(staff),entry) && message.meta.activityAt === session.lastPatientMessageAt?.toISOString()) {
          if(delivery === 'failed') await handoff(tx,session,patient!.waNumber,'delivery_failed',now,inWindow(session,now));
          else await tx.update(s.sessions).set({nextCheckIn:nextCheckInAt(now,options)}).where(eq(s.sessions.id,session.id));
        }
      });
    },
  };
}
