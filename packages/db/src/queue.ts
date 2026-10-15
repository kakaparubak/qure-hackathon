import type { QueueTicketRow } from '@qure/core';
/** Stable ticket numbers and historical tier snapshots never determine live position/tier. */
export interface QueueSnapshot {
  sessionId:string;
  patientName:string|null;
  tier:QueueTicketRow['tier'];
  lane:QueueTicketRow['lane'];
  joinedAt:Date;
  hasAllergies:boolean;
  ticketNumber:number;
  /** Local day (YYYY-MM-DD) the ticket was issued for; matches queue_entries.queue_date. */
  ticketDate:string;
}
export function deriveQueueRows(entries:QueueSnapshot[], now=new Date(), serviceMinutes?:number):QueueTicketRow[] {
  if(serviceMinutes !== undefined && (!Number.isFinite(serviceMinutes) || serviceMinutes <= 0)) throw new Error('serviceMinutes must be positive');
  const lanes={priority:0,normal:1,green:2};
  const counts={priority:0,normal:0,green:0};
  return [...entries].sort((a,b)=>lanes[a.lane]-lanes[b.lane] || a.joinedAt.getTime()-b.joinedAt.getTime() || a.sessionId.localeCompare(b.sessionId)).map(entry=>{
    const position=++counts[entry.lane];
    return {sessionId:entry.sessionId,patientName:entry.patientName,tier:entry.tier,lane:entry.lane,position,
      etaMinutes:serviceMinutes === undefined ? null : (position-1)*serviceMinutes,
      waitedMinutes:Math.max(0,Math.floor((now.getTime()-entry.joinedAt.getTime())/60000)),hasAllergies:entry.hasAllergies,
      ticketNumber:entry.ticketNumber,ticketDate:entry.ticketDate};
  });
}
