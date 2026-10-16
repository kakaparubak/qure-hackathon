import { z } from 'zod';

export const INTAKE_FIELDS = ['name', 'ageYears', 'complaint', 'duration', 'allergies', 'medications'] as const;
export type IntakeField = typeof INTAKE_FIELDS[number];
const textValue = z.string().trim().min(1).max(500);
const fieldsSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  ageYears: z.number().int().min(0).max(120).optional(),
  complaint: textValue.optional(), duration: textValue.optional(),
  allergies: textValue.optional(), medications: textValue.optional(),
}).strict();
export const intakeSchema = z.object({
  version: z.literal(1), fields: fieldsSchema,
  awaiting: z.enum(INTAKE_FIELDS).nullable(),
  attempts: z.number().int().min(0),
  status: z.enum(['collecting', 'complete', 'handoff']),
}).strict();
export type IntakeState = z.infer<typeof intakeSchema>;
const evidenceText = z.object({ value: textValue, evidence: textValue }).strict();
export const extractionSchema = z.object({
  // Some providers return [{field,value,evidence}] instead of a field map.
  // Preserve valid entries; only an empty array means "nothing to extract".
  updates: z.preprocess(
    (value) => {
      if (!Array.isArray(value)) return value;
      const entries=z.array(z.object({field:z.enum(INTAKE_FIELDS),value:z.union([textValue,z.number()]),evidence:textValue}).strict()).safeParse(value);
      if (!entries.success || new Set(entries.data.map(entry=>entry.field)).size !== entries.data.length) return value;
      return Object.fromEntries(entries.data.map(({field,value,evidence})=>[field,{value,evidence}]));
    },
    z.object({
      name: evidenceText.optional(),
      ageYears: z.object({value:z.number().int().min(0).max(120),evidence:textValue}).strict().optional(),
      complaint: evidenceText.optional(), duration: evidenceText.optional(),
      allergies: evidenceText.optional(), medications: evidenceText.optional(),
    }).strict(),
  ),
  nextField: z.enum(INTAKE_FIELDS).nullable(),
}).strict();
export type IntakeExtraction = z.infer<typeof extractionSchema>;
export interface HistoryTurn { role: 'user' | 'assistant'; content: string; }
export interface IntakeModel {
  extract(input: {state:IntakeState; text:string; history:HistoryTurn[]}): Promise<IntakeExtraction>;
  /**
   * The conversational turn: reads the thread and writes the whole reply -
   * acknowledge what the patient said, probe their condition, steer toward
   * the pending field. Optional; without it the engine sends fixed questions.
   *
   * The reply is validated before use and the model never controls triage:
   * escalation, handoff, completeness, and what gets stored are all decided
   * by the backend from the extracted facts, not from this text.
   */
  respond?(input: {state:IntakeState; text:string; history:HistoryTurn[]}): Promise<string>;
}

/**
 * Guard for model-written replies. The voice may vary; the lane may not.
 * Rejects anything long enough to be an essay, anything that is not a
 * question while fields remain, and anything that smells like the model
 * practicing medicine - advice, reassurance about danger, or triage language.
 */
const REPLY_FORBIDDEN = /\b(aspirin|paracetamol|antibiotik|dosis|\d+\s*mg|jangan khawatir|tenang saja|berbahaya|aman|jangan panik|segera ke igd|hubungi 119|darurat|prioritas|gawat darurat)\b/i;
const FIELD_QUESTIONS:Record<IntakeField,RegExp> = {
  name:/\bnama\w*\b/i,
  ageYears:/\b(umur\w*|usia\w*|tahun)\b/i,
  complaint:/\b(keluhan\w*|gejala\w*|dirasakan|sakit\w*)\b/i,
  duration:/\b(kapan|sejak|berapa lama|sudah berapa)\b/i,
  allergies:/\balergi\w*\b/i,
  medications:/\b(obat\w*|vitamin\w*|suplemen\w*|konsumsi\w*)\b/i,
};
export function validReply(text:string, awaiting?:IntakeField|null):boolean {
  if (text.length < 8 || text.length > 600) return false;
  if (!text.includes('?')) return false;
  if (REPLY_FORBIDDEN.test(text)) return false;
  // Asking what a patient takes is intake, not an instruction to take it.
  // Keep rejecting medication instructions, including those after a question.
  const sentences=text.match(/[^.!?\n]+[.!?]?/g) ?? [];
  for (const sentence of sentences) {
    if (/\bminum obat\b/i.test(sentence) &&
      !(sentence.endsWith('?') && /\b(apa\w*|sudah|sedang|lagi|pernah|belum)\b/i.test(sentence) &&
        !/\b(harus|sebaiknya|silakan|coba|perlu|dianjurkan)\b/i.test(sentence))) return false;
  }
  if (awaiting && !sentences.some(sentence=>sentence.endsWith('?') && FIELD_QUESTIONS[awaiting].test(sentence))) return false;
  return true;
}
export interface IntakeProviderFailure {provider:'primary'|'fallback';reason:'invalid_response'|'invalid_json'|'timeout'|'invalid_reply'|'incomplete_response'|'request_failed';}
export class IntakeProviderError extends Error {
  constructor(readonly failures:IntakeProviderFailure[]) {super('All intake providers failed');}
}
export interface IntakeTurn {
  state: IntakeState;
  text: string;
  handoff: boolean;
  usedFallback: boolean;
  replyFallbackReason: 'unavailable' | 'provider_failure' | 'invalid_reply' | null;
  replyProviderFailures?:IntakeProviderFailure[];
  extractionRecovery?:{rejectedFields:IntakeField[];recoveredFields:IntakeField[];fromHistory:boolean};
}

export const HUMAN_OFFER = 'Ketik "petugas" kapan saja untuk meminta bantuan petugas.';
const QUESTIONS: Record<IntakeField,string> = {
  name: 'Boleh tahu nama Anda?',
  ageYears: 'Berapa umur pasien dalam tahun? Tuliskan angka, misalnya 62.',
  complaint: 'Apa keluhan utama pasien saat ini?',
  duration: 'Sejak kapan keluhan tersebut dirasakan?',
  allergies: 'Apakah pasien memiliki alergi? Jika tidak, tulis "tidak ada".',
  medications: 'Obat apa yang sedang digunakan pasien? Jika tidak ada, tulis "tidak ada".',
};
export const HANDOFF_TEXT = 'Percakapan Anda ditandai untuk bantuan petugas. Silakan hubungi petugas puskesmas langsung.';
export const COMPLETE_TEXT = 'Terima kasih, informasi awal pasien sudah lengkap dan tersimpan untuk ditinjau petugas. Nomor antrean belum diterbitkan. Jika keluhan berubah atau memburuk, balas pesan ini.';
export function emptyIntake():IntakeState {
  return {version:1,fields:{},awaiting:null,attempts:0,status:'collecting'};
}
/** Old/null state starts fresh; invalid persisted version fails rather than silently losing progress. */
export function readIntake(value:unknown):IntakeState {
  return value === null || value === undefined ? emptyIntake() : intakeSchema.parse(value);
}
export function requestsHuman(text:string):boolean {
  return /^(?:petugas|perawat|manusia|(?:saya\s+)?(?:mau|ingin|minta|tolong)?\s*(?:bicara|berbicara|hubungi|panggil|bantuan)\s+(?:dengan\s+)?(?:petugas|perawat|manusia))[.!?\s]*$/i.test(text.trim());
}
// Indonesian reduplication shorthand: kacang2an = kacang-kacangan,
// obat2 = obat-obat. Numbers such as ages/durations are left untouched.
const normalized = (value:string) => value.toLowerCase()
  .replace(/\b([a-z]+)2([a-z]*)\b/g, '$1 $1$2')
  .replace(/-/g,' ').replace(/\s+/g,' ').trim();

/** No LLM-provided value is accepted without a verbatim supporting excerpt in this message. */
function evidencedUpdates(text:string, extraction:IntakeExtraction):IntakeState['fields'] {
  const updates:IntakeState['fields'] = {};
  for (const field of INTAKE_FIELDS) {
    const answer=extraction.updates[field];
    if (!answer || !normalized(text).includes(normalized(answer.evidence))) continue;
    if (field === 'ageYears') {
      const value=answer.value;
      if (typeof value === 'number' && new RegExp(`(?:^|\\D)${value}(?:\\D|$)`).test(answer.evidence)) updates.ageYears=value;
    } else if (typeof answer.value === 'string' && normalized(answer.evidence).includes(normalized(answer.value))) {
      if (/^(?:tidak tahu|gak tahu|nggak tahu|entahlah|tidak mengerti)$/i.test(answer.value)) continue;
      if (field === 'name' && (answer.value.length > 100 || !/^[\p{L}][\p{L} .'-]*$/u.test(answer.value) || /^(?:tidak ada|tidak tahu|halo|petugas)$/i.test(answer.value))) continue;
      updates[field]=answer.value;
    }
  }
  return updates;
}

/** Conservative direct-answer parser for provider outages. It never guesses medical meaning. */
function scriptedExtraction(state:IntakeState,text:string):IntakeExtraction {
  const updates:IntakeExtraction['updates']={};
  const field=state.awaiting;
  const value=text.trim();
  if (field === null) {
    // Opening turn: no question is pending, so nothing is "answered". A
    // self-introduction is the one safe exception - "Saya Budi" is an explicit
    // name statement, and ignoring it silently loses the only identity the
    // patient gives unprompted. Anything else waits for a real question.
    const name=value.replace(/^saya\s+/i,'');
    if (/^saya\s+/i.test(value) && /^[\p{L}][\p{L} .'-]{1,79}$/u.test(name) && name.split(/\s+/).length <= 5 && !/\b(tidak|tahu|halo|sakit|demam|obat|bantuan)\b/i.test(name)) {
      updates.name={value:name,evidence:value};
    }
  } else if (field === 'ageYears') {
    const match=value.match(/^(?:(?:umur|usia)(?: saya| pasien)?\s*)?(\d{1,3})(?:\s*tahun)?[.!]?$/i);
    if (match && Number(match[1]) <= 120) updates.ageYears={value:Number(match[1]),evidence:value};
  } else if (field === 'name') {
    const name=value.replace(/^(?:nama(?: saya| pasien)?|saya)\s+/i,'');
    if (/^[\p{L}][\p{L} .'-]{1,79}$/u.test(name) && name.split(/\s+/).length <= 5 && !/\b(tidak|tahu|halo|sakit|demam|obat|bantuan)\b/i.test(name)) updates.name={value:name,evidence:value};
  } else if (field && value.length <= 500 && /[\p{L}\p{N}]/u.test(value) && !/^(?:tidak tahu|gak tahu|nggak tahu|entahlah)$/i.test(value)) {
    updates[field]={value,evidence:value};
  }
  return {updates,nextField:null};
}

// These are cues for preserving patient wording, never a medical verdict.
// No diagnosis, severity, negation interpretation or queue change is inferred.
const COMPLAINT_CUE=/\b(sakit|nyeri|perih|luka|tertusuk|ketusuk|terluka|demam|batuk|pilek|pusing|mual|muntah|diare|mencret|gatal|bengkak|sesak|kejang|pingsan|berdarah|lemas|kram|kebas|kesemutan|pegal|kena paku)\b/i;
const NON_ANSWER=/^(?:halo|hallo|hai|hi|oke|ok|ya|iya|tidak|enggak|nggak|gak|ga|tidak tahu|gak tahu|nggak tahu|entahlah|terima kasih|makasih)[.!\s]*$/i;
function reportedComplaint(text:string):string|null {
  const value=text.trim();
  return value.length<=500 && !value.includes('?') && COMPLAINT_CUE.test(value)
    && !/\b(?:abaikan|instruksi|prompt|berpura|ignore|pretend)\b/i.test(value) ? value : null;
}
function reportedDuration(text:string):string|null {
  // Retain the literal time phrase, including slang. Do not infer "one day"
  // from "kemaren", a date of onset, a wound diagnosis or a tetanus status.
  return text.match(/\b(?:(?:sejak|dari|mulai|sudah|udah|selama)\s+)?(?:kemarin|kemaren|tadi(?:\s+(?:pagi|siang|sore|malam))?|\d+\s*(?:menit|jam|hari|minggu|bulan)(?:\s+(?:ini|lalu))?)\b/i)?.[0] ?? null;
}
function mergeComplaint(previous:string|undefined,answer:string):string {
  if(!previous || normalized(answer).includes(normalized(previous))) return answer;
  if(normalized(previous).includes(normalized(answer))) return previous;
  const joined=`${previous}; ${answer}`;
  // The transcript still preserves all details beyond the bounded intake field.
  return joined.length<=500 ? joined : previous;
}

export async function advanceIntake(input:{state:IntakeState;text:string;history:HistoryTurn[];model?:IntakeModel;clarifyComplaint?:boolean}):Promise<IntakeTurn> {
  const state=intakeSchema.parse(input.state);
  if (requestsHuman(input.text) || state.status === 'handoff') {
    return {state:{...state,status:'handoff'},text:HANDOFF_TEXT,handoff:true,usedFallback:false,replyFallbackReason:null};
  }
  let usedFallback=false;
  let extraction:IntakeExtraction;
  try {
    if (!input.model) throw new Error('No intake model configured');
    extraction=extractionSchema.parse(await input.model.extract({state,text:input.text,history:input.history}));
  } catch {
    usedFallback=true;
    extraction=scriptedExtraction(state,input.text);
  }
  const updates=evidencedUpdates(input.text,extraction);
  const rejectedFields=INTAKE_FIELDS.filter(field=>extraction.updates[field] !== undefined && updates[field] === undefined);
  const recoveredFields:IntakeField[]=[];
  let fromHistory=false;
  // A paraphrase is not verbatim evidence. For complaint/duration retain the
  // actual supporting quote instead of accepting the model's interpretation.
  for(const field of ['complaint','duration'] as const) {
    const answer=extraction.updates[field];
    if(updates[field] === undefined && answer && normalized(input.text).includes(normalized(answer.evidence))) {
      const value=answer.evidence.trim();
      if(!NON_ANSWER.test(value) && (field === 'complaint' ? reportedComplaint(value) : reportedDuration(value))) {
        updates[field]=value;recoveredFields.push(field);
      }
    }
  }
  // Recover only patient-authored health statements from this visit. Never
  // copy a bot's examples, and never invent a clinical summary or diagnosis.
  if(updates.complaint === undefined) {
    const prior=state.fields.complaint === undefined ? input.history.slice(-12).filter(turn=>turn.role === 'user').map(turn=>reportedComplaint(turn.content)).filter((value):value is string=>value !== null) : [];
    const current=reportedComplaint(input.text);
    if(current || prior.length) {
      const quotes=[...prior,...(current ? [current] : [])];
      updates.complaint=quotes.reduce<string|undefined>((previous,value)=>mergeComplaint(previous,value),undefined)!;
      recoveredFields.push('complaint');fromHistory=prior.length>0;
    }
  }
  if(state.fields.duration === undefined && updates.duration === undefined && (state.fields.complaint || updates.complaint)) {
    const current=state.awaiting === 'duration' || (reportedComplaint(input.text) && !/\b(obat|minum|konsumsi|tablet|vitamin)\b/i.test(input.text)) ? reportedDuration(input.text) : null;
    const previous=input.history.slice(-12).filter(turn=>turn.role === 'user' && reportedComplaint(turn.content)).map(turn=>reportedDuration(turn.content)).find(value=>value !== null);
    if(current || previous) {updates.duration=(current ?? previous)!;recoveredFields.push('duration');fromHistory ||= !current;}
  }
  if(updates.complaint) updates.complaint=mergeComplaint(state.fields.complaint,updates.complaint);
  // Deterministic answers the model provably fumbles (returns zero updates
  // for trivially extractable facts). Same reasoning as the red-flag floor:
  // when the reply is unambiguous, the backend does not need the model's
  // vote, and the flake stops being the patient's problem.
  // 1) A bare "tidak" answering allergies or medications means none.
  //    "tidak tahu" stays unresolved.
  if (state.awaiting === 'allergies' || state.awaiting === 'medications') {
    const bare=/^(?:tidak|gak|nggak|tdk|enggak)(?:\s+(?:ada|punya|alergi|obat|makanan|Obat))?[\s!.,?]*$/i.test(input.text.trim());
    if (bare && updates[state.awaiting] === undefined) updates[state.awaiting]='tidak ada';
  }
  // 2) A bare number ("19", "19 tahun") answering the age question.
  if (state.awaiting === 'ageYears') {
    const match=input.text.trim().match(/^(\d{1,3})\s*(?:tahun|thn)?[\s!.,?]*$/i);
    if (match && Number(match[1]) <= 120 && updates.ageYears === undefined) updates.ageYears=Number(match[1]);
  }
  const fields=fieldsSchema.parse({...state.fields,...updates});
  const pending=state.awaiting && fields[state.awaiting] === undefined ? state.awaiting : null;
  const awaiting=pending ?? (input.clarifyComplaint && fields.complaint === undefined ? 'complaint' : INTAKE_FIELDS.find(field=>fields[field] === undefined) ?? null);
  // Count only failed answers to the exact pending question, not total turns.
  const madeProgress=INTAKE_FIELDS.some(field=>updates[field] !== undefined && updates[field] !== state.fields[field]);
  const unresolved=state.awaiting !== null && fields[state.awaiting] === undefined && !madeProgress;
  const attempts=unresolved ? state.attempts+1 : 0;
  if (attempts >= 3) return {state:{...state,fields,attempts,status:'handoff'},text:HANDOFF_TEXT,handoff:true,usedFallback,replyFallbackReason:null};
  const next:IntakeState={version:1,fields,awaiting,attempts:awaiting === state.awaiting ? attempts : 0,status:awaiting ? 'collecting' : 'complete'};
  // Conversational reply when the model can write one and it passes
  // validation; the fixed template is the fallback, and the completion text
  // stays fixed in both cases. The HUMAN_OFFER rides only on the opening
  // turns - repeating it after every answer is part of what made the
  // conversation feel robotic.
  let question=awaiting ? QUESTIONS[awaiting] : COMPLETE_TEXT;
  let replyFallbackReason:IntakeTurn['replyFallbackReason']=awaiting ? 'unavailable' : null;
  let replyProviderFailures:IntakeProviderFailure[]|undefined;
  // Extraction and wording are independent. A malformed extraction must not
  // disable a healthy conversational provider after scripted facts are saved.
  if (awaiting && input.model?.respond) {
    try {
      const reply=await input.model.respond({state:next,text:input.text,history:input.history});
      if (validReply(reply,awaiting)) {question=reply.trim();replyFallbackReason=null;}
      else replyFallbackReason='invalid_reply';
    } catch(error) {
      replyProviderFailures=error instanceof IntakeProviderError ? error.failures : undefined;
      replyFallbackReason=replyProviderFailures?.every(failure=>failure.reason === 'invalid_reply') ? 'invalid_reply' : 'provider_failure';
    }
  }
  const offer=Object.keys(fields).length <= 1 ? `\n\n${HUMAN_OFFER}` : '';
  if(replyFallbackReason !== null && awaiting === 'name' && fields.complaint) question=`Keluhan Anda sudah dicatat. ${QUESTIONS.name}`;
  return {state:next,text:`${question}${offer}`,handoff:false,usedFallback,replyFallbackReason,replyProviderFailures,
    extractionRecovery:{rejectedFields,recoveredFields,fromHistory}};
}
