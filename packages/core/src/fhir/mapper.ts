import { z } from 'zod';
import { intakeSchema, INTAKE_FIELDS } from '../intake/engine';

const id=z.uuid();
const optionalText=z.string().trim().min(1).nullish();
const instant=z.iso.datetime({offset:true});
export const fhirVisitSchema=z.object({
  exportedAt:instant,
  patient:z.object({id,waNumber:z.string().regex(/^[1-9]\d{6,14}$/),name:optionalText,birthDate:z.iso.date().nullish(),sex:optionalText,ihsNumber:optionalText,medicalRecordNumber:optionalText}).strict(),
  session:z.object({id,patientId:id,status:z.enum(['triaging','waiting','escalated','green_lane','served','closed']),
    priority:z.enum(['P1','P2','P3']).nullable(),startedAt:instant,closedAt:instant.nullish(),
    staffStarted:z.boolean().default(false),served:z.boolean().default(false),
    reasonForVisit:optionalText,presentingComplaint:optionalText,category:optionalText,intake:intakeSchema.nullish(),
  }).strict(),
  conditions:z.array(z.object({id,patientId:id,sessionId:id.nullish(),kind:z.enum(['chronic','allergy','medication']),
    icd10Code:optionalText,display:z.string().trim().min(1),clinicalStatus:z.enum(['active','resolved','inactive']),
    confirmedBy:optionalText,confirmedAt:instant.nullish(),
  }).strict()),
}).strict();
export type FhirVisitInput=z.input<typeof fhirVisitSchema>;
type Visit=z.output<typeof fhirVisitSchema>;
export interface Coding {system:string;code:string;display?:string;}
export interface Concept {coding?:Coding[];text?:string;}
export interface Reference {reference:string;}
export interface FhirPatient {
  resourceType:'Patient';id:string;identifier:{system:string;value:string}[];
  telecom:{system:'phone';value:string}[];name?:{text:string}[];birthDate?:string;gender?:'male'|'female'|'other'|'unknown';
}
export interface FhirEncounter {
  resourceType:'Encounter';id:string;identifier:{system:string;value:string}[];
  status:'arrived'|'triaged'|'in-progress'|'finished'|'cancelled';class:Coding;subject:Reference;
  period:{start:string;end?:string};priority?:Concept;reasonCode?:Concept[];diagnosis?:{condition:Reference}[];
}
export interface FhirCondition {
  resourceType:'Condition';id:string;clinicalStatus:Concept;verificationStatus:Concept;code:Concept;
  subject:Reference;encounter?:Reference;recordedDate:string;asserter:{display:string};
}
export interface FhirQuestionnaireResponse {
  resourceType:'QuestionnaireResponse';id:string;status:'in-progress'|'completed'|'stopped';subject:Reference;encounter:Reference;
  source:Reference;item:{linkId:string;text:string;answer:({valueString:string}|{valueInteger:number})[]}[];
}
export type FhirResource=FhirPatient|FhirEncounter|FhirCondition|FhirQuestionnaireResponse;
export interface FhirBundle {
  resourceType:'Bundle';id:string;type:'collection';timestamp:string;
  meta:{tag:Coding[]};entry:{fullUrl:string;resource:FhirResource}[];
}
// Reserved local namespace: these URLs identify entries, not a remote server.
export const FHIR_BASE='https://qure.example/fhir';
export const IHS_SYSTEM='https://fhir.kemkes.go.id/id/patient-ihs-number';
const reference=(type:FhirResource['resourceType'],resourceId:string):Reference=>({reference:`${FHIR_BASE}/${type}/${resourceId}`});
const priorityCodes={P1:'EM',P2:'UR',P3:'R'} as const;
const fieldLabels={name:'Nama yang dilaporkan pasien',ageYears:'Umur dalam tahun yang dilaporkan pasien',complaint:'Keluhan pasien',duration:'Durasi yang dilaporkan pasien',allergies:'Alergi yang dilaporkan pasien',medications:'Obat yang dilaporkan pasien'};
function gender(value:string|null|undefined):FhirPatient['gender'] {
  switch(value?.toLowerCase()) {
    case 'male':case 'l':case 'laki-laki':return 'male';
    case 'female':case 'p':case 'perempuan':return 'female';
    case 'other':return 'other';case 'unknown':return 'unknown';default:return undefined;
  }
}
function encounterStatus(session:Visit['session']):FhirEncounter['status'] {
  if(session.status === 'served' || (session.status === 'closed' && session.served)) return 'finished';
  if(session.status === 'closed') return 'cancelled';
  if(session.staffStarted) return 'in-progress';
  return session.status === 'triaging' ? 'arrived' : 'triaged';
}

/** Pure local R4 export. No clock, random IDs, network, model calls or mutations.
 * See README.md for mappings, exclusions and SATUSEHAT deployment limits.
 */
export function sessionToFhirBundle(input:FhirVisitInput):FhirBundle {
  const data=fhirVisitSchema.parse(input);
  const {patient,session}=data;
  if(session.patientId !== patient.id || data.conditions.some(condition=>condition.patientId !== patient.id || (condition.sessionId && condition.sessionId !== session.id))) throw new Error('FHIR visit ownership mismatch');
  if(Date.parse(data.exportedAt)<Date.parse(session.startedAt) || (session.closedAt && (Date.parse(session.closedAt)<Date.parse(session.startedAt) || Date.parse(session.closedAt)>Date.parse(data.exportedAt)))) throw new Error('FHIR visit chronology invalid');
  const patientRef=reference('Patient',patient.id);
  const encounterRef=reference('Encounter',session.id);
  const sex=gender(patient.sex);
  const patientResource:FhirPatient={resourceType:'Patient',id:patient.id,
    identifier:[{system:`${FHIR_BASE}/identifier/whatsapp`,value:patient.waNumber},
      ...(patient.ihsNumber ? [{system:IHS_SYSTEM,value:patient.ihsNumber}] : []),
      ...(patient.medicalRecordNumber ? [{system:`${FHIR_BASE}/identifier/medical-record`,value:patient.medicalRecordNumber}] : [])],
    telecom:[{system:'phone',value:`+${patient.waNumber}`}],
    ...(patient.name ? {name:[{text:patient.name}]} : {}),...(patient.birthDate ? {birthDate:patient.birthDate} : {}),...(sex ? {gender:sex} : {}),
  };
  const conditions:FhirCondition[]=data.conditions.filter(condition=>condition.kind === 'chronic' && condition.confirmedBy && condition.confirmedAt
    && Date.parse(condition.confirmedAt)<=Date.parse(data.exportedAt) && /^[A-Z]\d{2}(?:\.[A-Z0-9]{1,4})?$/.test(condition.icd10Code ?? ''))
    .sort((a,b)=>a.id.localeCompare(b.id)).map(condition=>({resourceType:'Condition',id:condition.id,
      clinicalStatus:{coding:[{system:'http://terminology.hl7.org/CodeSystem/condition-clinical',code:condition.clinicalStatus}]},
      verificationStatus:{coding:[{system:'http://terminology.hl7.org/CodeSystem/condition-ver-status',code:'confirmed'}]},
      code:{coding:[{system:'http://hl7.org/fhir/sid/icd-10',code:condition.icd10Code!}],text:condition.display},subject:{...patientRef},
      ...(condition.sessionId === session.id ? {encounter:{...encounterRef}} : {}),recordedDate:condition.confirmedAt!,asserter:{display:condition.confirmedBy!},
    }));
  const reasons:Concept[]=[];
  const complaint=session.intake?.fields.complaint ?? session.presentingComplaint;
  if(complaint) reasons.push({text:`Keluhan pasien: ${complaint}`});
  if(session.reasonForVisit) reasons.push({text:`Interpretasi AI (belum dikonfirmasi klinisi): ${session.reasonForVisit}`});
  else if(session.category) reasons.push({text:`Kategori AI (belum dikonfirmasi klinisi): ${session.category}`});
  const diagnoses=conditions.filter(condition=>condition.encounter).map(condition=>({condition:reference('Condition',condition.id)}));
  const terminal=session.status === 'served' || session.status === 'closed';
  const encounter:FhirEncounter={resourceType:'Encounter',id:session.id,identifier:[{system:`${FHIR_BASE}/identifier/visit`,value:session.id}],
    status:encounterStatus(session),class:{system:'http://terminology.hl7.org/CodeSystem/v3-ActCode',code:'VR',display:'virtual'},
    subject:{...patientRef},period:{start:session.startedAt,...(terminal && session.closedAt ? {end:session.closedAt} : {})},
    ...(session.priority ? {priority:{coding:[{system:'http://terminology.hl7.org/CodeSystem/v3-ActPriority',code:priorityCodes[session.priority]},
      {system:`${FHIR_BASE}/CodeSystem/triage-tier`,code:session.priority}],text:`Qure! ${session.priority}`}} : {}),
    ...(reasons.length ? {reasonCode:reasons} : {}),...(diagnoses.length ? {diagnosis:diagnoses} : {}),
  };
  const resources:FhirResource[]=[patientResource,encounter,...conditions];
  if(session.intake && Object.keys(session.intake.fields).length) {
    resources.push({resourceType:'QuestionnaireResponse',id:`intake-${session.id}`,status:session.intake.status === 'complete' ? 'completed' : session.intake.status === 'handoff' ? 'stopped' : 'in-progress',
      subject:{...patientRef},source:{...patientRef},encounter:{...encounterRef},item:INTAKE_FIELDS.flatMap(field=>{
        const value=session.intake!.fields[field];
        return value === undefined ? [] : [{linkId:field,text:fieldLabels[field],answer:[typeof value === 'number' ? {valueInteger:value} : {valueString:value}]}];
      })});
  }
  const entry=resources.map(resource=>({fullUrl:reference(resource.resourceType,resource.id).reference,resource}));
  if(new Set(entry.map(item=>item.fullUrl)).size !== entry.length) throw new Error('Duplicate FHIR resource');
  return {resourceType:'Bundle',id:`bundle-${session.id}`,type:'collection',timestamp:data.exportedAt,
    meta:{tag:[{system:`${FHIR_BASE}/CodeSystem/export-kind`,code:'local-export',display:'Local export; not submitted to SATUSEHAT'}]},entry};
}
