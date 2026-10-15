import { beforeAll, afterAll, test, expect } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readdir } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { createPipelineStore } from './pipeline-store';
import * as schema from './schema';
import { readIntake, type IntakeModel, type IntakeExtraction } from '@qure/core/intake/engine';
import { createOrchestrator } from '@qure/core/triage/orchestrator';
import { FakeDecisionModel,neutralDecision } from '@qure/core/decision-model/fake';
import { FakeChannel } from '@qure/core/channel/fake';

const pg=new PGlite();
const db=drizzle(pg,{schema});
const decisionModel=new FakeDecisionModel(neutralDecision());
let llmCalls=0;
const llm:IntakeModel={extract:async input=>{
  llmCalls++;
  const updates:IntakeExtraction['updates']={};
  if(input.text.startsWith('Saya ')) updates.name={value:input.text.slice(5),evidence:input.text};
  else if(input.state.awaiting === 'ageYears' && /^\d+$/.test(input.text)) updates.ageYears={value:Number(input.text),evidence:input.text};
  else if(input.state.awaiting && input.state.awaiting !== 'ageYears' && input.text !== '???') updates[input.state.awaiting]={value:input.text,evidence:input.text};
  return {updates,nextField:null};
}};
const core=()=>createOrchestrator({model:decisionModel,channel:new FakeChannel(),slots:[{id:neutralDecision().model!,cutoff:0.15,urgencyCeiling:4}]});
let id=0;
async function send(phone:string,text:string,model=llm) {
  // A fresh store and orchestrator each time emulate process-local state being lost.
  return createPipelineStore(db,{intakeModel:model}).process({phone,text,kind:'text',providerMessageId:`intake-${++id}`,receivedAt:new Date()},core().assess);
}
async function session(sessionId:string) {return (await db.select().from(schema.sessions).where(eq(schema.sessions.id,sessionId)))[0]!;}
beforeAll(async()=>{
  const dir=new URL('../drizzle/',import.meta.url);
  for(const file of (await readdir(dir)).filter(f=>f.endsWith('.sql')).sort()) await pg.exec(await Bun.file(new URL(file,dir)).text());
},30000);
afterAll(async()=>{await pg.close();});

test('two interleaved users resume intake independently; one escalates while the other completes',async()=>{
  const a='628123456790',b='628123456791';
  const firstA=(await send(a,'Saya Budi'))!;
  const firstB=(await send(b,'Saya Sari'))!;
  await send(a,'62'); await send(b,'40');
  const before=llmCalls,decisions=decisionModel.calls;
  const emergency=(await send(a,'nyeri dada'))!;
  expect(emergency.outcome.family).toBe('cardiac');
  expect(llmCalls).toBe(before);expect(decisionModel.calls).toBe(decisions);
  await send(b,'batuk');await send(b,'3 hari');await send(b,'tidak ada');
  const completed=(await send(b,'tidak ada'))!;
  const stateA=readIntake((await session(firstA.sessionId)).intake);
  const stateB=readIntake((await session(firstB.sessionId)).intake);
  expect(stateA.fields).toEqual({name:'Budi',ageYears:62});
  expect(stateB.fields.name).toBe('Sari');expect(stateB.fields.ageYears).toBe(40);
  expect(stateB.status).toBe('complete');
  expect(completed.outcome.reply.text).toContain('Nomor antrean Anda: 2');
  expect((await session(firstA.sessionId)).status).toBe('escalated');
  expect((await session(firstB.sessionId)).status).toBe('waiting');
  const [entryB]=await db.select().from(schema.queueEntries).where(eq(schema.queueEntries.sessionId,firstB.sessionId));
  // Ticket numbers are shared across lanes per day: the escalation took 1.
  expect(entryB?.queueNumber).toBe(2);
  expect(entryB?.lane).toBe('normal');
  expect(entryB?.status).toBe('waiting');
  const patient=(await db.select().from(schema.patients).where(eq(schema.patients.waNumber,b)))[0]!;
  expect(patient.name).toBe('Sari');expect(patient.profileComplete).toBe(true);
});
test('explicit human command immediately interrupts without intake LLM or emergency flag',async()=>{
  const phone='628123456792';
  await send(phone,'Saya Andi');
  const before=llmCalls,decisions=decisionModel.calls;
  const result=(await send(phone,'petugas'))!;
  const saved=await session(result.sessionId);
  expect(saved.status).toBe('escalated');expect(saved.wantsHuman).toBe(true);expect(saved.isEmergency).toBe(false);
  expect(llmCalls).toBe(before);expect(decisionModel.calls).toBe(decisions);
  expect(result.outcome.reply.purpose).toBe('reply');
});
test('three unresolved answers survive restarts and trigger non-medical handoff',async()=>{
  const phone='628123456793';
  await send(phone,'???');
  await send(phone,'???');await send(phone,'???');
  const result=(await send(phone,'???'))!;
  const saved=await session(result.sessionId);
  expect(readIntake(saved.intake).attempts).toBe(3);
  expect(readIntake(saved.intake).status).toBe('handoff');
  expect(saved.status).toBe('escalated');expect(saved.isEmergency).toBe(false);
  expect(result.outcome.reason).toBe('intake_handoff');
});
test('provider outage advances scripted direct-answer intake rather than a DB failure',async()=>{
  const model:IntakeModel={extract:async()=>{throw Error('provider timeout');}};
  const phone='628123456794';
  await send(phone,'halo',model);
  await send(phone,'Dewi',model);
  const result=(await send(phone,'35 tahun',model))!;
  const saved=await session(result.sessionId);
  expect(readIntake(saved.intake).fields).toEqual({name:'Dewi',ageYears:35});
  expect(saved.status).toBe('triaging');
});
