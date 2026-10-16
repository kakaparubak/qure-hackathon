import { expect, test } from 'bun:test';
import { createIntakeModel } from './llm';
import { emptyIntake } from './engine';
const config={primary:null,fallback:{endpoint:'https://example.test/chat/completions',apiKey:'test-only',modelId:'test/model'}};
const input={state:emptyIntake(),history:[],text:'Saya Budi'};
function responding(body:unknown,status=200):typeof fetch {
  return (async()=>new Response(JSON.stringify(body),{status})) as unknown as typeof fetch;
}
test('uses chat completions with persisted state and bounded history, not System One',async()=>{
  let sent:Record<string,unknown>={};
  const fetchImpl=(async(_url:unknown,init:RequestInit)=>{
    sent=JSON.parse(String(init.body));
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-only');
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({updates:{name:{value:'Budi',evidence:'Budi'}},nextField:'ageYears'})}}]}));
  }) as unknown as typeof fetch;
  const result=await createIntakeModel(config,fetchImpl).extract(input);
  expect(result.updates.name?.value).toBe('Budi');
  expect(sent.model).toBe('test/model');
  expect(sent).not.toHaveProperty('questions');
  const messages=sent.messages as {role:string;content:string}[];
  expect(JSON.parse(messages[1]!.content).STATE).toEqual(emptyIntake());
  expect(JSON.parse(messages[1]!.content).CURRENT_MESSAGE).toBe(input.text);
});
test('rejects provider failure, malformed JSON, invalid fields, and truncation',async()=>{
  for(const [body,status] of [
    [{error:'quota'},429],
    [{choices:[{message:{content:'not json'}}]},200],
    [{choices:[{message:{content:'{"updates":{"ageYears":{"value":999,"evidence":"999"}},"nextField":null}'}}]},200],
    [{choices:[{finish_reason:'length',message:{content:'{"updates":{},"nextField":null}'}}]},200],
  ] as const) {
    await expect(createIntakeModel(config,responding(body,status)).extract(input)).rejects.toThrow();
  }
});

test('primary failure falls through to the fallback per call',async()=>{
  let primaryCalls=0,fallbackCalls=0;
  const fetchImpl=(async(_url:unknown,init:RequestInit)=>{
    const isPrimary=new Headers(init.headers).get('authorization')==='Bearer zai-good';
    if(isPrimary) { primaryCalls+=1; return new Response('{"error":"quota exceeded"}',{status:429}); }
    fallbackCalls+=1;
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({updates:{name:{value:'Budi',evidence:'Budi'}},nextField:null})}}]}));
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({updates:{name:{value:'Budi',evidence:'Budi'}},nextField:null})}}]}));
  }) as unknown as typeof fetch;
  const model=createIntakeModel({
    primary:{endpoint:'https://zai.test/chat',apiKey:'zai-good',modelId:'glm-5.3-flash'},
    fallback:{endpoint:'https://example.test/chat',apiKey:'test-only',modelId:'test/model'},
  },fetchImpl);
  const result=await model.extract({state:emptyIntake(),history:[],text:'Saya Budi'});
  expect(result.updates.name?.value).toBe('Budi');
  // HTTP failure goes directly to the fallback instead of retrying the same provider.
  expect(primaryCalls).toBe(1);
  expect(fallbackCalls).toBe(1);
});

test('an extraction timeout fails over immediately without retrying the timed-out provider',async()=>{
  let primaryCalls=0,fallbackCalls=0;
  const fetchImpl=(async(_url:unknown,init:RequestInit)=>{
    const isPrimary=new Headers(init.headers).get('authorization')==='Bearer zai-good';
    if(isPrimary) {
      primaryCalls++;
      throw Object.assign(new Error('request timed out'),{name:'TimeoutError'});
    }
    fallbackCalls++;
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({updates:{},nextField:'name'})}}]}));
  }) as unknown as typeof fetch;
  const model=createIntakeModel({
    primary:{endpoint:'https://zai.test/chat',apiKey:'zai-good',modelId:'glm-5.3-flash'},
    fallback:{endpoint:'https://example.test/chat',apiKey:'test-only',modelId:'test/model'},
  },fetchImpl);
  expect((await model.extract(input)).nextField).toBe('name');
  expect(primaryCalls).toBe(1);
  expect(fallbackCalls).toBe(1);
});

test('an empty-array updates answer means zero updates, not a failed turn',async()=>{
  const model=createIntakeModel(config,(async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"updates":[],"nextField":"name"}'}}]}))) as unknown as typeof fetch);
  const result=await model.extract({state:emptyIntake(),history:[],text:'halo'});
  expect(result.updates).toEqual({});
  expect(result.nextField).toBe('name');
});

test('preserves nonempty array updates from the stomach-pain example',async()=>{
  const extraction={updates:[{field:'complaint',value:'perut saya sakit banget',evidence:'perut saya sakit banget'}],nextField:'name'};
  const model=createIntakeModel(config,responding({choices:[{finish_reason:'stop',message:{content:JSON.stringify(extraction)}}]}));
  const {advanceIntake}=await import('./engine');
  const turn=await advanceIntake({state:{...emptyIntake(),awaiting:'complaint'},text:'perut saya sakit banget, kayaknya salah makan deh',history:[],model});
  expect(turn.state.fields.complaint).toBe('perut saya sakit banget');
  expect(turn.state.awaiting).toBe('name');
  expect(turn.usedFallback).toBe(false);
});

test('rejects malformed or duplicate array entries rather than silently erasing facts',async()=>{
  for(const updates of [
    [{field:'diagnosis',value:'foo',evidence:'foo'}],
    [{field:'name',value:'Budi',evidence:'Budi'},{field:'name',value:'Sari',evidence:'Sari'}],
    [{field:'ageYears',value:999,evidence:'999'}],
    ['not an update'],
  ]) {
    const model=createIntakeModel(config,responding({choices:[{message:{content:JSON.stringify({updates,nextField:null})}}]}));
    await expect(model.extract(input)).rejects.toThrow();
  }
});

test('invalid, truncated, or empty primary reply tries the fallback provider',async()=>{
  const cfg={...config,primary:{...config.fallback,apiKey:'primary-only'}};
  for(const choice of [
    {finish_reason:'stop',message:{content:'Minum obat dulu ya. Siapa nama pasien?'}},
    {finish_reason:'stop',message:{content:null}},
    {finish_reason:'stop',message:{content:'Keluhan sudah dicatat. Sejak kapan sakitnya?'}},
  ]) {
    const logs:string[]=[];
    const fetchImpl=(async(_url:unknown,init:RequestInit)=>{
      const primary=new Headers(init.headers).get('authorization')==='Bearer primary-only';
      return new Response(JSON.stringify({choices:[primary ? choice : {finish_reason:'stop',message:{content:'Keluhannya sudah dicatat. Boleh tahu nama pasien?'}}]}));
    }) as unknown as typeof fetch;
    const model=createIntakeModel(cfg,fetchImpl,message=>logs.push(message));
    expect(await model.respond!({...input,state:{...emptyIntake(),awaiting:'name'}})).toBe('Keluhannya sudah dicatat. Boleh tahu nama pasien?');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/Intake respond: provider=primary attempt=1\/3 reason=/);
    expect(logs[0]).not.toMatch(/primary-only|Budi|Minum/);
  }
});

test('accepts a complete safe reply when the provider marks its finish reason as length',async()=>{
  const model=createIntakeModel(config,responding({choices:[{finish_reason:'length',message:{content:'Terima kasih sudah menjelaskan. Boleh tahu nama pasien?'}}]}));
  expect(await model.respond!({...input,state:{...emptyIntake(),awaiting:'name'}})).toBe('Terima kasih sudah menjelaskan. Boleh tahu nama pasien?');
});

test('retries patient-facing LLM replies three times before giving up',async()=>{
  let calls=0;
  const fetchImpl=(async()=>{
    calls++;
    const content=calls < 3 ? 'Sudah minum obat apa?' : 'Saya paham ini membuat khawatir. Boleh tahu nama pasien?';
    return Response.json({choices:[{finish_reason:'stop',message:{content}}]});
  }) as unknown as typeof fetch;
  const model=createIntakeModel(config,fetchImpl);
  expect(await model.respond!({...input,state:{...emptyIntake(),awaiting:'name'}})).toBe('Saya paham ini membuat khawatir. Boleh tahu nama pasien?');
  expect(calls).toBe(3);
});

test('uses provider-specific reasoning controls and enough reply budget',async()=>{
  for(const [endpoint,modelId,expected] of [
    ['https://api.z.ai/api/paas/v4/chat/completions','glm-5.3-flash',{reasoning_effort:'low'}],
    ['https://api.z.ai/api/coding/paas/v4/chat/completions','glm-4.7',{thinking:{type:'disabled'}}],
    ['https://openrouter.ai/api/v1/chat/completions','z-ai/glm-5.3-flash',{reasoning:{effort:'low',exclude:true}}],
  ] as const) {
    const fetchImpl=(async(_url:unknown,init:RequestInit)=>{
      const body=JSON.parse(String(init.body));
      expect(body).toMatchObject(expected);
      expect(body.max_tokens).toBe(2000);
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'Boleh tahu nama pasien?'}}]}));
    }) as unknown as typeof fetch;
    const model=createIntakeModel({primary:null,fallback:{endpoint,modelId,apiKey:'test-only'}},fetchImpl);
    expect(await model.respond!({...input,state:{...emptyIntake(),awaiting:'name'}})).toBe('Boleh tahu nama pasien?');
  }
  const autoFetch=(async(_url:unknown,init:RequestInit)=>{
    const body=JSON.parse(String(init.body));
    expect(body).toMatchObject({plugins:[{id:'auto-router',cost_tier:'low'}],reasoning:{effort:'low',exclude:true}});
    const payload=JSON.parse((body.messages as {role:string;content:string}[])[1]!.content);
    expect(payload.REQUIRED_QUESTION).toBe('Boleh tahu nama Anda?');
    expect((body.messages as {role:string;content:string}[])[0]!.content).toContain('factual, low-risk self-care guidance');
    return Response.json({choices:[{finish_reason:'stop',message:{content:'Boleh tahu nama pasien?'}}]});
  }) as unknown as typeof fetch;
  const auto=createIntakeModel({primary:null,fallback:{endpoint:'https://openrouter.ai/api/v1/chat/completions',modelId:'openrouter/auto',apiKey:'test-only'}},autoFetch);
  expect(await auto.respond!({...input,state:{...emptyIntake(),awaiting:'name'}})).toBe('Boleh tahu nama pasien?');
});

test('exhausted reply validation preserves safe provider reasons in the turn audit',async()=>{
  const {advanceIntake}=await import('./engine');
  const primary={...config.fallback,apiKey:'private-primary'};
  const fetchImpl=(async(_url:unknown,init:RequestInit)=>{
    const request=JSON.parse(String(init.body));
    const content=request.response_format ? JSON.stringify({updates:{},nextField:null}) : 'Sudah minum obat apa?';
    return Response.json({choices:[{finish_reason:'stop',message:{content}}]});
  }) as unknown as typeof fetch;
  const model=createIntakeModel({primary,fallback:config.fallback},fetchImpl);
  const turn=await advanceIntake({state:{...emptyIntake(),awaiting:'complaint',attempts:2},text:'kaki saya sakit dari kemaren, kena paku',history:[],model});
  expect(turn.replyFallbackReason).toBe('invalid_reply');
  expect(turn.replyProviderFailures).toEqual([{provider:'primary',reason:'invalid_reply'},{provider:'fallback',reason:'invalid_reply'},{provider:'fallback',reason:'invalid_reply'}]);
  expect(JSON.stringify(turn.replyProviderFailures)).not.toContain('private-primary');
  expect(turn.state.awaiting).toBe('name');expect(turn.handoff).toBe(false);
  expect(turn.text).toContain('Keluhan Anda sudah dicatat.');
});
