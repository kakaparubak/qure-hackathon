/** Bounded emergency dialogue: the model selects text; it cannot write treatment.
 * Sources and clinical-review requirements: see emergency/README.md.
 */
import { z } from 'zod';
import type { RedFlagFamily } from '../red-flag/patterns';

export const EMERGENCY_ROUTE = 'Hubungi 119 sekarang untuk bantuan medis darurat dan ikuti arahan operator. Jangan menunggu balasan chat atau petugas puskesmas.';
export const ACTIONS = {
  support: {text:'Saya akan membantu menyampaikan langkah pertolongan awal lewat chat. Chat ini tidak dapat memastikan penyebab keluhan atau menggantikan pertolongan medis langsung.', family:null},
  companion: {text:'Minta orang terdekat menemani dan membantu menghubungi layanan darurat.', family:null},
  unavailable: {text:'Saya tidak bisa memastikan kapan petugas tersedia atau apakah bantuan sudah dikirim. Jika 119 tidak tersambung, minta orang terdekat membantu menghubungi IGD terdekat.', family:null},
  medication: {text:'Saya tidak dapat menentukan obat atau dosis yang aman untuk keadaan darurat lewat chat. Tanyakan langsung kepada operator 119 atau tenaga medis; beri tahu obat yang sudah digunakan dan alergi Anda.', family:null},
  diagnosis: {text:'Penyebab dan tingkat bahaya keluhan tidak bisa dipastikan lewat chat. Keluhan ini tetap membutuhkan penilaian medis segera, meskipun terasa membaik.', family:null},
  rest: {text:'Hentikan aktivitas dan beristirahat dalam posisi yang paling nyaman sambil mencari bantuan medis.', family:'cardiac'},
  pressure: {text:'Jika darah keluar dari luka luar, tekan luka terus-menerus dengan kain atau kasa bersih. Jika ada benda tertancap, jangan dicabut; tekan di sekitarnya, bukan pada bendanya.', family:'bleeding_trauma'},
} satisfies Record<string,{text:string;family:RedFlagFamily|null}>;
export type ActionId=keyof typeof ACTIONS;
export const QUESTIONS = {
  companion:'Apakah ada orang di dekat Anda yang bisa membantu sekarang?',
  help_contacted:'Apakah Anda atau pendamping sudah berhasil menghubungi 119 atau IGD?',
  change:'Apa yang berubah dari keluhan Anda sejak pesan sebelumnya?',
} as const;
export const planSchema=z.object({actionIds:z.array(z.enum(Object.keys(ACTIONS) as [ActionId,...ActionId[]])).min(1).max(2),questionId:z.enum(['companion','help_contacted','change']).nullable()}).strict();
export interface EmergencyInput {
  text:string; families:RedFlagFamily[];
  history:{role:'user'|'assistant';content:string}[];
}
export interface EmergencyModel {plan(input:EmergencyInput):Promise<unknown>;}
export function allowedActions(families:RedFlagFamily[]):ActionId[] {
  // Multiple families can imply incompatible care. Use common guidance only.
  return (Object.keys(ACTIONS) as ActionId[]).filter(id=>ACTIONS[id].family === null ||
    (families.length === 1 && ACTIONS[id].family === families[0]));
}
export function validatePlan(raw:unknown,families:RedFlagFamily[]) {
  const plan=planSchema.parse(raw);
  const allowed=allowedActions(families);
  if(new Set(plan.actionIds).size !== plan.actionIds.length || plan.actionIds.some(id=>!allowed.includes(id))) throw new Error('Invalid emergency plan');
  return plan;
}
export async function emergencyReply(input:EmergencyInput,model?:EmergencyModel) {
  let plan:ReturnType<typeof validatePlan>={actionIds:['support','companion'],questionId:'help_contacted'};
  let usedFallback=true;
  if(model) {
    try {plan=validatePlan(await model.plan(input),input.families);usedFallback=false;} catch { /* Always answer, even if every provider fails. */ }
  }
  // These boundaries must not depend on the model agreeing with them.
  if(/\b(obat|dosis|aspirin|paracetamol|parasetamol|ibuprofen|antibiotik|tablet|medicine|dose|medication)\b/i.test(input.text)) plan={actionIds:['medication'],questionId:'help_contacted'};
  else if(/\b(diagnos\w*|penyakit|sembuh|aman|membaik|mendingan)\b/i.test(input.text)) plan={actionIds:['diagnosis'],questionId:'help_contacted'};
  else if(/(?:tidak|tak|belum|nggak|gak|ga|no)\s+(?:ada\s+)?(?:petugas|perawat|dokter|staff|bantuan|help)|sendiri(?:an)?|119.*(?:tidak|gak|nggak|belum).*?(?:sambung|jawab)/i.test(input.text)) plan={actionIds:['unavailable','companion'],questionId:null};
  return {
    text:[EMERGENCY_ROUTE,...plan.actionIds.map(id=>ACTIONS[id].text),...(plan.questionId ? [QUESTIONS[plan.questionId]] : [])].join('\n\n'),
    audit:{version:'1',families:input.families,actionIds:plan.actionIds,questionId:plan.questionId,usedFallback},
  };
}
