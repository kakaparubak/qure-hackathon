import { test, expect } from 'bun:test';
import { buildApp } from './app';
import { sessionToFhirBundle, type FhirVisitInput } from '@qure/core/fhir/mapper';
import fixture from '../../../packages/core/src/fhir/fixtures/visit.json';
const id=fixture.session.id;
const sessions={serve:async()=>'served' as const,detail:async()=>null,triage:async()=>[],messages:async()=>[],sendMessage:async()=>{}};
test('FHIR download returns the visit bundle with attachment headers and no caching',async()=>{
  const bundle=sessionToFhirBundle(fixture as FhirVisitInput);
  const app=buildApp({handleInbound:async()=>null,sessions:{...sessions,fhir:async(value)=>{expect(value).toBe(id);return bundle;}}});
  try {
    const response=await app.inject(`/api/sessions/${id}/fhir`);
    expect(response.statusCode).toBe(200);expect(response.json()).toEqual(bundle);
    expect(response.headers['content-type']).toContain('application/fhir+json');
    expect(response.headers['content-disposition']).toBe(`attachment; filename="qure-${id}.fhir.json"`);
    expect(response.headers['cache-control']).toBe('no-store');expect(response.headers['x-content-type-options']).toBe('nosniff');
  } finally {await app.close();}
});
test('missing and malformed FHIR session identifiers return 404 without disclosure',async()=>{
  let calls=0;const app=buildApp({handleInbound:async()=>null,sessions:{...sessions,fhir:async()=>{calls++;return null;}}});
  try {
    expect((await app.inject('/api/sessions/not-a-uuid/fhir')).statusCode).toBe(404);expect(calls).toBe(0);
    expect((await app.inject(`/api/sessions/${id}/fhir`)).statusCode).toBe(404);expect(calls).toBe(1);
  } finally {await app.close();}
});
test('FHIR read failures and unavailable readers produce generic errors without attachment headers',async()=>{
  for(const fhir of [undefined,async()=>{throw new Error('secret DB credentials');}]) {
    const app=buildApp({handleInbound:async()=>null,sessions:{...sessions,fhir}});
    try {
      const response=await app.inject(`/api/sessions/${id}/fhir`);
      expect(response.statusCode).toBe(503);expect(response.body).not.toMatch(/secret|credentials/);
      expect(response.headers['content-disposition']).toBeUndefined();
    } finally {await app.close();}
  }
});
