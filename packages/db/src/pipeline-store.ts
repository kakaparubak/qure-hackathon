import { and, eq, inArray, desc, max, count, ne } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { InboundMessage } from '@qure/core';
import type { TriageOutcome } from '@qure/core/triage/orchestrator';
import { advanceIntake, readIntake, HANDOFF_TEXT, type IntakeModel, type IntakeTurn } from '@qure/core/intake/engine';
import { replyFor } from '@qure/core/reply/templates';
import { playbookFor } from '@qure/core/reply/playbooks';
import { ticketReplyText } from '@qure/core/queue/tickets';
import * as schema from './schema';
import { inboundToRow, outboundToRow, decisionToRow } from './mapping';

export interface StoredReply { id:string; sessionId:string; outcome:TriageOutcome; triageResultId:string|null; }
export interface PipelineStore {
  process(msg:InboundMessage, assess:(msg:InboundMessage)=>Promise<TriageOutcome>):Promise<StoredReply|null>;
  delivered(reply:StoredReply):Promise<void>;
}
class DuplicateInbound extends Error {}

/** Works with postgres-js in production and PGlite in isolated tests. */
export function createPipelineStore<T extends PgQueryResultHKT>(db:PgDatabase<T, typeof schema>, options:{intakeModel?:IntakeModel}={}):PipelineStore {
  return {
    async process(msg,assess) {
      try {
        return await db.transaction(async tx=>{
          // Avoid even a patient upsert for the usual replay case.
          const [duplicate]=await tx.select({id:schema.messages.id}).from(schema.messages).where(eq(schema.messages.waMessageId,msg.providerMessageId));
          if(duplicate) return null;
          // This row-level lock serializes concurrent turns for one patient, across processes.
          const [patient]=await tx.insert(schema.patients).values({waNumber:msg.phone}).onConflictDoUpdate({target:schema.patients.waNumber,set:{updatedAt:new Date()}}).returning();
          const [existing]=await tx.select().from(schema.sessions).where(and(eq(schema.sessions.patientId,patient!.id),inArray(schema.sessions.status,['triaging','waiting','escalated','green_lane']))).for('update');
          const session=existing ?? (await tx.insert(schema.sessions).values({patientId:patient!.id}).returning())[0]!;
          const [inbound]=await tx.insert(schema.messages).values(inboundToRow(session.id,msg)).onConflictDoNothing({target:schema.messages.waMessageId}).returning();
          // Roll back any patient/session creation if a concurrent writer won the unique key.
          if(!inbound) throw new DuplicateInbound();
          const outcome=await assess(msg);
          let intake = session.intake;
          let intakeAudit: Record<string,unknown> | null = null;
          let patientName = patient!.name;
          let profileComplete = patient!.profileComplete;

          // Earlier escalation is sticky across turns/restarts. Do not send routine advice afterwards.
          if(session.status === 'escalated' && outcome.kind !== 'text_only' && outcome.reason === null) {
            outcome.reply=session.wantsHuman && !session.isEmergency
              ? {phone:msg.phone,text:HANDOFF_TEXT,purpose:'reply'}
              : {phone:msg.phone,text:replyFor('escalation'),purpose:'playbook'};
            outcome.kind='escalation';
          }
          let intakeTurn: IntakeTurn | null = null;
          if (outcome.kind !== 'escalation' && outcome.kind !== 'text_only' && session.status === 'triaging') {
            const historyRows = await tx.select().from(schema.messages)
              .where(eq(schema.messages.sessionId,session.id)).orderBy(desc(schema.messages.createdAt),desc(schema.messages.id)).limit(13);
            const history = historyRows.filter(row => row.id !== inbound.id && row.kind === 'text' &&
              (row.direction === 'inbound' || row.meta?.delivery === 'sent'))
              .reverse().map(row=>({role:row.direction === 'inbound' ? 'user' as const : 'assistant' as const,content:row.body}));
            const intakeState = readIntake(session.intake);
            const turn = await advanceIntake({state:intakeState,text:msg.text,history,model:options.intakeModel,
              clarifyComplaint:outcome.kind === 'follow_up' && intakeState.awaiting === null});
            intakeTurn = turn;
            intake = turn.state;
            intakeAudit = {usedFallback:turn.usedFallback,status:turn.state.status,awaiting:turn.state.awaiting,attempts:turn.state.attempts};
            patientName = turn.state.fields.name ?? patientName;
            profileComplete = Boolean(patientName && turn.state.fields.ageYears !== undefined);
            outcome.reply = {phone:msg.phone,text:turn.text,purpose:'reply'};
            if (turn.handoff) {
              outcome.kind = 'escalation'; outcome.reason = 'intake_handoff'; outcome.tier = 'P2';
            }
          }
          if (patientName !== patient!.name || profileComplete !== patient!.profileComplete) {
            await tx.update(schema.patients).set({name:patientName,profileComplete}).where(eq(schema.patients.id,patient!.id));
          }
          if (outcome.kind === 'escalation' && !outcome.medicalEmergency && intake) {
            intake = {...readIntake(intake),status:'handoff'};
          }
          const ranks={P1:1,P2:2,P3:3};
          const priority=session.priority === null ? outcome.tier : outcome.tier === null || ranks[session.priority] <= ranks[outcome.tier] ? session.priority : outcome.tier;
          const escalated=outcome.kind === 'escalation';
          const intakeCompletedThisTurn=intakeTurn?.state.status === 'complete';

          // Queue entry, in the same transaction as the decision. Escalations
          // join the priority lane; a completed routine intake joins normal.
          // The ticket number is stable for the day and never re-issued; an
          // escalation only moves the existing entry's lane.
          let ticket:{ticketNumber:number;ticketDate:string;position:number}|null=null;
          const joinLane=escalated ? 'priority' : intakeCompletedThisTurn ? 'normal' : null;
          if(joinLane) {
            const [existingEntry]=await tx.select().from(schema.queueEntries).where(eq(schema.queueEntries.sessionId,session.id)).for('update');
            if(existingEntry) {
              ticket={ticketNumber:existingEntry.queueNumber,ticketDate:existingEntry.queueDate,position:1};
              if(joinLane === 'priority' && existingEntry.lane !== 'priority') {
                await tx.update(schema.queueEntries).set({lane:'priority',tierAtJoin:priority,nursePagedAt:new Date()}).where(eq(schema.queueEntries.id,existingEntry.id));
              }
            } else {
              // Local calendar day, YYYY-MM-DD (en-CA renders exactly this).
              const queueDate=new Date().toLocaleDateString('en-CA');
              // max+1 under the tx; the (queue_date, queue_number) unique index
              // catches concurrent allocation, and the retry re-reads after the
              // winner commits.
              for(let attempt=0; attempt<5 && !ticket; attempt++) {
                const [maxRow]=await tx.select({maxNumber:max(schema.queueEntries.queueNumber)}).from(schema.queueEntries).where(eq(schema.queueEntries.queueDate,queueDate));
                const maxNumber=maxRow?.maxNumber ?? 0;
                const [entry]=await tx.insert(schema.queueEntries).values({
                  sessionId:session.id,queueDate,queueNumber:(maxNumber ?? 0)+1,lane:joinLane,tierAtJoin:priority,
                  ...(joinLane === 'priority' ? {nursePagedAt:new Date()} : {}),
                }).onConflictDoNothing().returning();
                if(entry) {
                  // Position snapshot for the reply text only; the board always
                  // derives live position, it never stores one.
                  const [aheadRow]=await tx.select({ahead:count()}).from(schema.queueEntries).where(and(
                    eq(schema.queueEntries.queueDate,queueDate),eq(schema.queueEntries.lane,joinLane),
                    inArray(schema.queueEntries.status,['waiting','called']),ne(schema.queueEntries.sessionId,session.id)));
                  ticket={ticketNumber:entry.queueNumber,ticketDate:entry.queueDate,position:(aheadRow?.ahead ?? 0)+1};
                }
              }
              if(!ticket) throw new Error('Could not allocate a queue ticket after 5 attempts');
            }
          }

          await tx.update(schema.sessions).set({
            status:escalated ? 'escalated' : intakeCompletedThisTurn ? 'waiting' : session.status, priority, intake,
            wantsHuman:session.wantsHuman || outcome.reason === 'wants_human' || outcome.reason === 'intake_handoff' || (outcome.decision?.wantsHuman ?? 0) >= 0.5,
            isEmergency:session.isEmergency || outcome.medicalEmergency,
            lastPatientMessageAt:!session.lastPatientMessageAt || msg.receivedAt > session.lastPatientMessageAt ? msg.receivedAt : session.lastPatientMessageAt,
          }).where(eq(schema.sessions.id,session.id));
          let triageResultId:string|null=null;
          if(outcome.decision) {
            const [row]=await tx.insert(schema.triageResults).values(decisionToRow(session.id,outcome.decision,{
              messageId:inbound.id,flowAction:escalated ? 'escalate' : 'follow_up',
              escalated,tier:priority,cutoffUsed:outcome.cutoffUsed,usedFallback:outcome.usedFallback,
            })).returning();
            triageResultId=row!.id;
          }
          // A routine completion carries the ticket in chat. Escalation replies
          // stay exactly the fixed playbook - safety text is never edited.
          if(ticket && !escalated) outcome.reply={...outcome.reply,text:ticketReplyText(ticket)};
          const [outbound]=await tx.insert(schema.messages).values({...outboundToRow(session.id,outcome.reply),meta:{phone:msg.phone,purpose:outcome.reply.purpose,delivery:'pending',inboundMessageId:inbound.id,reason:outcome.reason,...(intakeAudit ? {intake:intakeAudit} : {}),...(ticket ? {ticket:ticket.ticketNumber} : {})}}).returning();
          return {id:outbound!.id,sessionId:session.id,outcome,triageResultId};
        });
      } catch(error) { if(error instanceof DuplicateInbound) return null; throw error; }
    },
    async delivered(reply) {
      await db.transaction(async tx=>{
        const [row]=await tx.select().from(schema.messages).where(eq(schema.messages.id,reply.id)).for('update');
        if(!row) throw new Error('Outbound message not found');
        if(row.meta?.delivery === 'sent') return;
        await tx.update(schema.messages).set({meta:{...row.meta,delivery:'sent',sentAt:new Date().toISOString()}}).where(eq(schema.messages.id,reply.id));
        if(reply.outcome.reply.purpose === 'playbook') {
          await tx.insert(schema.playbookLog).values({sessionId:reply.sessionId,triageResultId:reply.triageResultId,
            playbookKey:playbookFor(reply.outcome.family).id,playbookVersion:'1',messageText:reply.outcome.reply.text,
            redFlagFamily:reply.outcome.family});
        }
      });
    },
  };
}
