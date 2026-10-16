import { and, eq, inArray, sql, asc, desc } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { OutboundMessage } from '@qure/core';
import { queueStatus, surgeNotice, queueEtaText, type QueueStatus } from '@qure/core/queue/surge';
import * as s from './schema';

export interface QueueEngineOptions {
  serviceMinutes?:number;
  callbackDelayMinutes:number;
  callbackSpacingMinutes:number;
}
export const DEFAULT_QUEUE_OPTIONS:QueueEngineOptions={callbackDelayMinutes:60,callbackSpacingMinutes:10};
export interface QueueNotice {id:string;sessionId:string;reply:OutboundMessage;}
export interface QueueEngine {
  refresh(now?:Date):Promise<QueueStatus>;
  status():Promise<QueueStatus>;
  claimNotice():Promise<QueueNotice|null>;
  finishNotice(id:string,delivery:'sent'|'failed'):Promise<void>;
}

/** Conservative evidence across the whole visit, not the last 'tidak ada' answer. */
export function lowAcuityEvidence() {
  // Keep the outer reference qualified even in a single-table projection;
  // otherwise Drizzle can shorten it to id and correlate against t.id.
  const sessionId=sql.raw('"sessions"."id"');
  return sql<boolean>`exists(select 1 from ${s.triageResults} t where t.session_id = ${sessionId}
    and t.layer = 'decision_model' and t.score_urgency <= 1
    and t.clarity in ('mostly_clear','crystal_clear') and t.category in ('minor','chronic_medication'))
    and not exists(select 1 from ${s.triageResults} t where t.session_id = ${sessionId}
      and (t.escalated or t.score_urgency > 1 or t.score_wants_human >= 0.5))`;
}

export function createQueueEngine<T extends PgQueryResultHKT>(db:PgDatabase<T,typeof s>,options:QueueEngineOptions=DEFAULT_QUEUE_OPTIONS):QueueEngine {
  for(const value of [options.callbackDelayMinutes,options.callbackSpacingMinutes,...(options.serviceMinutes === undefined ? [] : [options.serviceMinutes])]) {
    if(!Number.isFinite(value)||value <= 0) throw new Error('Queue timing must be finite and positive');
  }
  async function status():Promise<QueueStatus> {
    const rows=await db.select({tier:s.sessions.priority}).from(s.queueEntries)
      .innerJoin(s.sessions,eq(s.sessions.id,s.queueEntries.sessionId))
      .where(and(inArray(s.queueEntries.status,['waiting','called']),inArray(s.sessions.status,['waiting','escalated','green_lane'])));
    return queueStatus(rows.map(row=>row.tier));
  }
  return {
    status,
    async refresh(now=new Date()) {
      return db.transaction(async tx=>{
        await tx.insert(s.queueRuntime).values({id:'main'}).onConflictDoNothing();
        const [runtime]=await tx.select().from(s.queueRuntime).where(eq(s.queueRuntime.id,'main')).for('update');
        const rows=await tx.select({
          entry:s.queueEntries,session:s.sessions,phone:s.patients.waNumber,
          lowAcuity:lowAcuityEvidence(),
          hasStaff:sql<boolean>`exists(select 1 from ${s.messages} m where m.session_id = ${s.sessions.id} and m.sender = 'nurse')`,
        }).from(s.queueEntries).innerJoin(s.sessions,eq(s.sessions.id,s.queueEntries.sessionId))
          .innerJoin(s.patients,eq(s.patients.id,s.sessions.patientId))
          .where(and(inArray(s.queueEntries.status,['waiting','called']),inArray(s.sessions.status,['waiting','escalated','green_lane'])))
          .orderBy(s.queueEntries.joinedAt,s.sessions.id);
        const state=queueStatus(rows.map(row=>row.session.priority));
        const episode=runtime!.episode + (state.surgeActive && !runtime!.surgeActive ? 1 : 0);
        await tx.update(s.queueRuntime).set({surgeActive:state.surgeActive,episode}).where(eq(s.queueRuntime.id,'main'));
        const priorityCount=rows.filter(row=>row.entry.lane === 'priority').length;
        let normalPosition=0;
        for(const {entry,session,phone,lowAcuity,hasStaff} of rows) {
          if(entry.lane !== 'normal') continue;
          normalPosition++;
          const eta=options.serviceMinutes === undefined ? null : Math.ceil((priorityCount+normalPosition-1)*options.serviceMinutes);
          const reason=priorityCount > 0 ? 'Kasus prioritas didahulukan' : 'Urutan antrean saat ini';
          await tx.update(s.queueEntries).set({etaMinutes:eta,etaReason:reason}).where(eq(s.queueEntries.id,entry.id));
          if(session.status !== 'waiting' || session.assignedNurse !== null || hasStaff || session.wantsHuman || session.isEmergency || (session.priority !== null && session.priority !== 'P3')) continue;
          // One notice per patient and surge phase, including patients joining
          // an existing surge. The singleton lock protects dedup across processes.
          if(episode === 0) continue;
          const phase=state.surgeActive ? 'surge' : 'recovery';
          const key=`${episode}:${phase}:${session.id}`;
          const [existing]=await tx.select({id:s.messages.id}).from(s.messages)
            .where(sql`${s.messages.meta}->>'queueKey' = ${key}`).limit(1);
          if(existing) {
            // One surge broadcast, followed by separate ETA updates only when
            // the estimate changes. Pending notices also count, avoiding a
            // fresh message on each poll while transport is still catching up.
            if(state.surgeActive && eta !== null) {
              const [previous]=await tx.select().from(s.messages).where(and(
                eq(s.messages.sessionId,session.id),sql`${s.messages.meta}->>'queueEpisode' = ${String(episode)}`,
                sql`${s.messages.meta}->>'queuePhase' = 'surge'`,
                sql`${s.messages.meta}->>'delivery' in ('pending','sending','sent')`,
              )).orderBy(desc(s.messages.createdAt),desc(s.messages.id)).limit(1);
              const priorEta=previous?.meta?.estimatedMinutes;
              const updateKey=`${episode}:eta:${session.id}:${eta}`;
              const [alreadyUpdated]=await tx.select({id:s.messages.id}).from(s.messages)
                .where(sql`${s.messages.meta}->>'queueKey' = ${updateKey}`).limit(1);
              if(typeof priorEta === 'number' && priorEta !== eta && !alreadyUpdated) {
                await tx.insert(s.messages).values({sessionId:session.id,direction:'outbound',sender:'bot',kind:'text',createdAt:now,
                  body:`Estimasi antrean berubah dari ${priorEta} menjadi sekitar ${eta} menit karena urutan kasus prioritas diperbarui. Jika keluhan memburuk, balas pesan ini; ketik "petugas" untuk bantuan.`,
                  meta:{phone,purpose:'queue_update',delivery:'pending',queueKey:updateKey,queueEpisode:episode,queuePhase:'surge',estimatedMinutes:eta}});
              }
            }
            continue;
          }
          // Recovery is only useful to someone actually sent the surge notice.
          if(!state.surgeActive) {
            const [notified]=await tx.select({id:s.messages.id}).from(s.messages).where(and(
              eq(s.messages.sessionId,session.id),
              sql`${s.messages.meta}->>'queueKey' = ${`${episode}:surge:${session.id}`}`,
              sql`${s.messages.meta}->>'delivery' = 'sent'`,
            )).limit(1);
            if(!notified) continue;
          }
          const offerGreen=state.surgeActive && lowAcuity && entry.status === 'waiting';
          const body=state.surgeActive ? surgeNotice(eta,offerGreen)
            : `Lonjakan kasus darurat telah mereda. ${queueEtaText(eta)} Jika keluhan memburuk, balas pesan ini; ketik "petugas" untuk bantuan.`;
          await tx.insert(s.messages).values({sessionId:session.id,direction:'outbound',sender:'bot',kind:'text',body,createdAt:now,
            meta:{phone,purpose:state.surgeActive?'surge_broadcast':'queue_update',delivery:'pending',queueKey:key,queueEpisode:episode,queuePhase:phase,greenOffer:offerGreen,estimatedMinutes:eta}});
        }
        return state;
      });
    },
    async claimNotice() {
      return db.transaction(async tx=>{
        const [message]=await tx.select().from(s.messages).where(and(
          sql`${s.messages.meta}->>'queueKey' is not null`,sql`${s.messages.meta}->>'delivery' = 'pending'`,
        )).orderBy(asc(s.messages.createdAt),asc(s.messages.id)).limit(1).for('update',{skipLocked:true});
        if(!message) return null;
        const [session]=await tx.select().from(s.sessions).where(eq(s.sessions.id,message.sessionId));
        const [runtime]=await tx.select().from(s.queueRuntime).where(eq(s.queueRuntime.id,'main'));
        const [staff]=await tx.select({id:s.messages.id}).from(s.messages).where(and(eq(s.messages.sessionId,message.sessionId),eq(s.messages.sender,'nurse'))).limit(1);
        const valid=session?.status === 'waiting' && session.assignedNurse === null && !staff && !session.wantsHuman && !session.isEmergency
          && runtime !== undefined && runtime.episode === message.meta?.queueEpisode && runtime.surgeActive === (message.meta?.queuePhase === 'surge');
        await tx.update(s.messages).set({meta:{...message.meta,delivery:valid?'sending':'cancelled'}}).where(eq(s.messages.id,message.id));
        if(!valid) return null;
        return {id:message.id,sessionId:message.sessionId,reply:{phone:String(message.meta!.phone),text:message.body,purpose:message.meta!.purpose as OutboundMessage['purpose']}};
      });
    },
    async finishNotice(id,delivery) {
      await db.transaction(async tx=>{
        const [row]=await tx.select().from(s.messages).where(eq(s.messages.id,id)).for('update');
        if(!row || row.meta?.delivery !== 'sending') return;
        await tx.update(s.messages).set({meta:{...row.meta,delivery,...(delivery === 'sent'?{sentAt:new Date().toISOString()}:{})}}).where(eq(s.messages.id,id));
      });
    },
  };
}
