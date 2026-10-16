import { beforeAll, afterAll, test, expect } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readdir } from 'node:fs/promises';
import { eq, and } from 'drizzle-orm';
import { createQueueEngine } from './queue-engine';
import { createRepository } from './repository';
import { createPipelineStore } from './pipeline-store';
import * as s from './schema';
import { neutralDecision, FakeDecisionModel } from '@qure/core/decision-model/fake';
import { createOrchestrator } from '@qure/core/triage/orchestrator';
import { FakeChannel } from '@qure/core/channel/fake';
import { decisionToRow } from './mapping';

const pg=new PGlite();
const db=drizzle(pg,{schema:s});
const options={serviceMinutes:5,callbackDelayMinutes:60,callbackSpacingMinutes:10};
const engine=()=>createQueueEngine(db,options);
const repository=createRepository(db);
const decision=neutralDecision();
const core=()=>createOrchestrator({model:new FakeDecisionModel(decision),channel:new FakeChannel(),slots:[{id:decision.model!,cutoff:0.15,urgencyCeiling:4}]});
let seq=0;
beforeAll(async()=>{
  const dir=new URL('../drizzle/',import.meta.url);
  for(const file of (await readdir(dir)).filter(f=>f.endsWith('.sql')).sort()) await pg.exec(await Bun.file(new URL(file,dir)).text());
},30000);
afterAll(async()=>{await pg.close();});
async function fixture(priority:'P1'|'P2'|'P3'='P3',urgency=1) {
  const n=++seq;
  const [patient]=await db.insert(s.patients).values({waNumber:`62811122${n.toString().padStart(4,'0')}`}).returning();
  const [session]=await db.insert(s.sessions).values({patientId:patient!.id,status:priority==='P3'?'waiting':'escalated',priority,isEmergency:priority==='P1'}).returning();
  const [entry]=await db.insert(s.queueEntries).values({sessionId:session!.id,lane:priority==='P3'?'normal':'priority',queueNumber:n}).returning();
  await db.insert(s.triageResults).values(decisionToRow(session!.id,neutralDecision({urgency}),{flowAction:priority==='P3'?'queue':'escalate',tier:priority,escalated:priority!=='P3'}));
  return {patient:patient!,session:session!,entry:entry!};
}
async function notices(sessionId:string) {
  return db.select().from(s.messages).where(eq(s.messages.sessionId,sessionId));
}
async function deliverAll() {
  for(let i=0;i<50;i++) {const notice=await engine().claimNotice();if(!notice) return;await engine().finishNotice(notice.id,'sent');}
}
async function inbound(phone:string,text:string) {
  return createPipelineStore(db,{queue:options}).process({phone,text,providerMessageId:`queue-${++seq}`,receivedAt:new Date(),kind:'text'},core().assess);
}
let emergencies:Array<Awaited<ReturnType<typeof fixture>>> = [];

test('surge begins at three active P1s and broadcasts once per patient across engine restarts',async()=>{
  const routine=await fixture();
  emergencies=[await fixture('P1'),await fixture('P1')];
  expect((await engine().refresh()).surgeActive).toBe(false);
  expect(await notices(routine.session.id)).toHaveLength(0);
  emergencies.push(await fixture('P1'));
  expect(await engine().refresh()).toEqual({surgeActive:true,activeP1Count:3,threshold:3});
  await engine().refresh();await engine().refresh();
  const rows=await notices(routine.session.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.meta?.greenOffer).toBe(true);
  expect(rows[0]?.body).toContain('JALUR HIJAU');
  expect(rows[0]?.body).toContain('15 menit');
  expect(rows[0]?.meta?.delivery).toBe('pending');
  await deliverAll();
  expect((await notices(routine.session.id))[0]?.meta?.delivery).toBe('sent');
});

test('callbacks require a delivered offer and explicit consent, keep ticket identity, and allocate separate slots',async()=>{
  const first=await fixture();
  const noOffer=await inbound(first.patient.waNumber,'JALUR HIJAU');
  expect(noOffer?.outcome.reply.text).toContain('belum tersedia');
  await engine().refresh();
  expect((await inbound(first.patient.waNumber,'JALUR HIJAU'))?.outcome.reply.text).toContain('belum tersedia');
  await deliverAll();
  const accepted=await inbound(first.patient.waNumber,'JALUR HIJAU');
  expect(accepted?.outcome.reply.text).toContain('Jadwal panggilan balik');
  const [entry]=await db.select().from(s.queueEntries).where(eq(s.queueEntries.sessionId,first.session.id));
  expect(entry?.lane).toBe('green');
  expect(entry?.queueNumber).toBe(first.entry.queueNumber);
  expect(entry?.callbackSlot).toBeInstanceOf(Date);
  expect((await db.select().from(s.sessions).where(eq(s.sessions.id,first.session.id)))[0]?.status).toBe('green_lane');
  const second=await fixture();await engine().refresh();await deliverAll();
  await inbound(second.patient.waNumber,'jalur hijau');
  const [next]=await db.select().from(s.queueEntries).where(eq(s.queueEntries.sessionId,second.session.id));
  expect(next!.callbackSlot!.getTime()-entry!.callbackSlot!.getTime()).toBeGreaterThanOrEqual(10*60000);
  // A repeated command confirms the existing slot rather than allocating again.
  await inbound(second.patient.waNumber,'JALUR HIJAU');
  expect((await db.select().from(s.queueEntries).where(eq(s.queueEntries.sessionId,second.session.id)))[0]?.callbackSlot).toEqual(next?.callbackSlot);
});

test('surge does not offer diversion to higher-acuity, human-requested, or staff-handled visits',async()=>{
  const higher=await fixture('P3',2);
  const human=await fixture();
  await db.update(s.sessions).set({wantsHuman:true}).where(eq(s.sessions.id,human.session.id));
  const staff=await fixture();await repository.claimStaffSession(staff.session.id);
  await engine().refresh();
  expect((await notices(higher.session.id))[0]?.meta?.greenOffer).toBe(false);
  expect(await notices(human.session.id)).toHaveLength(0);
  expect(await notices(staff.session.id)).toHaveLength(0);
  await inbound(higher.patient.waNumber,'JALUR HIJAU');
  expect((await db.select().from(s.queueEntries).where(eq(s.queueEntries.sessionId,higher.session.id)))[0]?.lane).toBe('normal');
});

test('green-lane human requests and medical deterioration jump to priority without reissuing tickets',async()=>{
  for(const text of ['petugas','nyeri dada']) {
    const visit=await fixture();await engine().refresh();await deliverAll();
    await inbound(visit.patient.waNumber,'JALUR HIJAU');
    expect((await db.select().from(s.queueEntries).where(eq(s.queueEntries.sessionId,visit.session.id)))[0]?.lane).toBe('green');
    const result=await inbound(visit.patient.waNumber,text);
    expect(result?.outcome.kind).toBe('escalation');
    const [session]=await db.select().from(s.sessions).where(eq(s.sessions.id,visit.session.id));
    const [entry]=await db.select().from(s.queueEntries).where(eq(s.queueEntries.sessionId,visit.session.id));
    expect(session?.status).toBe('escalated');
    expect(entry?.lane).toBe('priority');
    expect(entry?.callbackSlot).toBeNull();
    expect(entry?.queueNumber).toBe(visit.entry.queueNumber);
    expect(session?.priority).toBe(text==='petugas'?'P2':'P1');
  }
});

test('takeover cancels pending automated notices and failed deliveries are not blindly retried',async()=>{
  await deliverAll();
  const visit=await fixture();await engine().refresh();
  await repository.claimStaffSession(visit.session.id);
  // Other visits may have valid ETA updates after the preceding scenario.
  // Drain those while checking this taken-over visit is never dispatched.
  for(let i=0;i<50;i++) {
    const notice=await engine().claimNotice();
    if(!notice) break;
    expect(notice.sessionId).not.toBe(visit.session.id);
    await engine().finishNotice(notice.id,'sent');
  }
  expect((await notices(visit.session.id))[0]?.meta?.delivery).toBe('cancelled');
  const fail=await fixture();await engine().refresh();
  let notice=await engine().claimNotice();
  for(let i=0;notice && notice.sessionId!==fail.session.id && i<50;i++) {await engine().finishNotice(notice.id,'sent');notice=await engine().claimNotice();}
  expect(notice?.sessionId).toBe(fail.session.id);
  await engine().finishNotice(notice!.id,'failed');
  await engine().refresh();
  expect(await engine().claimNotice()).toBeNull();
  expect((await notices(fail.session.id))[0]?.meta?.delivery).toBe('failed');
});

test('changed priority demand sends an ETA reason without repeating the surge broadcast',async()=>{
  const routine=await fixture();await engine().refresh();await deliverAll();
  const original=(await notices(routine.session.id)).find(row=>row.meta?.queuePhase==='surge')!;
  await fixture('P1');
  await engine().refresh();await engine().refresh();
  const rows=await notices(routine.session.id);
  expect(rows.filter(row=>row.meta?.purpose==='surge_broadcast')).toHaveLength(1);
  const updates=rows.filter(row=>row.meta?.purpose==='queue_update');
  expect(updates).toHaveLength(1);
  expect(updates[0]?.meta?.estimatedMinutes).toBe(Number(original.meta?.estimatedMinutes)+5);
  expect(updates[0]?.body).toContain('karena urutan kasus prioritas');
  await deliverAll();
});

test('surge recovery is durable, ignores stale consent, and callback visits can be completed legally',async()=>{
  const pending=await fixture();await engine().refresh();await deliverAll();
  // Finish all active P1s (including the deterioration case from above).
  const rows=await db.select().from(s.sessions).where(and(eq(s.sessions.priority,'P1'),eq(s.sessions.status,'escalated')));
  for(const row of rows) await repository.serveSession(row.id);
  expect((await engine().refresh()).surgeActive).toBe(false);
  await engine().refresh();await deliverAll();
  const sent=await notices(pending.session.id);
  expect(sent.filter(row=>row.meta?.queuePhase==='recovery')).toHaveLength(1);
  await inbound(pending.patient.waNumber,'JALUR HIJAU');
  expect((await db.select().from(s.queueEntries).where(eq(s.queueEntries.sessionId,pending.session.id)))[0]?.lane).toBe('normal');
  const callbacks=await db.select().from(s.sessions).where(eq(s.sessions.status,'green_lane'));
  expect(callbacks.length).toBeGreaterThan(0);
  expect(await repository.serveSession(callbacks[0]!.id)).toBe('served');
  expect((await db.select().from(s.sessions).where(eq(s.sessions.id,callbacks[0]!.id)))[0]?.status).toBe('closed');
});


test('a later surge starts a fresh durable episode',async()=>{
  const routine=await fixture();
  await fixture('P1');await fixture('P1');await fixture('P1');
  await engine().refresh();await engine().refresh();
  const rows=await notices(routine.session.id);
  expect(rows.filter(row=>row.meta?.purpose==='surge_broadcast')).toHaveLength(1);
  expect(rows[0]?.meta?.queueEpisode).toBe(2);
});
