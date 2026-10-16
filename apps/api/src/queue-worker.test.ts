import {expect,test} from 'bun:test';
import type {QueueEngine} from '@qure/db';
import {startQueueWorker} from './queue-worker';
import {FakeChannel} from '@qure/core/channel/fake';
const status={surgeActive:true,activeP1Count:3,threshold:3};

test('queue worker sends a claimed notice and records delivery after transport succeeds',async()=>{
  let claimed=false;
  let done!:()=>void;
  const finished=new Promise<void>(resolve=>{done=resolve;});
  const channel=new FakeChannel();
  const engine:QueueEngine={status:async()=>status,refresh:async()=>status,
    claimNotice:async()=>{if(claimed)return null;claimed=true;return {id:'notice',sessionId:'visit',reply:{phone:'628123456789',text:'Antrean sibuk',purpose:'surge_broadcast'}};},
    finishNotice:async(id,delivery)=>{expect(id).toBe('notice');expect(delivery).toBe('sent');expect(channel.sent).toHaveLength(1);done();},
  };
  const worker=startQueueWorker(engine,channel,()=>{});
  await finished;await worker.close();
});

test('failed queue delivery is recorded as failed and never as sent',async()=>{
  let claimed=false;
  let done!:()=>void;
  const finished=new Promise<void>(resolve=>{done=resolve;});
  const deliveries:string[]=[];
  const engine:QueueEngine={status:async()=>status,refresh:async()=>status,
    claimNotice:async()=>{if(claimed)return null;claimed=true;return {id:'notice',sessionId:'visit',reply:{phone:'628123456789',text:'Antrean sibuk',purpose:'surge_broadcast'}};},
    finishNotice:async(_id,delivery)=>{deliveries.push(delivery);done();},
  };
  const worker=startQueueWorker(engine,{onMessage:()=>{},send:async()=>{throw new Error('offline');}},()=>{});
  await finished;await worker.close();
  expect(deliveries).toEqual(['failed']);
});
