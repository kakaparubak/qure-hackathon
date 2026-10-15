import { expect, test } from 'bun:test';
import { createIntakeModel } from './llm';
import { emptyIntake } from './engine';
const config={endpoint:'https://example.test/chat/completions',apiKey:'test-only',modelId:'test/model'};
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
