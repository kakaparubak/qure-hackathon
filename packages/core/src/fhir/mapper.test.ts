import { expect, test } from 'bun:test';
import { sessionToFhirBundle, IHS_SYSTEM, type FhirVisitInput, type FhirBundle } from './mapper';
import fixture from './fixtures/visit.json';
const input=():FhirVisitInput=>structuredClone(fixture) as FhirVisitInput;
function resource<T extends FhirBundle['entry'][number]['resource']['resourceType']>(bundle:FhirBundle,type:T) {
  return bundle.entry.map(entry=>entry.resource).find((value):value is Extract<typeof value,{resourceType:T}>=>value.resourceType === type)!;
}
test('fixture produces the committed synthetic bundle deterministically without mutating its input',async()=>{
  const visit=input();const before=structuredClone(visit);
  const actual=sessionToFhirBundle(visit);
  expect(actual).toEqual(await Bun.file(new URL('../../../../docs/demo/fhir-bundle.json',import.meta.url)).json());
  expect(sessionToFhirBundle(visit)).toEqual(actual);expect(visit).toEqual(before);
  expect(actual.type).toBe('collection');expect(actual.entry).toHaveLength(4);
  expect(actual).not.toHaveProperty('total');
});
test('every internal reference resolves to one unique bundle entry',()=>{
  const bundle=sessionToFhirBundle(input());const urls=bundle.entry.map(entry=>entry.fullUrl);
  expect(new Set(urls).size).toBe(urls.length);
  function check(value:unknown) {
    if(!value || typeof value !== 'object') return;
    for(const [key,child] of Object.entries(value)) {
      if(key === 'reference') expect(urls).toContain(child as string);else check(child);
    }
  }
  check(bundle);
});
test('patient-reported allergies, medicines and age remain intake facts; age never fabricates a birth date',()=>{
  const bundle=sessionToFhirBundle(input());
  expect(resource(bundle,'Patient')).not.toHaveProperty('birthDate');
  expect(resource(bundle,'Patient').identifier.some(value=>value.system === IHS_SYSTEM)).toBe(false);
  expect(resource(bundle,'QuestionnaireResponse').item).toContainEqual({linkId:'allergies',text:'Alergi yang dilaporkan pasien',answer:[{valueString:'kacang-kacangan'}]});
  expect(bundle.entry.filter(entry=>entry.resource.resourceType === 'Condition')).toHaveLength(1);
  expect(resource(bundle,'Condition').code.coding).toEqual([{system:'http://hl7.org/fhir/sid/icd-10',code:'I10'}]);
  expect(resource(bundle,'Encounter').reasonCode).toContainEqual({text:'Interpretasi AI (belum dikonfirmasi klinisi): Keluhan batuk, perlu penilaian petugas'});
});
test('only confirmed diagnoses with one existing ICD-10 code become Condition resources',()=>{
  const visit=input();const condition=visit.conditions[0]!;
  visit.conditions=[{...condition,confirmedBy:null},{...condition,id:'30000000-0000-4000-8000-000000000002',confirmedAt:null},
    {...condition,id:'30000000-0000-4000-8000-000000000003',icd10Code:null},
    {...condition,id:'30000000-0000-4000-8000-000000000004',icd10Code:'I10,E11'},
    {...condition,id:'30000000-0000-4000-8000-000000000005',kind:'allergy'},
    {...condition,id:'30000000-0000-4000-8000-000000000006',kind:'medication'}];
  expect(sessionToFhirBundle(visit).entry.filter(entry=>entry.resource.resourceType === 'Condition')).toHaveLength(0);
});
test('emergency skeletons omit unknown demographics and retain P1 without manufacturing diagnoses or identifiers',()=>{
  const visit=input();visit.patient={id:visit.patient.id,waNumber:visit.patient.waNumber};
  visit.session={...visit.session,status:'escalated',priority:'P1',closedAt:null,staffStarted:false,served:false,intake:null,reasonForVisit:null,category:null};visit.conditions=[];
  const bundle=sessionToFhirBundle(visit);const patient=resource(bundle,'Patient');const encounter=resource(bundle,'Encounter');
  expect(bundle.entry).toHaveLength(2);expect(patient).not.toHaveProperty('name');expect(patient).not.toHaveProperty('gender');
  expect(encounter.status).toBe('triaged');expect(encounter.priority?.coding?.map(value=>value.code)).toEqual(['EM','P1']);
  expect(encounter.class.code).toBe('VR');expect(encounter.period).not.toHaveProperty('end');
});
test('lifecycle distinguishes triage, staff contact, completed care and closure without care',()=>{
  for(const [status,staffStarted,served,expected] of [
    ['triaging',false,false,'arrived'],['waiting',false,false,'triaged'],['green_lane',false,false,'triaged'],
    ['escalated',true,false,'in-progress'],['served',false,false,'finished'],['closed',false,false,'cancelled'],['closed',true,true,'finished'],
  ] as const) {
    const visit=input();visit.session={...visit.session,status,staffStarted,served};
    expect(resource(sessionToFhirBundle(visit),'Encounter').status).toBe(expected);
  }
});
test('existing demographics and IHS identifiers are preserved without remote lookup',()=>{
  const visit=input();visit.patient.ihsNumber='synthetic-ihs';visit.patient.birthDate='1990-01-02';visit.patient.sex='perempuan';
  const patient=resource(sessionToFhirBundle(visit),'Patient');
  expect(patient.identifier).toContainEqual({system:IHS_SYSTEM,value:'synthetic-ihs'});expect(patient.birthDate).toBe('1990-01-02');expect(patient.gender).toBe('female');
});
test('cross-patient, cross-visit, invalid chronology and duplicate resources fail safely',()=>{
  const wrongPatient=input();wrongPatient.session.patientId='90000000-0000-4000-8000-000000000001';
  expect(()=>sessionToFhirBundle(wrongPatient)).toThrow('ownership');
  const wrongVisit=input();wrongVisit.conditions[0]!.sessionId='90000000-0000-4000-8000-000000000001';
  expect(()=>sessionToFhirBundle(wrongVisit)).toThrow('ownership');
  const future=input();future.session.closedAt='2026-10-17T00:00:00.000Z';expect(()=>sessionToFhirBundle(future)).toThrow('chronology');
  const duplicated=input();duplicated.conditions.push({...duplicated.conditions[0]!});expect(()=>sessionToFhirBundle(duplicated)).toThrow('Duplicate');
});
