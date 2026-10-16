import {test,expect} from 'bun:test';
import {EventEmitter} from 'node:events';
import {installShutdown} from './shutdown';

test('SIGTERM drains app hooks exactly once before exit and disposes signal handlers',async()=>{
  const emitter=new EventEmitter();const exits:number[]=[];let closes=0;let resolve!:()=>void;
  const draining=new Promise<void>(done=>{resolve=done;});
  const app={close:async()=>{closes++;await draining;},log:{info:()=>{},error:()=>{}}};
  const dispose=installShutdown(app as Parameters<typeof installShutdown>[0],{once:emitter.once.bind(emitter),removeListener:emitter.removeListener.bind(emitter),exit:(code)=>{exits.push(code);}});
  emitter.emit('SIGTERM');emitter.emit('SIGINT');expect(closes).toBe(1);expect(exits).toEqual([]);
  resolve();await new Promise(done=>setTimeout(done,0));expect(exits).toEqual([0]);
  dispose();expect(emitter.listenerCount('SIGTERM')+emitter.listenerCount('SIGINT')).toBe(0);
});
test('failed cleanup exits nonzero without leaking underlying error details',async()=>{
  const emitter=new EventEmitter();const exits:number[]=[];const logs:string[]=[];
  installShutdown({close:async()=>{throw new Error('private credentials');},log:{info:(message:string)=>logs.push(message),error:(message:string)=>logs.push(message)}} as Parameters<typeof installShutdown>[0],
    {once:emitter.once.bind(emitter),removeListener:emitter.removeListener.bind(emitter),exit:code=>{exits.push(code);}});
  emitter.emit('SIGTERM');await new Promise(done=>setTimeout(done,0));expect(exits).toEqual([1]);expect(logs.join(' ')).not.toContain('private');
});
