import { test, expect } from 'bun:test';
import { startCheckInWorker } from './check-in-worker';
import type { CheckInEngine } from '@qure/db';
import { FakeChannel } from '@qure/core/channel/fake';
test('check-in worker sends durable claims and records delivery after transport',async()=>{
  let claimed=false;let done!:()=>void;
  const finished=new Promise<void>(resolve=>{done=resolve;});const channel=new FakeChannel();
  const engine:CheckInEngine={refresh:async()=>{},claimNotice:async()=>claimed?null:(claimed=true,{id:'id',sessionId:'visit',reply:{phone:'628123456789',text:'Bagaimana keadaan Anda?',purpose:'reply'}}),
    finishNotice:async(_id,delivery)=>{expect(delivery).toBe('sent');expect(channel.sent).toHaveLength(1);done();}};
  const worker=startCheckInWorker(engine,channel,()=>{});await finished;await worker.close();
});
test('webhook-only check-ins neither schedule nor deliver messages',async()=>{
  let calls=0;const engine:CheckInEngine={refresh:async()=>{calls++;},claimNotice:async()=>{calls++;return null;},finishNotice:async()=>{calls++;}};
  const worker=startCheckInWorker(engine,null,()=>{});await worker.close();expect(calls).toBe(0);
});
test('failed check-in transport is recorded once for reconciliation',async()=>{
  let claimed=false;let done!:()=>void;const finished=new Promise<void>(resolve=>{done=resolve;});
  const engine:CheckInEngine={refresh:async()=>{},claimNotice:async()=>claimed?null:(claimed=true,{id:'id',sessionId:'visit',reply:{phone:'628123456789',text:'Bagaimana keadaan Anda?',purpose:'reply'}}),finishNotice:async(_id,delivery)=>{expect(delivery).toBe('failed');done();}};
  const worker=startCheckInWorker(engine,{onMessage:()=>{},send:async()=>{throw new Error('offline');}},()=>{});await finished;await worker.close();
});
