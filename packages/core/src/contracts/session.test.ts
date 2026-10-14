import { describe, expect, test } from "bun:test";
import { ALLOWED_TRANSITIONS, type SessionStatus } from "./session";

const ALL_STATUSES: SessionStatus[] = [
  "triaging",
  "waiting",
  "escalated",
  "green_lane",
  "served",
  "closed",
];

describe("ALLOWED_TRANSITIONS", () => {
  test("covers every session status", () => {
    for (const status of ALL_STATUSES) {
      expect(ALLOWED_TRANSITIONS[status]).toBeDefined();
    }
    expect(Object.keys(ALLOWED_TRANSITIONS).sort()).toEqual([...ALL_STATUSES].sort());
  });

  test("closed is terminal", () => {
    expect(ALLOWED_TRANSITIONS.closed).toEqual([]);
  });

  test("rejects transitions into a terminal state from closed/served", () => {
    // illegal: a finished session must never re-enter the queue
    expect(ALLOWED_TRANSITIONS.closed).not.toContain("waiting");
    expect(ALLOWED_TRANSITIONS.served).not.toContain("waiting");
    expect(ALLOWED_TRANSITIONS.escalated).not.toContain("waiting");
    expect(ALLOWED_TRANSITIONS.green_lane).not.toContain("waiting");
  });

  test("no status can transition back into waiting (no queue resurrection)", () => {
    for (const status of ALL_STATUSES) {
      if (status === "triaging") continue;
      expect(ALLOWED_TRANSITIONS[status]).not.toContain("waiting");
    }
  });

  test("deterioration while queueing can escalate", () => {
    // this edge is the whole point of the check-in loop
    expect(ALLOWED_TRANSITIONS.waiting).toContain("escalated");
  });

  test("triaging can escalate directly (red-flag floor short-circuit)", () => {
    expect(ALLOWED_TRANSITIONS.triaging).toContain("escalated");
  });

  test("only lists known statuses as targets", () => {
    for (const status of ALL_STATUSES) {
      for (const target of ALLOWED_TRANSITIONS[status]) {
        expect(ALL_STATUSES).toContain(target);
      }
    }
  });
});
