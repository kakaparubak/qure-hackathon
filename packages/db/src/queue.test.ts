import { expect,test } from 'bun:test';
import { deriveQueueRows, type QueueSnapshot } from './queue';
const now=new Date('2026-10-16T08:00:00Z');
const row=(id:string,lane:QueueSnapshot['lane'],tier:QueueSnapshot['tier'],joinedMinutesAgo:number,callbackSlot?:Date):QueueSnapshot=>({
  sessionId:id,patientName:null,lane,tier,joinedAt:new Date(now.getTime()-joinedMinutesAgo*60000),hasAllergies:false,ticketNumber:joinedMinutesAgo+1,ticketDate:'2026-10-16',callbackSlot,
});

test('P1 overtakes human handoff; priority demand delays normal ETA without changing its ticket',()=>{
  const rows=deriveQueueRows([row('human','priority','P2',10),row('routine','normal','P3',20),row('emergency','priority','P1',1)],now,5);
  expect(rows.map(row=>row.sessionId)).toEqual(['emergency','human','routine']);
  expect(rows.map(row=>row.etaMinutes)).toEqual([0,5,10]);
  expect(rows[2]?.ticketNumber).toBe(21);
  expect(rows[2]?.etaReason).toContain('prioritas');
});

test('callback slots determine callback order/ETA, and earlier live lanes exclude callbacks from their ETAs',()=>{
  const rows=deriveQueueRows([
    row('later','green','P3',20,new Date(now.getTime()+60*60000)),
    row('routine','normal','P3',10),
    row('sooner','green','P3',5,new Date(now.getTime()+30*60000)),
  ],now,5);
  expect(rows.map(row=>row.sessionId)).toEqual(['routine','sooner','later']);
  expect(rows.map(row=>row.etaMinutes)).toEqual([0,30,60]);
  expect(deriveQueueRows([row('routine','normal','P3',10)],now)[0]?.etaMinutes).toBeNull();
});
