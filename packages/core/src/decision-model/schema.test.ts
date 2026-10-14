import { describe, expect, test } from "bun:test";
import { parseDecision } from "./schema";
import { DecisionModelError } from "./types";

const PROVIDER_BODY = {
  choices: [
    {
      message: {
        content: JSON.stringify({
          urgency: 3.41,
          urgency_confidence: 0.82,
          clarity: "mostly_clear",
          red_flag: 0.09,
          red_flag_informal: 0.12,
          wants_human: 0.05,
          category: "fever_infection",
        }),
      },
    },
  ],
};

describe("parseDecision", () => {
  test("maps a provider body onto Decision", () => {
    const decision = parseDecision(PROVIDER_BODY, "pplx-decider-v1.1");

    expect(decision.source).toBe("decision_model");
    expect(decision.model).toBe("pplx-decider-v1.1");
    expect(decision.urgency).toBe(3.41);
    expect(decision.clarity).toBe("mostly_clear");
    expect(decision.redFlag).toBe(0.09);
    expect(decision.category).toBe("fever_infection");
    expect(decision.matchedFamily).toBeNull();
    expect(decision.raw).toBe(PROVIDER_BODY);
  });

  test("accepts content wrapped in a markdown fence", () => {
    const fenced = {
      choices: [{ message: { content: '```json\n{"red_flag":0.4,"wants_human":0.1}\n```' } }],
    };

    expect(parseDecision(fenced, "m").redFlag).toBe(0.4);
  });

  test("defaults absent optional fields to null", () => {
    const sparse = { choices: [{ message: { content: '{"red_flag":0.2,"wants_human":0}' } }] };
    const decision = parseDecision(sparse, "m");

    expect(decision.urgency).toBeNull();
    expect(decision.clarity).toBeNull();
    expect(decision.category).toBeNull();
  });

  test("rejects a body with no choices", () => {
    expect(() => parseDecision({}, "m")).toThrow(DecisionModelError);
  });

  test("rejects content that is not JSON", () => {
    const bad = { choices: [{ message: { content: "I cannot answer that." } }] };

    expect(() => parseDecision(bad, "m")).toThrow(DecisionModelError);
  });

  test("rejects a red_flag outside 0..1", () => {
    const bad = { choices: [{ message: { content: '{"red_flag":7,"wants_human":0}' } }] };

    expect(() => parseDecision(bad, "m")).toThrow(DecisionModelError);
  });

  test("rejects an unknown clarity value", () => {
    const bad = {
      choices: [{ message: { content: '{"red_flag":0.1,"wants_human":0,"clarity":"vibes"}' } }],
    };

    expect(() => parseDecision(bad, "m")).toThrow(DecisionModelError);
  });
});
