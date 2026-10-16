import { expect, test } from 'bun:test';
import { createEmergencyModel } from './llm';
import type { EmergencyInput } from './engine';

const input:EmergencyInput={text:'apa yang harus saya lakukan?',families:['cardiac'],history:[]};
const config={primary:null,fallback:{endpoint:'https://example.test/chat/completions',apiKey:'test-only',modelId:'test/model'}};

test('retries emergency guidance selection three times before reporting provider failure',async()=>{
  let calls=0;
  const fetchImpl=(async()=>{
    calls++;
    if(calls<3) return Response.json({error:'temporary provider error'},{status:503});
    return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({actionIds:['rest'],questionId:'companion'})}}]});
  }) as unknown as typeof fetch;
  const model=createEmergencyModel(config,fetchImpl);
  const plan=await model.plan(input);
  expect(plan).toEqual({actionIds:['rest'],questionId:'companion'});
  expect(calls).toBe(3);
});
