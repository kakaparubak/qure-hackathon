import { expect, test } from 'bun:test';
import { advanceIntake, emptyIntake, COMPLETE_TEXT, HUMAN_OFFER, type IntakeModel } from './engine';
const extract: IntakeModel = { extract: async () => ({ updates:{name:{value:'Budi',evidence:'Budi'}}, nextField:'ageYears' }) };
test('extracts an evidenced name and advances to exactly one question', async()=>{
  const turn=await advanceIntake({state:emptyIntake(),text:'Saya Budi',history:[],model:extract});
  expect(turn.state.fields.name).toBe('Budi');
  expect(turn.state.awaiting).toBe('ageYears');
  expect(turn.text).toContain('umur');
});
test('rejects hallucinated values absent from the patient message',async()=>{
  const turn=await advanceIntake({state:emptyIntake(),text:'halo',history:[],model:extract});
  expect(turn.state.fields.name).toBeUndefined();
  expect(turn.state.awaiting).toBe('name');
});
test('scripted fallback collects direct answers when the model is down',async()=>{
  const model:IntakeModel={extract:async()=>{throw Error('offline');}};
  const turn=await advanceIntake({state:{...emptyIntake(),awaiting:'ageYears'},text:'62 tahun',history:[],model});
  expect(turn.state.fields.ageYears).toBe(62);
  expect(turn.usedFallback).toBe(true);
});
test('third unsuccessful attempt hands off to human, persisted counter resumes',async()=>{
  const state={...emptyIntake(),awaiting:'name' as const,attempts:2};
  const turn=await advanceIntake({state,text:'???',history:[],model:{extract:async()=>({updates:{},nextField:'name'})}});
  expect(turn.handoff).toBe(true);
  expect(turn.state.status).toBe('handoff');
});

test('a valid answer resets attempts and cannot skip missing fields',async()=>{
  const turn=await advanceIntake({state:{...emptyIntake(),awaiting:'name',attempts:2},text:'Budi',history:[],model:{extract:async()=>({updates:{name:{value:'Budi',evidence:'Budi'}},nextField:null})}});
  expect(turn.state.attempts).toBe(0);
  expect(turn.state.status).toBe('collecting');
  expect(turn.state.awaiting).toBe('ageYears');
});
test('completeness is computed by the backend, not model declaration',async()=>{
  const turn=await advanceIntake({state:emptyIntake(),text:'halo',history:[],model:{extract:async()=>({updates:{},nextField:null})}});
  expect(turn.state.status).toBe('collecting');
  expect(turn.text).toContain('nama');
});
test('explicit human request interrupts without calling intake model',async()=>{
  const turn=await advanceIntake({state:emptyIntake(),text:'bicara dengan petugas',history:[],model:{extract:async()=>{throw Error('must not run');}}});
  expect(turn.handoff).toBe(true);
  expect(turn.usedFallback).toBe(false);
});
test('completed intake does not invent a queue position',async()=>{
  const fields={name:'Budi',ageYears:62,complaint:'batuk',duration:'3 hari',allergies:'tidak ada',medications:'tidak ada'};
  const turn=await advanceIntake({state:{...emptyIntake(),fields},text:'terima kasih',history:[],model:{extract:async()=>({updates:{},nextField:null})}});
  expect(turn.state.status).toBe('complete');
  expect(turn.text).toContain('belum diterbitkan');
});

test('unclear initial complaint is clarified before identity, and pending question stays put',async()=>{
  const model:IntakeModel={extract:async()=>({updates:{},nextField:null})};
  const first=await advanceIntake({state:emptyIntake(),text:'halo',history:[],model,clarifyComplaint:true});
  expect(first.state.awaiting).toBe('complaint');
  expect(first.text).toContain('keluhan utama');
  const second=await advanceIntake({state:first.state,text:'???',history:[],model});
  expect(second.state.awaiting).toBe('complaint');
  expect(second.state.attempts).toBe(1);
});
test('model cannot count an explicit unknown answer as resolved',async()=>{
  const turn=await advanceIntake({state:{...emptyIntake(),awaiting:'allergies'},text:'tidak tahu',history:[],model:{extract:async()=>({updates:{allergies:{value:'tidak tahu',evidence:'tidak tahu'}},nextField:null})}});
  expect(turn.state.fields.allergies).toBeUndefined();
  expect(turn.state.awaiting).toBe('allergies');
  expect(turn.state.attempts).toBe(1);
});

test('scripted fallback captures an opening self-introduction before any question is asked',async()=>{
  // emptyIntake has awaiting:null; every scripted branch used to key on it, so
  // "Saya Budi" on turn one was silently dropped in every no-LLM conversation.
  const turn=await advanceIntake({state:emptyIntake(),text:'Saya Budi',history:[]});
  expect(turn.state.fields.name).toBe('Budi');
  expect(turn.state.awaiting).toBe('ageYears');
  expect(turn.usedFallback).toBe(true);
});

test('scripted fallback ignores a complaint-first opener instead of storing it as a name',async()=>{
  const turn=await advanceIntake({state:emptyIntake(),text:'demam 3 hari',history:[]});
  expect(turn.state.fields.name).toBeUndefined();
  expect(turn.state.awaiting).toBe('name');
});

  const base = { state: emptyIntake(), history: [] as { role: 'user' | 'assistant'; content: string }[] };

  test('a valid model reply replaces the fixed question', async () => {
  const turn = await advanceIntake({ ...base, text: 'Saya Budi',
    model: { extract: async () => ({ updates: { name: { value: 'Budi', evidence: 'Saya Budi' } }, nextField: null }),
             respond: async () => 'Oh halo Budi! Boleh tau umurnya berapa, Bi?' } });
  expect(turn.text).toContain('umurnya');
  expect(turn.text).not.toContain('Siapa nama');
});

test('a reply without a question mark falls back to the template', async () => {
  const turn = await advanceIntake({ ...base, text: 'Saya Budi',
    model: { extract: async () => ({ updates: {}, nextField: null }),
             respond: async () => 'Terima kasih ya Budi, senang berkenalan.' } });
  expect(turn.text).toContain('Boleh tahu nama Anda?');
});

test('a reply that gives advice or reassurance is rejected', async () => {
  const mid = { ...emptyIntake(), fields: { name: 'Budi' }, awaiting: 'complaint' as const };
  const turn = await advanceIntake({ state: mid, text: 'perut sakit', history: [],
    model: { extract: async () => ({ updates: {}, nextField: null }),
             respond: async () => 'Jangan khawatir ya, bukan darurat. Sudah minum obat apa belum?' } });
  expect(turn.state.fields.complaint).toBe('perut sakit');
  expect(turn.state.awaiting).toBe('ageYears');
  expect(turn.text).toContain('umur');
  expect(turn.text).not.toContain('Jangan khawatir');
});

test('the completion text is never model-written', async () => {
  const filled = { ...emptyIntake(), fields: { name: 'Budi', ageYears: 62, complaint: 'demam', duration: '3 hari', allergies: 'tidak ada', medications: 'tidak ada' }, awaiting: null, status: 'complete' as const };
  const turn = await advanceIntake({ state: filled, text: 'ok', history: [],
    model: { extract: async () => ({ updates: {}, nextField: null }), respond: async () => 'makasih semua udah lengkap ya?' } });
  expect(turn.text).toBe(COMPLETE_TEXT);
});

test('the human offer rides only on the opening turns', async () => {
  const mid = { ...emptyIntake(), fields: { name: 'Budi', ageYears: 62 }, awaiting: 'complaint' as const };
  const turn = await advanceIntake({ state: mid, text: 'demam', history: [],
    model: { extract: async () => ({ updates: {}, nextField: null }) } });
  expect(turn.text).not.toContain('petugas');
});

test('a bare negation answers allergies and medications without the model',async()=>{
  const base = { ...emptyIntake(), fields: { name: 'Kaka', ageYears: 18, complaint: 'mual', duration: 'kemarin' } };
  const allergies = await advanceIntake({ state: { ...base, awaiting: 'allergies' }, text: 'tidak', history: [],
    model: { extract: async () => ({ updates: {}, nextField: null }) } });
  expect(allergies.state.fields.allergies).toBe('tidak ada');
  expect(allergies.state.awaiting).toBe('medications');
  expect(allergies.state.attempts).toBe(0);
});

test('“belum ada” resolves the current-medication question even when extraction misses it',async()=>{
  const state={...emptyIntake(),fields:{name:'Kaka',ageYears:19,complaint:'demam dan sakit kepala',duration:'sejak kemarin',allergies:'tidak ada'},awaiting:'medications' as const};
  const turn=await advanceIntake({state,text:'belum ada',history:[{role:'assistant',content:'Terakhir, apakah sedang rutin minum obat tertentu?' }],model:{
    extract:async()=>({updates:{},nextField:'medications'}),
    respond:async()=>'Obat apa yang sedang digunakan pasien? Jika tidak ada, tulis “tidak ada”.',
  }});
  expect(turn.state.fields.medications).toBe('tidak ada');
  expect(turn.state.status).toBe('complete');
  expect(turn.text).toBe(COMPLETE_TEXT);
  expect(turn.replyFallbackReason).toBeNull();
});

test('"tidak tahu" stays unresolved on the allergies question',async()=>{
  const base = { ...emptyIntake(), fields: { name: 'Kaka', ageYears: 18, complaint: 'mual', duration: 'kemarin' } };
  const turn = await advanceIntake({ state: { ...base, awaiting: 'allergies', attempts: 2 }, text: 'tidak tahu', history: [],
    model: { extract: async () => ({ updates: {}, nextField: null }) } });
  expect(turn.state.fields.allergies).toBeUndefined();
  expect(turn.state.attempts).toBe(3);
  expect(turn.handoff).toBe(true);
});

test('a bare number answers the age question even when the extractor returns nothing',async()=>{
  const base = { ...emptyIntake(), fields: { name: 'Kaka', complaint: 'pusing', duration: 'kemarin' }, awaiting: 'ageYears' as const };
  const turn = await advanceIntake({ state: base, text: '19 tahun', history: [],
    model: { extract: async () => ({ updates: {}, nextField: null }) } });
  expect(turn.state.fields.ageYears).toBe(19);
  expect(turn.state.awaiting).toBe('allergies');
  expect(turn.state.attempts).toBe(0);
});

test('an out-of-range bare number does not become an age',async()=>{
  const base = { ...emptyIntake(), fields: { name: 'Kaka', complaint: 'pusing', duration: 'kemarin' }, awaiting: 'ageYears' as const };
  const turn = await advanceIntake({ state: base, text: '999', history: [],
    model: { extract: async () => ({ updates: {}, nextField: null }) } });
  expect(turn.state.fields.ageYears).toBeUndefined();
  expect(turn.state.attempts).toBe(1);
});

test('accepts Indonesian repeated-word shorthand without accepting unsupported allergy values',async()=>{
  const state={...emptyIntake(),fields:{name:'Budi',ageYears:19,complaint:'pusing',duration:'kemarin'},awaiting:'allergies' as const};
  const text='alergi obat sih ga ada, tapi alergi kacang2an';
  const turn=await advanceIntake({state,text,history:[],model:{
    extract:async()=>({updates:{allergies:{value:'kacang-kacangan',evidence:'kacang2an'}},nextField:'medications'}),
    respond:async()=>'Oke, alergi kacang-kacangan sudah dicatat. Sekarang sedang minum obat apa?',
  }});
  expect(turn.state.fields.allergies).toBe('kacang-kacangan');
  expect(turn.state.awaiting).toBe('medications');
  expect(turn.text).toContain('Sekarang sedang minum obat apa?');
  expect(turn.replyFallbackReason).toBeNull();
  const unsupported=await advanceIntake({state,text,history:[],model:{extract:async()=>({updates:{allergies:{value:'penisilin',evidence:'kacang2an'}},nextField:null})}});
  expect(unsupported.state.fields.allergies).toBeUndefined();
});

test('an extraction failure can still receive a valid conversational reply',async()=>{
  const turn=await advanceIntake({state:{...emptyIntake(),awaiting:'complaint'},text:'perut saya sakit banget, kayaknya salah makan deh',history:[],model:{
    extract:async()=>{throw new Error('malformed extraction');},
    respond:async()=>'Keluhan sakit perutnya sudah dicatat. Boleh tahu nama pasien?',
  }});
  expect(turn.state.fields.complaint).toBe('perut saya sakit banget, kayaknya salah makan deh');
  expect(turn.state.awaiting).toBe('name');
  expect(turn.usedFallback).toBe(true);
  expect(turn.replyFallbackReason).toBeNull();
  expect(turn.text).toContain('Keluhan sakit perutnya sudah dicatat.');
});

test('reply validation distinguishes medication questions from instructions and checks the pending field',async()=>{
  const {validReply}=await import('./engine');
  expect(validReply('Sekarang sedang minum obat apa?', 'medications')).toBe(true);
  for(const reply of ['Minum obat dulu ya. Siapa nama pasien?', 'Sebaiknya minum obat dulu, sudah minum obat apa?', 'Obat-obatan aman. Sedang konsumsi obat apa?']) {
    expect(validReply(reply)).toBe(false);
  }
  expect(validReply('Alergi sudah dicatat. Sedang konsumsi obat apa?', 'allergies')).toBe(false);
});

test('reply fallback reports validation and provider failures independently of extraction',async()=>{
  const state={...emptyIntake(),awaiting:'name' as const};
  for(const [respond,reason] of [
    [async()=>'Terima kasih.', 'invalid_reply'],
    [async()=>{throw new Error('offline');}, 'provider_failure'],
  ] as const) {
    const turn=await advanceIntake({state,text:'halo',history:[],model:{extract:async()=>({updates:{},nextField:null}),respond}});
    expect(turn.usedFallback).toBe(false);
    expect(turn.replyFallbackReason).toBe(reason);
    expect(turn.text).toContain('Boleh tahu nama Anda?');
  }
});


test('an omitted but clear complaint is retained verbatim, with literal slang duration',async()=>{
  const text='kaki saya sakit dari kemaren, kena paku';
  const turn=await advanceIntake({state:{...emptyIntake(),awaiting:'complaint',attempts:2},text,history:[],model:{extract:async()=>({updates:{},nextField:'complaint'}),respond:async()=>{throw new Error('offline');}}});
  expect(turn.state.fields.complaint).toBe(text);
  expect(turn.state.fields.duration).toBe('dari kemaren');
  expect(turn.state.awaiting).toBe('name');expect(turn.state.attempts).toBe(0);expect(turn.handoff).toBe(false);
  expect(turn.text).toContain('Keluhan Anda sudah dicatat. Boleh tahu nama Anda?');
  expect(turn.text).not.toContain('Apa keluhan utama');
  expect(turn.extractionRecovery?.recoveredFields).toEqual(['complaint','duration']);
});

test('unsupported medical paraphrases recover their supporting patient quote, never an inferred diagnosis or onset',async()=>{
  const text='kaki saya sakit dari kemaren, kena paku';
  const turn=await advanceIntake({state:{...emptyIntake(),awaiting:'complaint'},text,history:[],model:{extract:async()=>({updates:{complaint:{value:'luka tusuk terinfeksi',evidence:text},duration:{value:'1 hari',evidence:'kemaren'}},nextField:null})}});
  expect(turn.state.fields.complaint).toBe(text);expect(turn.state.fields.duration).toBe('kemaren');
  expect(turn.state.fields.complaint).not.toContain('terinfeksi');
  expect(turn.extractionRecovery?.rejectedFields).toEqual(['complaint','duration']);
});

test('existing unresolved visits recover patient history and retain new injury detail without a false handoff',async()=>{
  const text='di telapak kaki saya deket jempol kaki, sekarang perih banget, udah saya cuci';
  const turn=await advanceIntake({state:{...emptyIntake(),awaiting:'complaint',attempts:2},text,
    history:[{role:'user',content:'halo'},{role:'assistant',content:'Boleh cerita keluhannya?'},{role:'user',content:'kaki saya sakit dari kemaren, kena paku'},{role:'assistant',content:'Sakitnya di bagian mana?'}],
    model:{extract:async()=>({updates:{},nextField:null})}});
  expect(turn.state.fields.complaint).toContain('kena paku');expect(turn.state.fields.complaint).toContain('deket jempol');
  expect(turn.state.fields.duration).toBe('dari kemaren');expect(turn.state.attempts).toBe(0);expect(turn.handoff).toBe(false);
  expect(turn.extractionRecovery?.fromHistory).toBe(true);
});

test('additional supported symptom details preserve the original complaint and count as progress while awaiting identity',async()=>{
  const original='kaki saya sakit dari kemaren, kena paku';const text='telapak kaki perih dekat jempol';
  const turn=await advanceIntake({state:{...emptyIntake(),fields:{complaint:original,duration:'dari kemaren'},awaiting:'name',attempts:2},text,history:[],
    model:{extract:async()=>({updates:{},nextField:null})}});
  expect(turn.state.fields.complaint).toContain(original);expect(turn.state.fields.complaint).toContain(text);
  expect(turn.state.fields.name).toBeUndefined();expect(turn.state.awaiting).toBe('name');expect(turn.state.attempts).toBe(0);expect(turn.handoff).toBe(false);
});

test('greetings, unknown answers, bot examples and medication duration do not fabricate complaint facts',async()=>{
  for(const text of ['halo','???','tidak tahu']) {
    const turn=await advanceIntake({state:{...emptyIntake(),awaiting:'complaint'},text,history:[{role:'assistant',content:'Contoh: kaki sakit dari kemaren, kena paku'}],model:{extract:async()=>({updates:{},nextField:null})}});
    expect(turn.state.fields.complaint).toBeUndefined();expect(turn.state.fields.duration).toBeUndefined();expect(turn.state.attempts).toBe(1);
  }
  const meds=await advanceIntake({state:{...emptyIntake(),fields:{complaint:'batuk'},awaiting:'medications'},text:'minum obat sudah 3 hari',history:[],model:{extract:async()=>({updates:{},nextField:null})}});
  expect(meds.state.fields.duration).toBeUndefined();
});
