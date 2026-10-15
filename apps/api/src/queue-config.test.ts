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
