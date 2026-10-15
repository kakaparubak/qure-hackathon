import { test,expect } from 'bun:test';
import { createOrchestrator } from '@qure/core/triage/orchestrator';
import { FakeDecisionModel,neutralDecision } from '@qure/core/decision-model/fake';
import { FakeChannel } from '@qure/core/channel/fake';
import type { PipelineStore,StoredReply } from '@qure/db';
import { persistedPipeline } from './persisted-pipeline';
const input={phone:'628123456789',text:'nyeri dada',kind:'text' as const,providerMessageId:'persisted-api-test',receivedAt:new Date()};
function setup(failSend=false) {
  const order:string[]=[];
  const channel=new FakeChannel();
  channel.send=async()=>{order.push('send');if(failSend)throw new Error('socket down');};
  const core=createOrchestrator({model:new FakeDecisionModel(neutralDecision()),channel,slots:[{id:neutralDecision().model!,cutoff:0.15,urgencyCeiling:4}]});
  const store:PipelineStore={
    process:async(msg,assess)=>{const outcome=await assess(msg);order.push('commit');return {id:'outbound',sessionId:'session',triageResultId:'triage',outcome};},
    delivered:async(_reply:StoredReply)=>{order.push('audit');},
  };
  return {order,store,core,channel,pipeline:persistedPipeline(core,store,channel,()=>{})};
}
test('WhatsApp commits before sending, then records delivered playbook',async()=>{
  const {pipeline,order}=setup();await pipeline.onInbound(input);expect(order).toEqual(['commit','send','audit']);
});
test('failed send leaves a pending record, never logs a delivered playbook',async()=>{
  const {pipeline,order}=setup(true);await expect(pipeline.onInbound(input)).rejects.toThrow('socket down');expect(order).toEqual(['commit','send']);
});
test('HTTP persists reply intent but does not send WhatsApp or claim delivery',async()=>{
  const {pipeline,order}=setup();expect((await pipeline.handleInbound(input))?.purpose).toBe('playbook');expect(order).toEqual(['commit']);
});
test('durable duplicates do not send',async()=>{
  const {store,pipeline,order}=setup();store.process=async()=>null;await pipeline.onInbound(input);expect(order).toEqual([]);
});
test('DB failure returns explicit escalation and preserves cardiac floor guidance',async()=>{
  const {store,pipeline}=setup();store.process=async()=>{throw new Error('database unavailable');};
  const reply=await pipeline.handleInbound(input);expect(reply?.purpose).toBe('playbook');expect(reply?.text).toContain('Sistem pencatatan');expect(reply?.text).toContain('Duduk');
});
