import { expect, test } from 'bun:test';
import { createSessionReaders } from './wiring';
import { buildApp } from './app';
import { FakeChannel } from '@qure/core/channel/fake';

const sessionId='0b8f6c1e-1111-4222-8333-444455556666';
function fixture() {
  const recorded:string[]=[];
  const repository={
    serveSession:async ()=>'served' as const,
    sessionDetail:async ()=>null,
    sessionTriage:async ()=>[],
    sessionMessages:async ()=>[],
    claimStaffSession:async ()=>'628123456789',
    recordNurseMessage:async (_id:string,body:string)=>{recorded.push(body);},
  };
  return {repository,recorded};
}

test('webhook-only nurse messaging returns 503 without recording a fake delivery',async()=>{
  const {repository,recorded}=fixture();
  const app=buildApp({handleInbound:async()=>null,sessions:createSessionReaders(repository,null)});
  try {
    const response=await app.inject({method:'POST',url:`/api/sessions/${sessionId}/messages`,payload:{body:'Halo, saya perawat.'}});
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({error:'Message could not be delivered'});
    expect(recorded).toEqual([]);
  } finally {await app.close();}
});

test('live nurse messaging sends before recording; transport failure is not recorded',async()=>{
  const {repository,recorded}=fixture();
  const channel=new FakeChannel();
  const record=repository.recordNurseMessage;
  repository.recordNurseMessage=async(id,body)=>{
    expect(channel.sent.at(-1)?.text).toBe(body);
    await record(id,body);
  };
  const readers=createSessionReaders(repository,channel);
  await readers.sendMessage(sessionId,'Halo');
  expect(channel.sent).toEqual([{phone:'628123456789',text:'Halo',purpose:'reply'}]);
  expect(recorded).toEqual(['Halo']);
  const failed=createSessionReaders(repository,{onMessage:()=>{},send:async()=>{throw new Error('offline');}});
  await expect(failed.sendMessage(sessionId,'Retry')).rejects.toThrow('offline');
  expect(recorded).toEqual(['Halo']);
});
