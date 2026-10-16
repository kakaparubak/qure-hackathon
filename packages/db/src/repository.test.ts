import { beforeAll, afterAll, test, expect } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readdir } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { createRepository } from './repository';
import { createPipelineStore } from './pipeline-store';
import * as schema from './schema';
import { emptyIntake } from '@qure/core/intake/engine';
import { createOrchestrator } from '@qure/core/triage/orchestrator';
import { FakeDecisionModel, neutralDecision } from '@qure/core/decision-model/fake';
import { FakeChannel } from '@qure/core/channel/fake';

const pg=new PGlite();
const db=drizzle(pg,{schema});
const repository=createRepository(db);
beforeAll(async()=>{
  const dir=new URL('../drizzle/',import.meta.url);
  for(const file of (await readdir(dir)).filter(f=>f.endsWith('.sql')).sort()) await pg.exec(await Bun.file(new URL(file,dir)).text());
},30000);
afterAll(async()=>{await pg.close();});

let seq=0;
async function visit(allergies?:string) {
  const [patient]=await db.insert(schema.patients).values({waNumber:`628123459${++seq}`}).returning();
  const intake={...emptyIntake(),fields:allergies ? {allergies} : {}};
  const [session]=await db.insert(schema.sessions).values({patientId:patient!.id,status:'waiting',intake}).returning();
  await db.insert(schema.queueEntries).values({sessionId:session!.id,queueNumber:seq,lane:'normal'});
  return {patient:patient!,session:session!};
}

test('persisted patient-reported allergies reach the queue and detail without becoming confirmed conditions',async()=>{
  const model=new FakeDecisionModel(neutralDecision());
  const core=createOrchestrator({model,channel:new FakeChannel(),slots:[{id:neutralDecision().model!,cutoff:0.15,urgencyCeiling:4}]});
  let sessionId='';
  for(const text of ['Saya Sari','40','batuk','3 hari','kacang','tidak ada']) {
    const result=await createPipelineStore(db).process({phone:'628123450000',text,kind:'text',providerMessageId:`allergy-${++seq}`,receivedAt:new Date()},core.assess);
    sessionId=result!.sessionId;
  }
  expect((await repository.readQueueBoard()).find(row=>row.sessionId===sessionId)?.hasAllergies).toBe(true);
  expect((await repository.sessionDetail(sessionId))?.conditions).toContain('Alergi (dilaporkan pasien): kacang');
  expect(await db.select().from(schema.patientConditions)).toHaveLength(0);
});

test('no-allergy and unknown intake answers do not create positive flags',async()=>{
  for(const value of [undefined,'tidak ada','tidak','tidak ada alergi','nggak ada','tidak tahu','belum tahu']) {
    const {session}=await visit(value);
    expect((await repository.readQueueBoard()).find(row=>row.sessionId===session.id)?.hasAllergies).toBe(false);
    expect((await repository.sessionDetail(session.id))?.conditions).toEqual([]);
  }
});

test('existing active allergy records remain visible even when intake says none',async()=>{
  const {patient,session}=await visit('tidak ada');
  await db.insert(schema.patientConditions).values({patientId:patient.id,kind:'allergy',display:'Penisilin',clinicalStatus:'active'});
  expect((await repository.readQueueBoard()).find(row=>row.sessionId===session.id)?.hasAllergies).toBe(true);
  expect((await repository.sessionDetail(session.id))?.conditions).toContain('Penisilin');
  await db.update(schema.patientConditions).set({clinicalStatus:'resolved'}).where(eq(schema.patientConditions.patientId,patient.id));
  expect((await repository.readQueueBoard()).find(row=>row.sessionId===session.id)?.hasAllergies).toBe(false);
});

test('staff takeover persists replies immediately without models or automated messages, including after restart',async()=>{
  const {session,patient}=await visit();
  expect(await repository.claimStaffSession(session.id)).toBe(patient.waNumber);
  await repository.recordNurseMessage(session.id,'halo kak');
  const input={phone:patient.waNumber,text:'halo',kind:'text' as const,providerMessageId:`staff-${++seq}`,receivedAt:new Date()};
  let assessments=0;
  const assess=async():Promise<never>=>{assessments++;throw new Error('AI must stay paused');};
  expect(await createPipelineStore(db).process(input,assess)).toBeNull();
  expect(await createPipelineStore(db).process(input,assess)).toBeNull();
  expect(assessments).toBe(0);
  expect((await repository.sessionMessages(session.id)).map(message=>({role:message.role,content:message.content}))).toEqual([
    {role:'nurse',content:'halo kak'},{role:'patient',content:'halo'},
  ]);
  expect((await repository.sessionDetail(session.id))?.staffHandling).toBe(true);
  expect((await db.select().from(schema.sessions).where(eq(schema.sessions.id,session.id)))[0]?.status).toBe('waiting');
});

test('staff takeover retains local floor escalation without AI calls or automatic playbook spam',async()=>{
  const {session,patient}=await visit();
  await repository.claimStaffSession(session.id);
  const input={phone:patient.waNumber,text:'nyeri dada',kind:'text' as const,providerMessageId:`staff-floor-${++seq}`,receivedAt:new Date()};
  expect(await createPipelineStore(db).process(input,async()=>{throw new Error('No model allowed');})).toBeNull();
  const [saved]=await db.select().from(schema.sessions).where(eq(schema.sessions.id,session.id));
  expect(saved?.priority).toBe('P1');
  expect(saved?.isEmergency).toBe(true);
  expect(saved?.status).toBe('escalated');
  const [entry]=await db.select().from(schema.queueEntries).where(eq(schema.queueEntries.sessionId,session.id));
  expect(entry?.lane).toBe('priority');
  const [verdict]=await db.select().from(schema.triageResults).where(eq(schema.triageResults.sessionId,session.id));
  expect(verdict?.layer).toBe('red_flag_floor');
  expect((await repository.sessionMessages(session.id)).map(message=>message.role)).toEqual(['patient']);
  // A benign follow-up cannot clear the escalation, and does not repeat advice.
  await createPipelineStore(db).process({...input,text:'halo',providerMessageId:`staff-floor-${++seq}`},async()=>{throw new Error('No model allowed');});
  expect((await db.select().from(schema.sessions).where(eq(schema.sessions.id,session.id)))[0]?.priority).toBe('P1');
  expect(await db.select().from(schema.playbookLog).where(eq(schema.playbookLog.sessionId,session.id))).toHaveLength(0);
});

test('legacy nurse transcripts pause AI and takeover stays isolated to the active visit',async()=>{
  const {session,patient}=await visit();
  await repository.recordNurseMessage(session.id,'Saya petugas.');
  const input={phone:patient.waNumber,text:'halo',kind:'text' as const,providerMessageId:`legacy-${++seq}`,receivedAt:new Date()};
  await createPipelineStore(db).process(input,async()=>{throw new Error('Legacy handoff must pause AI');});
  expect((await repository.sessionDetail(session.id))?.staffHandling).toBe(true);
  await repository.serveSession(session.id);
  expect(await repository.claimStaffSession(session.id)).toBeNull();
  const model=new FakeDecisionModel(neutralDecision());
  const core=createOrchestrator({model,channel:new FakeChannel(),slots:[{id:neutralDecision().model!,cutoff:0.15,urgencyCeiling:4}]});
  const next=await createPipelineStore(db).process({...input,providerMessageId:`new-visit-${++seq}`},core.assess);
  expect(next).not.toBeNull();
  expect(next!.sessionId).not.toBe(session.id);
  expect(model.calls).toBe(1);
});

test('emergency dialogue retains context across restart, preserves priority, and stops at staff takeover',async()=>{
  const model=new FakeDecisionModel(neutralDecision());
  const core=createOrchestrator({model,channel:new FakeChannel(),slots:[{id:neutralDecision().model!,cutoff:0.15,urgencyCeiling:4}]});
  const phone=`628999${++seq}`;
  const message=(text:string)=>({phone,text,kind:'text' as const,providerMessageId:`emergency-dialogue-${++seq}`,receivedAt:new Date()});
  let calls=0;
  const emergencyModel={plan:async(input:import('@qure/core/emergency/engine').EmergencyInput)=>{
    calls++;
    expect(input.families).toEqual(['cardiac']);
    expect(input.history.some(turn=>turn.content.includes('nyeri dada'))).toBe(true);
    return {actionIds:['rest'],questionId:'companion'};
  }};
  const firstStore=createPipelineStore(db,{emergencyModel});
  const first=await firstStore.process(message('nyeri dada'),core.assess);
  expect(first!.outcome.reply.purpose).toBe('playbook');
  expect(calls).toBe(0);
  expect(model.calls).toBe(0);
  await firstStore.delivered(first!);
  // Reconstruct the store to prove context comes from durable session data.
  const store=createPipelineStore(db,{emergencyModel});
  const followup=message('apa yang bisa saya lakukan sekarang?');
  const answer=await store.process(followup,core.assess);
  expect(answer!.outcome.reply.text).toContain('Hentikan aktivitas');
  expect(answer!.outcome.reply.text).toContain('119 sekarang');
  expect(answer!.outcome.medicalEmergency).toBe(true);
  expect(answer!.outcome.kind).toBe('escalation');
  expect(answer!.outcome.reply.purpose).toBe('reply');
  await store.delivered(answer!);
  expect(await store.process(followup,core.assess)).toBeNull();
  expect(calls).toBe(1);
  const [saved]=await db.select().from(schema.sessions).where(eq(schema.sessions.id,first!.sessionId));
  expect(saved?.priority).toBe('P1');
  expect(saved?.isEmergency).toBe(true);
  expect(saved?.status).toBe('escalated');
  const [entry]=await db.select().from(schema.queueEntries).where(eq(schema.queueEntries.sessionId,first!.sessionId));
  expect(entry?.lane).toBe('priority');
  expect(await db.select().from(schema.playbookLog).where(eq(schema.playbookLog.sessionId,first!.sessionId))).toHaveLength(1);
  const [outbound]=await db.select().from(schema.messages).where(eq(schema.messages.id,answer!.id));
  expect(outbound?.meta?.emergencySupport).toMatchObject({families:['cardiac'],actionIds:['rest'],usedFallback:false});
  await repository.claimStaffSession(first!.sessionId);
  expect(await store.process(message('tolong jawab'),core.assess)).toBeNull();
  expect(calls).toBe(1);
});

test('new emergency family and human request bypass dialogue without demoting the existing emergency',async()=>{
  const model=new FakeDecisionModel(neutralDecision());
  const core=createOrchestrator({model,channel:new FakeChannel(),slots:[{id:neutralDecision().model!,cutoff:0.15,urgencyCeiling:4}]});
  let supportCalls=0;
  const store=createPipelineStore(db,{emergencyModel:{plan:async()=>{supportCalls++;throw new Error('must not call');}}});
  const phone=`628999${++seq}`;
  const message=(text:string)=>({phone,text,kind:'text' as const,providerMessageId:`emergency-new-${++seq}`,receivedAt:new Date()});
  const first=await store.process(message('nyeri dada'),core.assess);
  const second=await store.process(message('sesak napas'),core.assess);
  expect(second!.outcome.family).toBe('breathing');
  expect(second!.outcome.reply.purpose).toBe('playbook');
  const handoff=await store.process(message('petugas'),core.assess);
  expect(handoff!.outcome.medicalEmergency).toBe(true);
  expect(handoff!.outcome.reply.text).toContain('119 sekarang');
  expect(supportCalls).toBe(0);
  expect(model.calls).toBe(0);
  const [saved]=await db.select().from(schema.sessions).where(eq(schema.sessions.id,first!.sessionId));
  expect(saved?.priority).toBe('P1');
  expect(saved?.wantsHuman).toBe(true);
  expect(saved?.isEmergency).toBe(true);
});

test('model-only emergency uses common guidance on later text, without restarting intake',async()=>{
  const model=new FakeDecisionModel(neutralDecision({urgency:3.5}));
  const core=createOrchestrator({model,channel:new FakeChannel(),slots:[{id:neutralDecision().model!,cutoff:0.15,urgencyCeiling:4}]});
  const phone=`628999${++seq}`;
  const message=(text:string)=>({phone,text,kind:'text' as const,providerMessageId:`emergency-model-${++seq}`,receivedAt:new Date()});
  const first=await createPipelineStore(db).process(message('keluhan saya makin parah'),core.assess);
  expect(first!.outcome.medicalEmergency).toBe(true);
  const answer=await createPipelineStore(db).process(message('tolong bantu saya'),core.assess);
  expect(answer!.outcome.reply.text).toContain('119 sekarang');
  const [outbound]=await db.select().from(schema.messages).where(eq(schema.messages.id,answer!.id));
  expect(outbound?.meta?.emergencySupport).toMatchObject({families:[],usedFallback:true});
  expect(outbound?.meta?.intake).toBeUndefined();
});
