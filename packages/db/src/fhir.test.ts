import { beforeAll, afterAll, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readdir } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { createSessionFhirReader } from './fhir';
import { createRepository } from './repository';
import * as s from './schema';
const pg=new PGlite();const db=drizzle(pg,{schema:s});const read=createSessionFhirReader(db);const repository=createRepository(db);
const exportedAt=new Date('2026-10-16T09:00:00.000Z');let seq=0;
beforeAll(async()=>{
  const dir=new URL('../drizzle/',import.meta.url);
  for(const file of (await readdir(dir)).filter(f=>f.endsWith('.sql')).sort()) await pg.exec(await Bun.file(new URL(file,dir)).text());
},30_000);
afterAll(async()=>{await pg.close();});
async function fixture() {
  const [patient]=await db.insert(s.patients).values({waNumber:`62800000000${++seq}`,name:'Pasien Sintetis'}).returning();
  const [session]=await db.insert(s.sessions).values({patientId:patient!.id,status:'waiting',priority:'P3',startedAt:new Date('2026-10-15T08:00:00Z'),intake:{version:1,fields:{name:'Pasien Sintetis',ageYears:25,complaint:'batuk',allergies:'kacang'},awaiting:'duration',attempts:0,status:'collecting'}}).returning();
  return {patient:patient!,session:session!};
}
test('unknown sessions have no export',async()=>{expect(await read('ffffffff-ffff-4fff-8fff-ffffffffffff',exportedAt)).toBeNull();});
test('export uses one visit snapshot, excludes other patients/visits and never confirms reported facts',async()=>{
  const {patient,session}=await fixture();const other=await fixture();
  const [old]=await db.insert(s.sessions).values({patientId:patient.id,status:'closed',startedAt:new Date('2026-10-01T08:00:00Z')}).returning();
  const diagnosis={kind:'chronic' as const,icd10Code:'I10',display:'Hipertensi sintetis',clinicalStatus:'active' as const,confirmedBy:'Perawat Contoh',confirmedAt:new Date('2026-10-15T08:20:00Z')};
  await db.insert(s.patientConditions).values([
    {...diagnosis,patientId:patient.id,sessionId:session.id},
    {...diagnosis,patientId:other.patient.id,display:'Secret other patient'},
    {...diagnosis,patientId:patient.id,sessionId:old!.id,display:'Other visit only'},
    {...diagnosis,patientId:patient.id,sessionId:session.id,display:'Unconfirmed AI guess',confirmedBy:null},
    {...diagnosis,patientId:patient.id,sessionId:session.id,display:'Peanut allergy',kind:'allergy'},
  ]);
  await db.insert(s.triageResults).values({sessionId:session.id,layer:'decision_model',flowAction:'queue',category:'fever_infection'});
  const before=(await db.select().from(s.sessions).where(eq(s.sessions.id,session.id)))[0];
  const bundle=await read(session.id,exportedAt);
  expect(bundle?.entry.filter(entry=>entry.resource.resourceType === 'Condition')).toHaveLength(1);
  expect(JSON.stringify(bundle)).not.toMatch(/Secret other patient|Other visit only|Unconfirmed AI guess|Peanut allergy/);
  const encounter=bundle!.entry.find(entry=>entry.resource.resourceType === 'Encounter')!.resource;
  if(encounter.resourceType !== 'Encounter') throw new Error('Missing encounter');
  expect(encounter.reasonCode).toContainEqual({text:'Kategori AI (belum dikonfirmasi klinisi): fever_infection'});
  expect(encounter.diagnosis).toHaveLength(1);
  expect(bundle!.entry.some(entry=>entry.resource.resourceType === 'QuestionnaireResponse')).toBe(true);
  expect((await db.select().from(s.sessions).where(eq(s.sessions.id,session.id)))[0]).toEqual(before);
});
test('a staff claim alone is not exported as clinical contact; a recorded staff reply is in progress',async()=>{
  const {session}=await fixture();await repository.claimStaffSession(session.id);
  let bundle=await read(session.id,exportedAt);
  expect(bundle!.entry.find(entry=>entry.resource.resourceType === 'Encounter')!.resource).toMatchObject({status:'triaged'});
  await repository.recordNurseMessage(session.id,'Halo');
  bundle=await read(session.id,exportedAt);
  expect(bundle!.entry.find(entry=>entry.resource.resourceType === 'Encounter')!.resource).toMatchObject({status:'in-progress'});
});
test('a completed callback visit maps to finished, while an abandoned closure maps to cancelled',async()=>{
  const {session}=await fixture();
  await db.update(s.sessions).set({status:'closed',closedAt:new Date('2026-10-15T09:00:00Z')}).where(eq(s.sessions.id,session.id));
  expect((await read(session.id,exportedAt))!.entry.find(entry=>entry.resource.resourceType === 'Encounter')!.resource).toMatchObject({status:'cancelled'});
  await db.insert(s.queueEntries).values({sessionId:session.id,lane:'green',status:'served',queueNumber:++seq,completedAt:new Date('2026-10-15T09:00:00Z')});
  expect((await read(session.id,exportedAt))!.entry.find(entry=>entry.resource.resourceType === 'Encounter')!.resource).toMatchObject({status:'finished'});
});

test('floor emergencies export the triggering patient text when intake was interrupted',async()=>{
  const {session}=await fixture();
  await db.update(s.sessions).set({status:'escalated',priority:'P1',isEmergency:true,intake:null}).where(eq(s.sessions.id,session.id));
  const [message]=await db.insert(s.messages).values({sessionId:session.id,direction:'inbound',sender:'patient',kind:'text',body:'nyeri dada sejak tadi pagi'}).returning();
  await db.insert(s.triageResults).values({sessionId:session.id,messageId:message!.id,layer:'red_flag_floor',redFlagFired:true,redFlagFamily:'cardiac',flowAction:'escalate',tier:'P1',escalated:true});
  const bundle=await read(session.id,exportedAt);
  expect(bundle!.entry.find(entry=>entry.resource.resourceType === 'Encounter')!.resource).toMatchObject({reasonCode:[{text:'Keluhan pasien: nyeri dada sejak tadi pagi'}]});
  expect(bundle!.entry.some(entry=>entry.resource.resourceType === 'Condition')).toBe(false);
});
