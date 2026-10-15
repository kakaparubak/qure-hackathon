import { expect, test } from 'bun:test';
import { advanceIntake, emptyIntake, type IntakeModel } from './engine';
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
