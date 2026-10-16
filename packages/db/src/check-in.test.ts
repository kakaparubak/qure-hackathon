import { beforeAll, beforeEach, afterAll, test, expect } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq, ne, and, sql } from 'drizzle-orm';
import { readdir } from 'node:fs/promises';
import { createCheckInEngine } from './check-in';
import { createPipelineStore } from './pipeline-store';
import { createRepository } from './repository';
import { createOrchestrator } from '@qure/core/triage/orchestrator';
import { FakeDecisionModel, neutralDecision } from '@qure/core/decision-model/fake';
import { FakeChannel } from '@qure/core/channel/fake';
import { CHECK_IN_WINDOW_MS } from '@qure/core/check-in/policy';
import * as s from './schema';
const pg=new PGlite();const db=drizzle(pg,{schema:s});
const repository=createRepository(db);
const engine=()=>createCheckInEngine(db);
let seq=0;
const base=new Date();
const at=(minutes:number)=>new Date(base.getTime()+minutes*60_000);
beforeAll(async()=>{
  const dir=new URL('../drizzle/',import.meta.url);
  for(const file of (await readdir(dir)).filter(f=>f.endsWith('.sql')).sort()) await pg.exec(await Bun.file(new URL(file,dir)).text());
},30_000);
beforeEach(async()=>{
  await db.update(s.sessions).set({status:'closed',nextCheckIn:null}).where(ne(s.sessions.status,'closed'));
  await db.update(s.messages).set({meta:sql`${s.messages.meta} || '{"delivery":"cancelled"}'::jsonb`}).where(sql`${s.messages.meta}->>'delivery' = 'pending'`);
});
afterAll(async()=>{await pg.close();});
async function fixture(overrides:Partial<typeof s.sessions.$inferInsert>={}) {
  const n=++seq;
  const [patient]=await db.insert(s.patients).values({waNumber:`628733${n}`}).returning();
  const [session]=await db.insert(s.sessions).values({patientId:patient!.id,status:'waiting',priority:'P3',lastPatientMessageAt:base,...overrides}).returning();
  await db.insert(s.queueEntries).values({sessionId:session!.id,lane:'normal',queueNumber:n,joinedAt:base});
  return {patient:patient!,session:session!};
}
const visit=(id:string)=>db.select().from(s.sessions).where(eq(s.sessions.id,id)).then(rows=>rows[0]!);
const notices=(id:string)=>db.select().from(s.messages).where(and(eq(s.messages.sessionId,id),sql`${s.messages.meta}->>'checkInKey' is not null`));
async function remind(minutes:number) {
  await engine().refresh(at(minutes));
  const notice=await engine().claimNotice(at(minutes));
  expect(notice).not.toBeNull();
  await engine().finishNotice(notice!.id,'sent',at(minutes));
  return notice!;
}
function core() {
  const model=new FakeDecisionModel(neutralDecision());
  return {model,assess:createOrchestrator({model,channel:new FakeChannel(),slots:[{id:neutralDecision().model!,cutoff:.15,urgencyCeiling:4}]}).assess};
}
const inbound=(phone:string,text:string)=>({phone,text,kind:'text' as const,providerMessageId:`check-in-${++seq}`,receivedAt:new Date()});

test('normal queue waits 45 minutes; scheduling and duplicate claims survive restarts',async()=>{
  const {session}=await fixture();
  await engine().refresh(base);
  expect((await visit(session.id)).nextCheckIn).toEqual(at(45));
  await engine().refresh(at(44));
  expect(await notices(session.id)).toHaveLength(0);
  await Promise.all([engine().refresh(at(45)),engine().refresh(at(45))]);
  expect(await notices(session.id)).toHaveLength(1);
  expect((await visit(session.id)).checkInCount).toBe(1);
  const claimed=await Promise.all([engine().claimNotice(at(45)),engine().claimNotice(at(45))]);
  expect(claimed.filter(Boolean)).toHaveLength(1);
  await engine().finishNotice(claimed.find(Boolean)!.id,'sent',at(46));
  expect((await visit(session.id)).nextCheckIn).toEqual(at(91));
  await engine().refresh(at(90));
  expect(await notices(session.id)).toHaveLength(1);
});

test('three reminders then one non-medical P2 handoff with unchanged ticket',async()=>{
  const {session}=await fixture();
  for(const minutes of [45,90,135]) await remind(minutes);
  expect((await visit(session.id)).checkInCount).toBe(3);
  await engine().refresh(at(180));await engine().refresh(at(180));
  const saved=await visit(session.id);
  expect(saved.status).toBe('escalated');expect(saved.wantsHuman).toBe(true);
  expect(saved.priority).toBe('P2');expect(saved.isEmergency).toBe(false);expect(saved.nextCheckIn).toBeNull();
  const [entry]=await db.select().from(s.queueEntries).where(eq(s.queueEntries.sessionId,session.id));
  expect(entry?.lane).toBe('priority');expect(entry?.queueNumber).toBe(seq);
  const final=await engine().claimNotice(at(180));
  expect(final?.reply.text).toContain('antrean petugas');
  await engine().finishNotice(final!.id,'sent',at(180));
  await engine().refresh(at(225));
  expect(await engine().claimNotice(at(225))).toBeNull();
  expect(await notices(session.id)).toHaveLength(4);
  expect(await db.select().from(s.triageResults).where(eq(s.triageResults.sessionId,session.id))).toHaveLength(0);
});

test('patient reply cancels a pending reminder, re-triages and postpones the next check-in without resetting the bound',async()=>{
  const {session,patient}=await fixture();await engine().refresh(at(45));
  const triage=core();
  await createPipelineStore(db).process(inbound(patient.waNumber,'masih batuk'),triage.assess);
  expect(triage.model.calls).toBe(1);
  expect((await notices(session.id))[0]?.meta?.delivery).toBe('cancelled');
  const saved=await visit(session.id);
  expect(saved.checkInCount).toBe(1);
  expect(saved.nextCheckIn!.getTime()).toBeGreaterThan(Date.now()+44*60_000);
  expect(await engine().claimNotice(new Date())).toBeNull();
});

test('a check-in reply containing a floor emergency immediately upgrades P1 and stops reminders',async()=>{
  const {session,patient}=await fixture();await remind(45);
  const triage=core();
  const answer=await createPipelineStore(db).process(inbound(patient.waNumber,'sekarang nyeri dada'),triage.assess);
  expect(answer?.outcome.medicalEmergency).toBe(true);expect(triage.model.calls).toBe(0);
  expect((await visit(session.id)).priority).toBe('P1');
  expect((await visit(session.id)).nextCheckIn).toBeNull();
  await engine().refresh(at(90));expect(await engine().claimNotice(at(90))).toBeNull();
});

test('explicit human request cancels reminders and never calls a model',async()=>{
  const {session,patient}=await fixture();await engine().refresh(at(45));
  const triage=core();
  const answer=await createPipelineStore(db).process(inbound(patient.waNumber,'petugas'),triage.assess);
  expect(triage.model.calls).toBe(0);
  expect(answer?.outcome.reason).toBe('wants_human');
  expect((await visit(session.id)).nextCheckIn).toBeNull();
  expect(await engine().claimNotice(at(46))).toBeNull();
});

test('staff takeover and serve cancel queued reminders immediately',async()=>{
  for(const action of ['staff','serve']) {
    const {session}=await fixture();await engine().refresh(at(45));
    if(action === 'staff') await repository.claimStaffSession(session.id);else await repository.serveSession(session.id);
    expect((await visit(session.id)).nextCheckIn).toBeNull();
    expect((await notices(session.id))[0]?.meta?.delivery).toBe('cancelled');
    expect(await engine().claimNotice(at(46))).toBeNull();
  }
});

test('legacy staff messages, emergencies, callback and called queue entries are not eligible',async()=>{
  for(const override of [{status:'escalated',priority:'P1',isEmergency:true},{status:'green_lane'},{assignedNurse:'staff'},{wantsHuman:true} ] as Array<Partial<typeof s.sessions.$inferInsert>>) {
    const {session}=await fixture(override);await engine().refresh(at(45));
    expect(await notices(session.id)).toHaveLength(0);
  }
  const legacy=await fixture();await repository.recordNurseMessage(legacy.session.id,'halo');
  const called=await fixture();await db.update(s.queueEntries).set({status:'called'}).where(eq(s.queueEntries.sessionId,called.session.id));
  await engine().refresh(at(45));
  expect(await notices(legacy.session.id)).toHaveLength(0);expect(await notices(called.session.id)).toHaveLength(0);
});

test('failed and uncertain delivery never resend the same reminder; flag human review',async()=>{
  const {session}=await fixture();await engine().refresh(at(45));
  const notice=await engine().claimNotice(at(45));
  await engine().finishNotice(notice!.id,'failed',at(45));
  expect((await visit(session.id)).wantsHuman).toBe(true);
  expect((await notices(session.id)).find(row=>row.id===notice!.id)?.meta?.delivery).toBe('failed');
  const handoff=await engine().claimNotice(at(45));expect(handoff?.reply.text).toContain('antrean petugas');
  await engine().finishNotice(handoff!.id,'failed',at(45));
  expect(await engine().claimNotice(at(90))).toBeNull();
  const uncertain=await fixture();await engine().refresh(at(45));
  const sending=await engine().claimNotice(at(45));
  await engine().refresh(at(90));
  expect((await visit(uncertain.session.id)).wantsHuman).toBe(true);
  expect((await notices(uncertain.session.id)).find(row=>row.id===sending!.id)?.meta?.delivery).toBe('sending');
  const review=await engine().claimNotice(at(90));expect(review?.id).not.toBe(sending!.id);
});

test('expired contact window routes internally to human review without sending outside the window',async()=>{
  const {session}=await fixture();
  const expired=new Date(base.getTime()+CHECK_IN_WINDOW_MS);
  await engine().refresh(expired);
  expect((await visit(session.id)).wantsHuman).toBe(true);
  expect((await visit(session.id)).isEmergency).toBe(false);
  expect(await engine().claimNotice(expired)).toBeNull();
  const [event]=await db.select().from(s.messages).where(eq(s.messages.sessionId,session.id));
  expect(event?.sender).toBe('system');expect(event?.meta?.reason).toBe('contact_window_expired');
});

test('claim revalidates staff ownership and service window even if changed after scheduling',async()=>{
  const {session}=await fixture();await engine().refresh(at(45));
  await db.update(s.sessions).set({assignedNurse:'staff'}).where(eq(s.sessions.id,session.id));
  expect(await engine().claimNotice(at(45))).toBeNull();
  expect((await notices(session.id))[0]?.meta?.delivery).toBe('cancelled');
  const stale=await fixture();await engine().refresh(at(45));
  expect(await engine().claimNotice(new Date(base.getTime()+CHECK_IN_WINDOW_MS))).toBeNull();
  expect((await notices(stale.session.id))[0]?.meta?.delivery).toBe('cancelled');
});


test('repository closure and green-lane transitions cancel pending follow-ups',async()=>{
  for(const status of ['closed','green_lane'] as const) {
    const {session}=await fixture();await engine().refresh(at(45));
    await repository.updateSession(session.id,{status});
    expect((await visit(session.id)).nextCheckIn).toBeNull();
    expect((await notices(session.id))[0]?.meta?.delivery).toBe('cancelled');
    expect(await engine().claimNotice(at(46))).toBeNull();
  }
});

test('after a reply, the same reminder is not retried and the next attempt retains its visit-wide count',async()=>{
  const {session,patient}=await fixture();const first=await remind(45);
  const triage=core();
  await createPipelineStore(db).process(inbound(patient.waNumber,'keluhan belum berubah'),triage.assess);
  const due=(await visit(session.id)).nextCheckIn!;
  await engine().refresh(due);
  expect((await visit(session.id)).checkInCount).toBe(2);
  const next=await engine().claimNotice(due);
  expect(next?.id).not.toBe(first.id);
  const [row]=await db.select().from(s.messages).where(eq(s.messages.id,next!.id));
  expect(row?.meta?.attempt).toBe(2);
});
