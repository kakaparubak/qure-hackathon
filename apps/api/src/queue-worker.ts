import type { WhatsAppChannel } from '@qure/core';
import type { QueueNotice } from '@qure/db';
export interface NoticeEngine {refresh():Promise<unknown>;claimNotice():Promise<QueueNotice|null>;finishNotice(id:string,delivery:'sent'|'failed'):Promise<void>;}

/** No overlapping ticks; queue notices use a durable claim before transport. */
export function startQueueWorker(engine:NoticeEngine,channel:WhatsAppChannel|null,logger:(message:string)=>void,intervalMs=3000,label='Queue') {
  let stopped=false;
  let running:Promise<void>|null=null;
  async function tick() {
    try {
      await engine.refresh();
      if(!channel) return;
      for(let i=0;i<20 && !stopped;i++) {
        const notice=await engine.claimNotice();
        if(!notice) break;
        try {await channel.send(notice.reply);}
        catch {await engine.finishNotice(notice.id,'failed');logger(`${label} notice delivery failed; recorded for reconciliation.`);continue;}
        await engine.finishNotice(notice.id,'sent');
      }
    } catch {logger(`${label} refresh unavailable; existing queue and triage remain active.`);}
  }
  function run() {
    if(stopped || running) return;
    running=tick().finally(()=>{running=null;});
  }
  const timer=setInterval(run,intervalMs);
  timer.unref();
  run();
  return {async close(){stopped=true;clearInterval(timer);await running;}};
}
