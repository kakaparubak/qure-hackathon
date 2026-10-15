import { beforeAll, afterAll, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { ALLOWED_TRANSITIONS, type SessionStatus } from '@qure/core';
import { readdir } from 'node:fs/promises';
import { assertSessionUpdate } from './repository';

const db = new PGlite();
let patientId:string;
beforeAll(async () => {
  const dir = new URL('../drizzle/',import.meta.url);
  for (const file of (await readdir(dir)).filter(f=>f.endsWith('.sql')).sort()) {
    await db.exec(await Bun.file(new URL(file,dir)).text());
  }
  const result = await db.query<{id:string}>("INSERT INTO patients (wa_number) VALUES ('628123456789') RETURNING id");
  patientId = result.rows[0]!.id;
},30000);
afterAll(async()=>{await db.close();});
async function session(status='triaging',priority:string|null=null) {
  return (await db.query<{id:string}>('INSERT INTO sessions(patient_id,status,priority) VALUES ($1,$2,$3) RETURNING id',[patientId,status,priority])).rows[0]!.id;
}

test('database and repository enforce every frozen transition', async()=> {
  for(const from of Object.keys(ALLOWED_TRANSITIONS) as SessionStatus[]) {
    for(const to of Object.keys(ALLOWED_TRANSITIONS) as SessionStatus[]) {
      const id = await session(from);
      const allowed = from === to || ALLOWED_TRANSITIONS[from].includes(to);
      const update = db.query('UPDATE sessions SET status=$1 WHERE id=$2',[to,id]);
      const check = ()=>assertSessionUpdate({status:from,priority:null,wantsHuman:false},{status:to});
      if(allowed) { await update; expect(check).not.toThrow(); }
      else { await expect(update).rejects.toThrow('Illegal session transition'); expect(check).toThrow(); }
    }
  }
});
test('priority cannot downgrade, including clearing it',async()=>{
  const id=await session('escalated','P1');
  for(const tier of ['P2','P3',null]) await expect(db.query('UPDATE sessions SET priority=$1 WHERE id=$2',[tier,id])).rejects.toThrow('cannot de-escalate');
  const normal=await session('waiting','P3');
  await db.query("UPDATE sessions SET priority='P1',status='escalated' WHERE id=$1",[normal]);
});
test('human and emergency flags cannot be cleared',async()=>{
  const id=await session();
  await db.query('UPDATE sessions SET wants_human=true,is_emergency=true WHERE id=$1',[id]);
  await expect(db.query('UPDATE sessions SET wants_human=false WHERE id=$1',[id])).rejects.toThrow('Human request');
  await expect(db.query('UPDATE sessions SET is_emergency=false WHERE id=$1',[id])).rejects.toThrow('Emergency');
});
test('audit rows accept inserts but reject update, delete and truncate',async()=>{
  const id=await session();
  await db.query("INSERT INTO triage_results(session_id,layer,flow_action,red_flag_family,clarity,score_urgency,urgency_confidence,raw_output) VALUES ($1,'red_flag_floor','escalate','stroke_fast','mostly_clear',3.4,0.8,'{\"matched\":true}')",[id]);
  for(const sql of ['UPDATE triage_results SET escalated=false','DELETE FROM triage_results','TRUNCATE triage_results CASCADE']) await expect(db.exec(sql)).rejects.toThrow('append-only');
});
test('provider message ids deduplicate and emergency skeleton is valid',async()=>{
  const id=await session();
  await db.query("INSERT INTO messages(session_id,direction,sender,wa_message_id) VALUES ($1,'inbound','patient','duplicate')",[id]);
  await expect(db.query("INSERT INTO messages(session_id,direction,sender,wa_message_id) VALUES ($1,'inbound','patient','duplicate')",[id])).rejects.toThrow('unique');
  const result=await db.query<{name:string|null;profile_complete:boolean}>('SELECT name,profile_complete FROM patients WHERE id=$1',[patientId]);
  expect(result.rows[0]).toEqual({name:null,profile_complete:false});
});
