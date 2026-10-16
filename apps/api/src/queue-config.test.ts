import { expect, test } from "bun:test";
import { parseQueueServiceMinutes } from "./wiring";

test("queue ETA has no guessed default and accepts positive service intervals", () => {
  expect(parseQueueServiceMinutes(undefined)).toBeUndefined();
  expect(parseQueueServiceMinutes("")).toBeUndefined();
  expect(parseQueueServiceMinutes(" 4.5 ")).toBe(4.5);
});

test("invalid service intervals fail startup without echoing configuration", () => {
  for (const value of ["0", "-1", "Infinity", "NaN", "secret-value"]) {
    expect(() => parseQueueServiceMinutes(value)).toThrow("QUEUE_SERVICE_MINUTES must be a finite positive number");
  }
});

test('callback timing has explicit defaults and rejects malformed overrides',async()=>{
  const {parseQueueOptions}=await import('./wiring');
  expect(parseQueueOptions({})).toEqual({serviceMinutes:undefined,callbackDelayMinutes:60,callbackSpacingMinutes:10});
  expect(parseQueueOptions({QUEUE_CALLBACK_DELAY_MINUTES:'30',QUEUE_CALLBACK_SPACING_MINUTES:'5'}).callbackDelayMinutes).toBe(30);
  for(const value of ['0','-1','NaN','Infinity']) {
    expect(()=>parseQueueOptions({QUEUE_CALLBACK_DELAY_MINUTES:value})).toThrow('QUEUE_CALLBACK_DELAY_MINUTES');
    expect(()=>parseQueueOptions({QUEUE_CALLBACK_SPACING_MINUTES:value})).toThrow('QUEUE_CALLBACK_SPACING_MINUTES');
  }
});
