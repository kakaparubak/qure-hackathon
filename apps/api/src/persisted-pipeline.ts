import type { InboundMessage, WhatsAppChannel } from '@qure/core';
import type { Orchestrator } from '@qure/core/triage/orchestrator';
import { scan } from '@qure/core/red-flag/floor';
import { escalationText } from '@qure/core/reply/playbooks';
import type { PipelineStore, StoredReply } from '@qure/db';

/** Persist first; transport sends only after commit. HTTP returns a pending reply without sending it. */
export function persistedPipeline(core:Orchestrator,store:PipelineStore,channel:WhatsAppChannel,logger:(message:string)=>void):Orchestrator {
  async function process(msg:InboundMessage) {
    try {
      const stored=await store.process(msg,core.assess);
      if(stored) logger(`Persisted triage: session=${stored.sessionId} outbound=${stored.id} kind=${stored.outcome.kind}`);
      return {stored,failed:false};
    }
    catch { logger('Persistence failed: human escalation fallback; message was not acknowledged as persisted.'); return {stored:null,failed:true}; }
  }
  function fallback(msg:InboundMessage) {
    const verdict=scan(msg.text);
    return {phone:msg.phone,text:'Sistem pencatatan sedang bermasalah. Silakan hubungi petugas langsung.\n\n'+escalationText(verdict.family),purpose:'playbook' as const};
  }
  return {
    assess:core.assess,
    seenCount:core.seenCount,
    async handleInbound(msg) {
      const result=await process(msg);
      return result.failed ? fallback(msg) : result.stored?.outcome.reply ?? null;
    },
    async onInbound(msg) {
      const result=await process(msg);
      if(result.failed) { await channel.send(fallback(msg)); return; }
      const stored:StoredReply|null=result.stored;
      if(!stored) return;
      await channel.send(stored.outcome.reply);
      try { await store.delivered(stored); }
      catch { logger('Outbound sent but delivery audit failed; pending record requires reconciliation.'); }
    },
  };
}
