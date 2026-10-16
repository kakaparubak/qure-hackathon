import {test,expect} from 'bun:test';
import {createServer} from './index';
import {loadConfig} from '@qure/core/config';
import {sessionToFhirBundle,type FhirVisitInput} from '@qure/core/fhir/mapper';
import fixture from '../../../packages/core/src/fhir/fixtures/visit.json';
const config=loadConfig({OPENROUTER_API_KEY:'synthetic-key',OPENROUTER_ENDPOINT:'https://example.test/systemone',MODEL_PRIMARY_ID:'perplexity/pplx-decider-v1.1-27b',MODEL_FALLBACK_ID:'typesafe/jev-1.13',RED_FLAG_CUTOFF_PRIMARY:'0.15',RED_FLAG_CUTOFF_FALLBACK:'0.31',WA_ENABLED:'false'});
test('the production bootstrap forwards FHIR exports and readiness and closes the runtime',async()=>{
  let ready=false;let closed=false;const bundle=sessionToFhirBundle(fixture as FhirVisitInput);
  const app=await createServer(config,async()=>({ready:async()=>ready,close:async()=>{closed=true;},channelMode:'none',readQueue:async()=>[],
    sessions:{serve:async()=>'served',detail:async()=>null,triage:async()=>[],messages:async()=>[],sendMessage:async()=>{},fhir:async()=>bundle},
    orchestrator:{assess:async()=>{throw new Error('No models');},handleInbound:async()=>null,onInbound:async()=>{},seenCount:()=>0}}),false);
  try {
    expect((await app.inject('/health')).statusCode).toBe(200);expect((await app.inject('/ready')).statusCode).toBe(503);
    ready=true;expect((await app.inject('/ready')).statusCode).toBe(200);
    const exported=await app.inject(`/api/sessions/${fixture.session.id}/fhir`);expect(exported.statusCode).toBe(200);expect(exported.json()).toEqual(bundle);
  } finally {await app.close();}
  expect(closed).toBe(true);
});
