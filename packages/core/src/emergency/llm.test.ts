import { test, expect } from 'bun:test';
import { createEmergencyModel } from './llm';
const primary={endpoint:'https://api.z.ai/chat/completions',apiKey:'secret',modelId:'glm-5.3'};
const fallback={endpoint:'https://openrouter.ai/api/v1/chat/completions',apiKey:'secret2',modelId:'some-model'};
const input={text:'patient-private-text',families:['cardiac' as const],history:[{role:'user' as const,content:'private history'}]};
const response=(content:unknown,finish_reason='stop')=>Response.json({choices:[{finish_reason,message:{content:typeof content === 'string' ? content : JSON.stringify(content)}}]});
test('provider receives bounded catalog and history, returns only valid selections',async()=>{
  let request:Record<string,unknown>={};
  const fetcher=(async(_url:RequestInfo|URL,init?:RequestInit)=>{request=JSON.parse(String(init?.body));expect(init?.signal).toBeDefined();return response({actionIds:['rest'],questionId:'companion'});}) as unknown as typeof fetch;
  expect(await createEmergencyModel({primary,fallback},fetcher).plan(input)).toEqual({actionIds:['rest'],questionId:'companion'});
  expect(request.reasoning_effort).toBe('low');
  expect(JSON.stringify(request)).toContain('private history');
  expect(JSON.stringify(request)).not.toContain('Jika darah keluar');
});
test('malformed, truncated, unrelated and freeform primary plans fail over without leaking data',async()=>{
  for(const bad of [response('not json'),response({actionIds:['rest'],questionId:null},'length'),response({actionIds:['pressure'],questionId:null}),response({actionIds:['rest'],questionId:null,text:'take drug'}),new Response('',{status:503})]) {
    let calls=0;
    const logs:string[]=[];
    const fetcher=(async()=>++calls === 1 ? bad : response({actionIds:['companion'],questionId:null})) as unknown as typeof fetch;
    expect(await createEmergencyModel({primary,fallback},fetcher,text=>logs.push(text)).plan(input)).toEqual({actionIds:['companion'],questionId:null});
    expect(calls).toBe(2);
    expect(logs.join(' ')).not.toMatch(/secret|private|https|take drug/);
  }
});
test('request timeouts fail over; exhausted chain throws for local renderer fallback',async()=>{
  let calls=0;
  const fetcher=(async()=>{calls++;throw new DOMException('private request contents','TimeoutError');}) as unknown as typeof fetch;
  await expect(createEmergencyModel({primary,fallback},fetcher).plan(input)).rejects.toThrow('Emergency support unavailable');
  expect(calls).toBe(2);
});
