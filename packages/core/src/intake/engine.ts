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
  updates: z.object({
    name: evidenceText.optional(),
    ageYears: z.object({value:z.number().int().min(0).max(120),evidence:textValue}).strict().optional(),
    complaint: evidenceText.optional(), duration: evidenceText.optional(),
    allergies: evidenceText.optional(), medications: evidenceText.optional(),
  }).strict(),
  nextField: z.enum(INTAKE_FIELDS).nullable(),
}).strict();
export type IntakeExtraction = z.infer<typeof extractionSchema>;
export interface HistoryTurn { role: 'user' | 'assistant'; content: string; }
export interface IntakeModel {
  extract(input: {state:IntakeState; text:string; history:HistoryTurn[]}): Promise<IntakeExtraction>;
}
export interface IntakeTurn {
  state: IntakeState;
  text: string;
  handoff: boolean;
  usedFallback: boolean;
}

export const HUMAN_OFFER = 'Ketik "petugas" kapan saja untuk meminta bantuan petugas.';
const QUESTIONS: Record<IntakeField,string> = {
  name: 'Siapa nama pasien?',
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
const normalized = (value:string) => value.toLowerCase().replace(/\s+/g,' ').trim();

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

export async function advanceIntake(input:{state:IntakeState;text:string;history:HistoryTurn[];model?:IntakeModel;clarifyComplaint?:boolean}):Promise<IntakeTurn> {
  const state=intakeSchema.parse(input.state);
  if (requestsHuman(input.text) || state.status === 'handoff') {
    return {state:{...state,status:'handoff'},text:HANDOFF_TEXT,handoff:true,usedFallback:false};
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
  const fields=fieldsSchema.parse({...state.fields,...updates});
  const pending=state.awaiting && fields[state.awaiting] === undefined ? state.awaiting : null;
  const awaiting=pending ?? (input.clarifyComplaint && fields.complaint === undefined ? 'complaint' : INTAKE_FIELDS.find(field=>fields[field] === undefined) ?? null);
  // Count only failed answers to the exact pending question, not total turns.
  const unresolved=state.awaiting !== null && updates[state.awaiting] === undefined;
  const attempts=unresolved ? state.attempts+1 : 0;
  if (attempts >= 3) return {state:{...state,fields,attempts,status:'handoff'},text:HANDOFF_TEXT,handoff:true,usedFallback};
  const next:IntakeState={version:1,fields,awaiting,attempts:awaiting === state.awaiting ? attempts : 0,status:awaiting ? 'collecting' : 'complete'};
  return {state:next,text:`${awaiting ? QUESTIONS[awaiting] : COMPLETE_TEXT}\n\n${HUMAN_OFFER}`,handoff:false,usedFallback};
}
