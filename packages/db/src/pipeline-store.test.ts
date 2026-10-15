import { beforeAll, afterAll, test, expect } from 'bun:test';
import { eq } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readdir } from 'node:fs/promises';
import { createOrchestrator } from '@qure/core/triage/orchestrator';
import { FakeDecisionModel,neutralDecision } from '@qure/core/decision-model/fake';
import { FakeChannel } from '@qure/core/channel/fake';
import type { InboundMessage } from '@qure/core';
import { createPipelineStore } from './pipeline-store';
import * as schema from './schema';
const pg=new PGlite();
const db=drizzle(pg,{schema});
const store=()=>createPipelineStore(db);
const model=new FakeDecisionModel(neutralDecision());
const core=()=>createOrchestrator({model,channel:new FakeChannel(),slots:[{id:neutralDecision().model!,cutoff:0.15,urgencyCeiling:4}]});
let seq=0;
const msg=(text='mau ambil obat',phone='628123456789'):InboundMessage=>({phone,text,kind:'text',providerMessageId:`persist-${++seq}`,receivedAt:new Date()});
beforeAll(async()=>{
  const dir=new URL('../drizzle/',import.meta.url);
  for(const file of (await readdir(dir)).filter(f=>f.endsWith('.sql')).sort()) await pg.exec(await Bun.file(new URL(file,dir)).text());
},30000);
afterAll(async()=>{await pg.close();});

test('floor path persists skeleton, transcript, decision, escalation and successful delivery',async()=>{
  const before=model.calls;
  const saved=await store().process(msg('nyeri dada'),core().assess);
  expect(saved).not.toBeNull();
  expect(model.calls).toBe(before);
  expect(saved!.outcome.family).toBe('cardiac');
  const [patient]=await db.select().from(schema.patients);
  expect(patient?.profileComplete).toBe(false);
  const [session]=await db.select().from(schema.sessions);
  expect(session?.status).toBe('escalated');
  expect(session?.priority).toBe('P1');
  expect(await db.select().from(schema.playbookLog)).toHaveLength(0);
  await store().delivered(saved!);
  await store().delivered(saved!);
  expect(await db.select().from(schema.playbookLog)).toHaveLength(1);
  expect((await db.select().from(schema.triageResults))[0]?.layer).toBe('red_flag_floor');
});
test('restart and concurrent duplicates do not retriage or create extra records',async()=>{
  const input=msg('obat habis','628123456780');
  const before=model.calls;
  const results=await Promise.all([store().process(input,core().assess),store().process(input,core().assess)]);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(model.calls-before).toBe(1);
  expect(await store().process(input,core().assess)).toBeNull();
});
test('escalation remains sticky after a later benign message and new handler',async()=>{
  const saved=await store().process(msg('mau ambil obat'),core().assess);
  expect(saved?.sessionId).toBeDefined();
  expect(saved?.outcome.kind).toBe('escalation');
  const sessions=await db.select().from(schema.sessions);
  expect(sessions.find(s=>s.id===saved!.sessionId)?.priority).toBe('P1');
});
test('audio is stored without a triage result',async()=>{
  const before=(await db.select().from(schema.triageResults)).length;
  const saved=await store().process({...msg('','628123456781'),kind:'audio'},core().assess);
  expect(saved?.outcome.kind).toBe('text_only');
  expect((await db.select().from(schema.triageResults)).length).toBe(before);
});
test('assessment failure rolls back inbound claim so the same id can be retried',async()=>{
  const input=msg('obat','628123456782');
  await expect(store().process(input,async()=>{throw new Error('assessment crashed');})).rejects.toThrow('assessment crashed');
  expect(await store().process(input,core().assess)).not.toBeNull();
});

test('distinct turns reuse one active session and closed episodes start a new one',async()=>{
  const phone='628123456783';
  const first=await store().process(msg('obat habis',phone),core().assess);
  const second=await store().process(msg('ambil obat',phone),core().assess);
  expect(first?.sessionId).toBe(second?.sessionId);
  await pg.query("UPDATE sessions SET status='closed' WHERE id=$1",[first!.sessionId]);
  const next=await store().process(msg('kunjungan baru',phone),core().assess);
  expect(next?.sessionId).not.toBe(first?.sessionId);
});
test('model failure is persisted as escalation; no fabricated delivery is recorded',async()=>{
  const failing=createOrchestrator({model:new FakeDecisionModel(neutralDecision(),'throw'),channel:new FakeChannel(),slots:[{id:neutralDecision().model!,cutoff:0.15,urgencyCeiling:4}]});
  const saved=await store().process(msg('obat','628123456784'),failing.assess);
  expect(saved?.outcome.reason).toBe('model_failure');
  const rows=await pg.query<{status:string;delivery:string}>("SELECT s.status,m.meta->>'delivery' AS delivery FROM sessions s JOIN messages m ON m.session_id=s.id WHERE m.id=$1",[saved!.id]);
  expect(rows.rows[0]).toEqual({status:'escalated',delivery:'pending'});
});

test('escalation joins the priority lane with a per-day ticket and nurse page timestamp',async()=>{
  const phone='628123456785';
  const saved=await store().process(msg('nyeri dada sejak pagi',phone),core().assess);
  expect(saved).not.toBeNull();
  const [entry]=await db.select().from(schema.queueEntries);
  expect(entry?.lane).toBe('priority');
  expect(entry?.status).toBe('waiting');
  expect(entry?.queueNumber).toBeGreaterThan(0);
  expect(entry?.nursePagedAt).not.toBeNull();
  expect(entry?.queueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test('a later escalation upgrades the routine entry without re-issuing the ticket',async()=>{
  const phone='628123456786';
  const answers=['Saya Upik','30','batuk','2 hari','tidak ada','tidak ada'];
  for(const text of answers) await store().process(msg(text,phone),core().assess);
  const [routine]=await db.select().from(schema.queueEntries)
    .innerJoin(schema.sessions,eq(schema.sessions.id,schema.queueEntries.sessionId))
    .where(eq(schema.sessions.patientId,(await db.select().from(schema.patients).where(eq(schema.patients.waNumber,phone)))[0]!.id));
  expect(routine!.queue_entries.lane).toBe('normal');
  expect(routine!.queue_entries.nursePagedAt).toBeNull();
  const escalated=await store().process(msg('nyeri dada hebat',phone),core().assess);
  expect(escalated?.outcome.kind).toBe('escalation');
  const [entry]=await db.select().from(schema.queueEntries)
    .innerJoin(schema.sessions,eq(schema.sessions.id,schema.queueEntries.sessionId))
    .where(eq(schema.sessions.patientId,(await db.select().from(schema.patients).where(eq(schema.patients.waNumber,phone)))[0]!.id));
  expect(entry!.queue_entries.lane).toBe('priority');
  expect(entry!.queue_entries.queueNumber).toBe(routine!.queue_entries.queueNumber);
  expect(entry!.queue_entries.nursePagedAt).not.toBeNull();
});

test('repeat escalations never duplicate the queue entry',async()=>{
  const phone='628123456787';
  await store().process(msg('nyeri dada',phone),core().assess);
  await store().process(msg('makin sakit',phone),core().assess);
  const entries=await db.select().from(schema.queueEntries)
    .innerJoin(schema.sessions,eq(schema.sessions.id,schema.queueEntries.sessionId))
    .where(eq(schema.sessions.patientId,(await db.select().from(schema.patients).where(eq(schema.patients.waNumber,phone)))[0]!.id));
  expect(entries).toHaveLength(1);
});
