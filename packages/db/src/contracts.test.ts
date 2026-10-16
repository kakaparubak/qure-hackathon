import { expect, test } from 'bun:test';
import { ALLOWED_TRANSITIONS } from '@qure/core';
import { RED_FLAG_RULES } from '@qure/core/red-flag/patterns';
import { redFlagFamily, encounterStatus, triageResults, messages } from './schema';
import { decisionToRow, inboundToRow, outboundToRow } from './mapping';
import { neutralDecision } from '@qure/core/decision-model/fake';

test('every floor family can be persisted without translation', () => {
  expect([...redFlagFamily.enumValues].sort()).toEqual(RED_FLAG_RULES.map(r => r.family).sort());
  expect<string[]>([...encounterStatus.enumValues].sort()).toEqual(Object.keys(ALLOWED_TRANSITIONS).sort());
});
test('Decision round-trips categorical clarity, confidence and raw findings', () => {
  const decision = neutralDecision({clarity:'mostly_clear', urgency:2.72, urgencyConfidence:0.8, raw:{answers:{x:1}}});
  const row: typeof triageResults.$inferInsert = decisionToRow('session', decision, {flowAction:'queue'});
  expect(row.clarity).toBe(decision.clarity);
  expect(row.urgencyConfidence).toBe(0.8);
  expect(row.scoreUrgency).toBe(2.72);
  expect(row.rawOutput).toEqual(decision.raw);
});
test('message mapping preserves provider id, timestamp, kind and purpose', () => {
  const receivedAt = new Date('2026-10-15T00:00:00Z');
  const row: typeof messages.$inferInsert = inboundToRow('s', {phone:'628123456789', text:'', kind:'audio', providerMessageId:'provider-id',receivedAt});
  expect(row.waMessageId).toBe('provider-id');
  expect(row.createdAt).toEqual(receivedAt);
  expect(row.kind).toBe('audio');
  expect(row.meta).toEqual({phone:'628123456789'});
  expect(outboundToRow('s',{phone:'628123456789',text:'guidance',purpose:'playbook'}).meta).toEqual({phone:'628123456789',purpose:'playbook'});
});

test('queue projection derives positions, ETA and wait time in the frozen event shape',async()=>{
  const {deriveQueueRows}=await import('./queue');
  const {assertSessionUpdate}=await import('./repository');
  const joinedAt=new Date('2026-10-15T00:00:00Z');
  const rows=deriveQueueRows([
    {sessionId:'b',patientName:null,tier:'P3',lane:'normal',joinedAt:new Date('2026-10-15T00:01:00Z'),hasAllergies:false,ticketNumber:3,ticketDate:'2026-10-15'},
    {sessionId:'p',patientName:null,tier:'P1',lane:'priority',joinedAt,hasAllergies:true,ticketNumber:2,ticketDate:'2026-10-15'},
    {sessionId:'a',patientName:'A',tier:'P3',lane:'normal',joinedAt,hasAllergies:false,ticketNumber:1,ticketDate:'2026-10-15'},
  ],new Date('2026-10-15T00:10:00Z'),5);
  const event: import('@qure/core').QueueEvent={type:'queue_updated',rows};
  expect(event.rows.map(r=>[r.sessionId,r.position,r.etaMinutes,r.waitedMinutes])).toEqual([['p',1,0,10],['a',1,5,10],['b',2,10,9]]);
  // Priority joined after the routine patients but is served first; its ticket
  // number stays stable and never determines position.
  expect(rows[0]?.ticketNumber).toBe(2);
  expect(rows[0]?.position).toBe(1);
  expect(rows[0]?.hasAllergies).toBe(true);
  expect(deriveQueueRows([{sessionId:'s',patientName:null,tier:null,lane:'normal',joinedAt,hasAllergies:false,ticketNumber:9,ticketDate:'2026-10-15'}])[0]?.etaMinutes).toBeNull();
  expect(()=>assertSessionUpdate({status:'escalated',priority:'P1',wantsHuman:true},{priority:'P3'})).toThrow();
});
