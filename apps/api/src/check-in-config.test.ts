import { test, expect } from 'bun:test';
import { parseCheckInOptions } from './check-in-config';
test('check-in defaults follow PRD and accept bounded overrides',()=>{
  expect(parseCheckInOptions({})).toEqual({intervalMinutes:45,maxReminders:3});
  expect(parseCheckInOptions({CHECK_IN_INTERVAL_MINUTES:'1',CHECK_IN_MAX_REMINDERS:'2'})).toEqual({intervalMinutes:1,maxReminders:2});
});
test('invalid check-in settings fail startup',()=>{
  for(const value of ['0','-1','1441','1e308','Infinity','nan']) expect(()=>parseCheckInOptions({CHECK_IN_INTERVAL_MINUTES:value})).toThrow();
  for(const value of ['0','-1','11','1.5','Infinity','nan']) expect(()=>parseCheckInOptions({CHECK_IN_MAX_REMINDERS:value})).toThrow();
});
