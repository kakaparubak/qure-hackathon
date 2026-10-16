import {test,expect} from 'bun:test';
import {EventEmitter} from 'node:events';
import {createBaileysChannel} from './whatsapp';
import type {InboundMessage} from '../contracts';
function fixture() {
  const ev=new EventEmitter();let ends=0;let authSaves=0;
  const sent:unknown[]=[];
  const socket={ev,signalRepository:{lidMapping:{getPNForLID:async(_lid:string):Promise<string|null>=>null}},end:()=>{ends++;ev.emit('connection.update',{connection:'close'});},sendMessage:async(...args:unknown[])=>{sent.push(args);}};
  const dependencies={openSocket:()=>socket,loadAuth:async()=>({state:{creds:{me:{id:'linked'}}},saveCreds:async()=>{authSaves++;}})} as unknown as NonNullable<Parameters<typeof createBaileysChannel>[1]>;
  return {ev,socket,dependencies,sent,ends:()=>ends,authSaves:()=>authSaves};
}
test('Baileys readiness tracks the actual connection and close preserves the linked session',async()=>{
  const f=fixture();const channel=await createBaileysChannel({pairingNumber:'6280000000000',authDir:'/tmp/synthetic-auth'},f.dependencies);
  expect(channel.isConnected()).toBe(false);f.ev.emit('connection.update',{connection:'open'});expect(channel.isConnected()).toBe(true);
  f.ev.emit('creds.update',{});await channel.close();await channel.close();
  expect(channel.isConnected()).toBe(false);expect(f.ends()).toBe(1);expect(f.authSaves()).toBe(1);
  f.ev.emit('connection.update',{connection:'open'});expect(channel.isConnected()).toBe(false);
});
test('shutdown waits for accepted inbound work before closing the socket',async()=>{
  const f=fixture();const channel=await createBaileysChannel({pairingNumber:'6280000000000',authDir:'/tmp/synthetic-auth'},f.dependencies);
  let finish!:()=>void;const active=new Promise<void>(resolve=>{finish=resolve;});let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
  channel.onMessage(async(_message:InboundMessage)=>{entered();await active;await channel.send({phone:'6280000000000',text:'Synthetic reply',purpose:'reply'});});
  f.ev.emit('messages.upsert',{type:'notify',messages:[{key:{remoteJid:'6280000000000@s.whatsapp.net',id:'synthetic'},message:{conversation:'halo'},messageTimestamp:1}]});
  await started;const closing=channel.close();expect(f.ends()).toBe(0);
  finish();await closing;expect(f.sent).toHaveLength(1);expect(f.ends()).toBe(1);
  f.ev.emit('messages.upsert',{type:'notify',messages:[{key:{remoteJid:'6280000000000@s.whatsapp.net',id:'late'},message:{conversation:'halo'}}]});
  expect(f.sent).toHaveLength(1);
});

test('shutdown also drains messages still resolving a WhatsApp LID',async()=>{
  const f=fixture();let resolvePhone!:(phone:string|null)=>void;
  f.socket.signalRepository.lidMapping.getPNForLID=()=>new Promise(resolve=>{resolvePhone=resolve;});
  const channel=await createBaileysChannel({pairingNumber:'6280000000000',authDir:'/tmp/synthetic-auth'},f.dependencies);
  let handled=0;channel.onMessage(async()=>{handled++;});
  f.ev.emit('messages.upsert',{type:'notify',messages:[{key:{remoteJid:'synthetic@lid',id:'resolving'},message:{conversation:'halo'}}]});
  const closing=channel.close();expect(f.ends()).toBe(0);
  resolvePhone('6280000000000@s.whatsapp.net');await closing;expect(handled).toBe(1);expect(f.ends()).toBe(1);
});
