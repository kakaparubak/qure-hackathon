import { and, eq, inArray, desc, max, count, ne, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { InboundMessage } from '@qure/core';
import type { TriageOutcome } from '@qure/core/triage/orchestrator';
import { advanceIntake, readIntake, HANDOFF_TEXT, type IntakeModel, type IntakeTurn } from '@qure/core/intake/engine';
import { emergencyReply, type EmergencyModel } from '@qure/core/emergency/engine';
import { CHECK_IN_ACK_TEXT, DEFAULT_CHECK_IN_OPTIONS, isStatusOnlyCheckInReply, nextCheckInAt, validateCheckInOptions, type CheckInOptions } from '@qure/core/check-in/policy';
import { replyFor } from '@qure/core/reply/templates';
import { playbookFor, PLAYBOOK_VERSION } from '@qure/core/reply/playbooks';
import { ticketReplyText } from '@qure/core/queue/tickets';
import { scan } from '@qure/core/red-flag/floor';
import { acceptsGreenLane, callbackText, queueStatus } from '@qure/core/queue/surge';
import { DEFAULT_QUEUE_OPTIONS, lowAcuityEvidence, type QueueEngineOptions } from './queue-engine';
import * as schema from './schema';
import { inboundToRow, outboundToRow, decisionToRow } from './mapping';

export interface StoredReply { id:string; sessionId:string; outcome:TriageOutcome; triageResultId:string|null; }
export interface PipelineStore {
  process(msg:InboundMessage, assess:(msg:InboundMessage)=>Promise<TriageOutcome>):Promise<StoredReply|null>;
  delivered(reply:StoredReply):Promise<void>;
}
class DuplicateInbound extends Error {}

/** Works with postgres-js in production and PGlite in isolated tests. */
export function createPipelineStore<T extends PgQueryResultHKT>(db:PgDatabase<T, typeof schema>, options:{intakeModel?:IntakeModel;emergencyModel?:EmergencyModel;queue?:QueueEngineOptions;checkIn?:CheckInOptions}={}):PipelineStore {
  const checkInOptions=validateCheckInOptions(options.checkIn ?? DEFAULT_CHECK_IN_OPTIONS);
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
          // A new patient turn supersedes unsent reminders/handoff notices.
          await tx.update(schema.messages).set({meta:sql`${schema.messages.meta} || '{"delivery":"cancelled"}'::jsonb`}).where(and(
            eq(schema.messages.sessionId,session.id),sql`${schema.messages.meta}->>'checkInKey' is not null`,sql`${schema.messages.meta}->>'delivery' = 'pending'`));
          // Staff owns the conversation after takeover. Commit patient replies
          // immediately: no model/LLM calls, no repeated automated playbooks.
          // Older sessions can already contain nurse messages without an assignment.
          const [staffMessage]=session.assignedNurse === null
            ? await tx.select({id:schema.messages.id}).from(schema.messages).where(and(
              eq(schema.messages.sessionId,session.id),eq(schema.messages.sender,'nurse'))).limit(1)
            : [];
          if(session.assignedNurse !== null || staffMessage) {
            const floor=msg.kind === 'text' ? scan(msg.text) : null;
            const ranks={P1:1,P2:2,P3:3};
            const priority=floor?.hit && (session.priority === null || ranks[floor.tier] < ranks[session.priority]) ? floor.tier : session.priority;
            await tx.update(schema.sessions).set({
              assignedNurse:session.assignedNurse ?? 'staff',nextCheckIn:null,
              ...(floor?.hit ? {status:'escalated' as const,priority,isEmergency:true} : {}),
              lastPatientMessageAt:!session.lastPatientMessageAt || msg.receivedAt > session.lastPatientMessageAt ? msg.receivedAt : session.lastPatientMessageAt,
            }).where(eq(schema.sessions.id,session.id));
            if(floor?.hit) {
              await tx.update(schema.queueEntries).set({lane:'priority',nursePagedAt:new Date(),callbackSlot:null}).where(eq(schema.queueEntries.sessionId,session.id));
              await tx.insert(schema.triageResults).values({sessionId:session.id,messageId:inbound.id,
                layer:'red_flag_floor',redFlagFired:true,redFlagFamily:floor.family,matchedPattern:floor.label,
                tier:priority,escalated:true,flowAction:'escalate',rawOutput:{red_flag_floor:floor.label,staffHandling:true}});
            }
            return null;
          }
          // Exact queue-control commands carry no symptom text. Like the
          // explicit human command, handle them deterministically after L1;
          // a model must not misread callback consent as a fresh complaint.
          const queueCommand=msg.kind === 'text' && acceptsGreenLane(msg.text)
            && (session.status === 'waiting' || session.status === 'green_lane') && !scan(msg.text).hit;
          const outcome:TriageOutcome=queueCommand ? {
            decision:null,medicalEmergency:false,reason:null,kind:'intake',tier:null,
            cutoffUsed:null,usedFallback:false,family:null,
            reply:{phone:msg.phone,text:'Pilihan antrean sedang diperiksa.',purpose:'queue_update'},
          } : await assess(msg);
          let intake = session.intake;
          let intakeAudit: Record<string,unknown> | null = null;
          let emergencyAudit: Record<string,unknown> | null = null;
          let patientName = patient!.name;
          let profileComplete = patient!.profileComplete;

          // Earlier escalation is sticky across turns/restarts. Do not send routine advice afterwards.
          if(session.status === 'escalated' && outcome.kind !== 'text_only' && outcome.reason === null) {
            outcome.reply=session.wantsHuman && !session.isEmergency
              ? {phone:msg.phone,text:HANDOFF_TEXT,purpose:'reply'}
              : {phone:msg.phone,text:replyFor('escalation'),purpose:'playbook'};
            outcome.kind='escalation';
          }
          // Emergency state survives restarts and benign follow-ups. Dialogue
          // cannot change triage or take over from a staff member (handled above).
          if(session.isEmergency && msg.kind === 'text') {
            const prior=await tx.select({family:schema.triageResults.redFlagFamily}).from(schema.triageResults)
              .where(eq(schema.triageResults.sessionId,session.id));
            const families=[...new Set(prior.flatMap(row=>row.family ? [row.family] : []))];
            const newFamily=outcome.family !== null && !families.includes(outcome.family);
            const explicitHandoff=outcome.reason === 'wants_human' || outcome.reason === 'intake_handoff';
            if(newFamily || explicitHandoff) {
              outcome.family=outcome.family ?? (families.length === 1 ? families[0]! : null);
              outcome.reply={phone:msg.phone,text:replyFor('escalation',{family:outcome.family}),purpose:'playbook'};
            } else {
              const rows=await tx.select().from(schema.messages).where(eq(schema.messages.sessionId,session.id))
                .orderBy(desc(schema.messages.createdAt),desc(schema.messages.id)).limit(13);
              const history=rows.filter(row=>row.id !== inbound.id && row.kind === 'text' &&
                (row.direction === 'inbound' || row.meta?.delivery === 'sent')).reverse()
                .map(row=>({role:row.direction === 'inbound' ? 'user' as const : 'assistant' as const,content:row.body}));
              const support=await emergencyReply({text:msg.text,families,history},options.emergencyModel);
              outcome.reply={phone:msg.phone,text:support.text,purpose:'reply'};
              emergencyAudit=support.audit;
            }
            outcome.kind='escalation';
            outcome.medicalEmergency=true;
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
            intakeAudit = {usedFallback:turn.usedFallback,replyFallbackReason:turn.replyFallbackReason,replyProviderFailures:turn.replyProviderFailures,extractionRecovery:turn.extractionRecovery,status:turn.state.status,awaiting:turn.state.awaiting,attempts:turn.state.attempts};
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
          const priority=(session.priority === null ? outcome.tier : outcome.tier === null || ranks[session.priority] <= ranks[outcome.tier] ? session.priority : outcome.tier)
            ?? (intakeTurn?.state.status === 'complete' ? 'P3' : null);
          const escalated=outcome.kind === 'escalation';
          const intakeCompletedThisTurn=intakeTurn?.state.status === 'complete';
          let greenAccepted=false;
          // Consent is processed AFTER triage: commands cannot mask emergencies,
          // human requests, or an existing escalation.
          if(!escalated && msg.kind === 'text' && acceptsGreenLane(msg.text) && session.status === 'waiting'
            && !session.wantsHuman && !session.isEmergency && (session.priority === null || session.priority === 'P3')) {
            const [offer]=await tx.select().from(schema.messages).where(and(
              eq(schema.messages.sessionId,session.id),sql`${schema.messages.meta}->>'greenOffer' = 'true'`,
              sql`${schema.messages.meta}->>'delivery' = 'sent'`,
            )).orderBy(desc(schema.messages.createdAt)).limit(1);
            if(offer) {
              const [runtime]=await tx.select().from(schema.queueRuntime).where(eq(schema.queueRuntime.id,'main')).for('update');
              const active=await tx.select({tier:schema.sessions.priority}).from(schema.queueEntries)
                .innerJoin(schema.sessions,eq(schema.sessions.id,schema.queueEntries.sessionId))
                .where(and(inArray(schema.queueEntries.status,['waiting','called']),inArray(schema.sessions.status,['waiting','escalated','green_lane'])));
              const [eligible]=await tx.select({lowAcuity:lowAcuityEvidence()}).from(schema.sessions).where(eq(schema.sessions.id,session.id));
              const [entry]=await tx.select().from(schema.queueEntries).where(eq(schema.queueEntries.sessionId,session.id)).for('update');
              if(runtime?.surgeActive && runtime.episode === offer.meta?.queueEpisode && queueStatus(active.map(row=>row.tier)).surgeActive
                && eligible?.lowAcuity && entry?.lane === 'normal' && entry.status === 'waiting') {
                const settings=options.queue ?? DEFAULT_QUEUE_OPTIONS;
                const [latest]=await tx.select({slot:max(schema.queueEntries.callbackSlot)}).from(schema.queueEntries)
                  .where(and(eq(schema.queueEntries.lane,'green'),inArray(schema.queueEntries.status,['waiting','called'])));
                const slot=new Date(Math.max(Date.now()+settings.callbackDelayMinutes*60000,
                  latest?.slot ? new Date(latest.slot).getTime()+settings.callbackSpacingMinutes*60000 : 0));
                await tx.update(schema.queueEntries).set({lane:'green',callbackSlot:slot,etaReason:'Panggilan balik dipilih pasien'}).where(eq(schema.queueEntries.id,entry.id));
                outcome.reply={phone:msg.phone,text:callbackText(slot),purpose:'queue_update'};
                greenAccepted=true;
              }
            }
            if(!greenAccepted) outcome.reply={phone:msg.phone,text:'Pilihan jalur panggilan balik belum tersedia untuk sesi ini. Anda tetap dalam antrean. Ketik "petugas" untuk bantuan.',purpose:'queue_update'};
          } else if(!escalated && session.status === 'green_lane' && outcome.kind !== 'text_only') {
            const [entry]=await tx.select().from(schema.queueEntries).where(eq(schema.queueEntries.sessionId,session.id));
            if(entry?.callbackSlot) outcome.reply={phone:msg.phone,text:callbackText(entry.callbackSlot),purpose:'queue_update'};
          }
          // A check-in answer such as “saya aman saja” is only a status update,
          // not a new complaint and never evidence that the patient is safe.
          // Triage has already run above, so any escalation still takes priority.
          if(!escalated && session.status === 'waiting' && msg.kind === 'text' && isStatusOnlyCheckInReply(msg.text)) {
            outcome.reply={phone:msg.phone,text:CHECK_IN_ACK_TEXT,purpose:'reply'};
          }

          // Queue entry, in the same transaction as the decision. Escalations
          // join the priority lane; a completed routine intake joins normal.
          // The ticket number is stable for the day and never re-issued; an
          // escalation only moves the existing entry's lane.
          let ticket:{ticketNumber:number;ticketDate:string;position:number}|null=null;
          const joinLane=escalated ? 'priority' : intakeCompletedThisTurn ? 'normal' : null;
          if(joinLane) {
            const [existingEntry]=await tx.select().from(schema.queueEntries).where(eq(schema.queueEntries.sessionId,session.id)).for('update');
            if(existingEntry) {
              const [ahead]=await tx.select({count:count()}).from(schema.queueEntries).where(and(
                eq(schema.queueEntries.lane,joinLane),inArray(schema.queueEntries.status,['waiting','called']),
                sql`(${schema.queueEntries.joinedAt}, ${schema.queueEntries.sessionId}) < (${existingEntry.joinedAt}, ${session.id}::uuid)`,
              ));
              ticket={ticketNumber:existingEntry.queueNumber,ticketDate:existingEntry.queueDate,position:(ahead?.count ?? 0)+1};
              if(joinLane === 'priority' && existingEntry.lane !== 'priority') {
                await tx.update(schema.queueEntries).set({lane:'priority',tierAtJoin:priority,nursePagedAt:new Date(),callbackSlot:null}).where(eq(schema.queueEntries.id,existingEntry.id));
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
            status:escalated ? 'escalated' : greenAccepted ? 'green_lane' : intakeCompletedThisTurn ? 'waiting' : session.status, priority, intake,
            nextCheckIn:!escalated && !greenAccepted && !session.isEmergency && !session.wantsHuman &&
              (intakeCompletedThisTurn || session.status === 'waiting') ? nextCheckInAt(new Date(),checkInOptions) : null,
            wantsHuman:session.wantsHuman || outcome.reason === 'wants_human' || outcome.reason === 'intake_handoff' || (outcome.decision?.wantsHuman ?? 0) >= 0.5,
            isEmergency:session.isEmergency || outcome.medicalEmergency,
            lastPatientMessageAt:!session.lastPatientMessageAt || msg.receivedAt > session.lastPatientMessageAt ? msg.receivedAt : session.lastPatientMessageAt,
          }).where(eq(schema.sessions.id,session.id));
          let triageResultId:string|null=null;
          if(outcome.decision) {
            const [row]=await tx.insert(schema.triageResults).values(decisionToRow(session.id,outcome.decision,{
              messageId:inbound.id,flowAction:escalated ? 'escalate' : greenAccepted ? 'green_lane' : intakeCompletedThisTurn ? 'queue' : 'follow_up',
              escalated,tier:priority,cutoffUsed:outcome.cutoffUsed,usedFallback:outcome.usedFallback,
            })).returning();
            triageResultId=row!.id;
          }
          // A routine completion carries the ticket in chat. Escalation replies
          // retain emergency guidance; conversational support uses a bounded catalog.
          if(ticket && !escalated) {
            const [priorityAhead]=await tx.select({count:count()}).from(schema.queueEntries)
              .where(and(eq(schema.queueEntries.lane,'priority'),inArray(schema.queueEntries.status,['waiting','called'])));
            const service=options.queue?.serviceMinutes;
            const eta=service === undefined ? null : Math.ceil(((priorityAhead?.count ?? 0)+ticket.position-1)*service);
            outcome.reply={...outcome.reply,text:ticketReplyText(ticket,eta)};
          }
          const [outbound]=await tx.insert(schema.messages).values({...outboundToRow(session.id,outcome.reply),meta:{phone:msg.phone,purpose:outcome.reply.purpose,delivery:'pending',inboundMessageId:inbound.id,reason:outcome.reason,...(intakeAudit ? {intake:intakeAudit} : {}),...(emergencyAudit ? {emergencySupport:emergencyAudit} : {}),...(ticket ? {ticket:ticket.ticketNumber} : {})}}).returning();
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
            playbookKey:playbookFor(reply.outcome.family).id,playbookVersion:PLAYBOOK_VERSION,messageText:reply.outcome.reply.text,
            redFlagFamily:reply.outcome.family});
        }
      });
    },
  };
}
