import { test, expect } from 'bun:test';
import { emergencyReply, validatePlan, allowedActions, EMERGENCY_ROUTE } from './engine';
const input={text:'apa yang bisa saya lakukan?',families:['cardiac'] as const,history:[]};
const cardiac={...input,families:[...input.families]};
test('emergency support renders selected guidance with unconditional direct-help routing',async()=>{
  const result=await emergencyReply(cardiac,{plan:async()=>({actionIds:['rest'],questionId:'companion'})});
  expect(result.text.startsWith(EMERGENCY_ROUTE)).toBe(true);
  expect(result.text).toContain('Hentikan aktivitas');
  expect(result.text).toContain('Apakah ada orang');
  expect(result.audit.usedFallback).toBe(false);
});
test('family context constrains advice and multiple families use common guidance only',()=>{
  expect(allowedActions(['bleeding_trauma'])).toContain('pressure');
  expect(allowedActions(['cardiac'])).not.toContain('pressure');
  expect(allowedActions(['cardiac','bleeding_trauma'])).not.toContain('rest');
  expect(allowedActions([])).not.toContain('rest');
  expect(()=>validatePlan({actionIds:['pressure'],questionId:null},['cardiac'])).toThrow();
});
test('free clinical prose, invented IDs and duplicate actions cannot pass validation',async()=>{
  for(const plan of [
    {actionIds:['rest'],questionId:null,text:'Anda aman, minum aspirin 500mg'},
    {actionIds:['prescribe'],questionId:null},
    {actionIds:['rest','rest'],questionId:null},
    {actionIds:['pressure'],questionId:null},
  ]) {
    const result=await emergencyReply(cardiac,{plan:async()=>plan});
    expect(result.audit.usedFallback).toBe(true);
    expect(result.text).not.toMatch(/500mg|Anda aman|prescribe/);
    expect(result.text).toContain('119 sekarang');
  }
});
test('provider outage and missing model still produce help',async()=>{
  for(const model of [undefined,{plan:async()=>{throw new Error('down');}}]) {
    const result=await emergencyReply(cardiac,model);
    expect(result.audit.usedFallback).toBe(true);
    expect(result.text).toContain('Minta orang terdekat');
  }
});
test('medicine and improvement questions get deterministic boundaries even if model ignores request',async()=>{
  const model={plan:async()=>({actionIds:['rest'],questionId:null})};
  const meds=await emergencyReply({...cardiac,text:'boleh minum obat apa dan dosisnya berapa?'},model);
  expect(meds.audit.actionIds).toEqual(['medication']);
  expect(meds.text).toContain('tidak dapat menentukan obat atau dosis');
  const better=await emergencyReply({...cardiac,text:'sudah mendingan, saya aman?'},model);
  expect(better.audit.actionIds).toEqual(['diagnosis']);
  expect(better.text).toContain('meskipun terasa membaik');
});

test('no staff or failed emergency call gets a direct alternative even without a model',async()=>{
  for(const text of ['tidak ada petugas','saya sendirian','119 tidak tersambung']) {
    const reply=await emergencyReply({...cardiac,text});
    expect(reply.audit.actionIds).toEqual(['unavailable','companion']);
    expect(reply.text).toContain('IGD terdekat');
    expect(reply.text).not.toContain('sudah dikirim. Tunggu');
  }
});
