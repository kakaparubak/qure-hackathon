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
  callbackSlot?:Date|null;
}
export function deriveQueueRows(entries:QueueSnapshot[], now=new Date(), serviceMinutes?:number):QueueTicketRow[] {
  if(serviceMinutes !== undefined && (!Number.isFinite(serviceMinutes) || serviceMinutes <= 0)) throw new Error('serviceMinutes must be positive');
  const lanes={priority:0,normal:1,green:2};
  const counts={priority:0,normal:0,green:0};
  return [...entries].sort((a,b)=>lanes[a.lane]-lanes[b.lane]
    || (a.lane === 'priority' && b.lane === 'priority' ? Number(b.tier === 'P1')-Number(a.tier === 'P1') : 0)
    || (a.lane === 'green' && b.lane === 'green' ? (a.callbackSlot?.getTime() ?? Infinity)-(b.callbackSlot?.getTime() ?? Infinity) : 0)
    || a.joinedAt.getTime()-b.joinedAt.getTime() || a.sessionId.localeCompare(b.sessionId)).map(entry=>{
    const position=++counts[entry.lane];
    const liveAhead=entries.filter(other=>other.lane === 'priority').length;
    const etaMinutes=entry.lane === 'green'
      ? entry.callbackSlot ? Math.max(0,Math.ceil((entry.callbackSlot.getTime()-now.getTime())/60000)) : null
      : serviceMinutes === undefined ? null : Math.ceil(((entry.lane === 'normal' ? liveAhead : 0)+position-1)*serviceMinutes);
    return {sessionId:entry.sessionId,patientName:entry.patientName,tier:entry.tier,lane:entry.lane,position,
      etaMinutes,
      etaReason:entry.lane === 'green' ? 'Jadwal panggilan balik' : liveAhead > 0 && entry.lane === 'normal' ? 'Kasus prioritas didahulukan' : 'Urutan antrean saat ini',
      callbackSlot:entry.callbackSlot?.toISOString() ?? null,
      waitedMinutes:Math.max(0,Math.floor((now.getTime()-entry.joinedAt.getTime())/60000)),hasAllergies:entry.hasAllergies,
      ticketNumber:entry.ticketNumber,ticketDate:entry.ticketDate};
  });
}
