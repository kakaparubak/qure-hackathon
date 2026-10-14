import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "../contracts";
import { QUESTIONS, buildRequest, parseDecision } from "./schema";
import { DecisionModelError } from "./types";

const MSG: InboundMessage = {
  phone: "628123456789",
  text: "nyeri dada sejak tadi malam",
  providerMessageId: "ABC",
  receivedAt: new Date("2026-10-14T10:00:00Z"),
  kind: "text",
};

const PARSE = { requestedModelId: "perplexity/pplx-decider-v1.1-27b", urgencyCeiling: 4 };

function response(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "gen-1",
    model: "perplexity/pplx-decider-v1.1-27b-20251014",
    provider: "perplexity",
    answers: {
      urgency: { type: "score", score: 3.41, confidence: 0.8 },
      clarity: { type: "choice", choice: "mostly_clear" },
      red_flag: { type: "noul", noul: 0.9 },
      red_flag_informal: { type: "noul", noul: 0.44 },
      wants_human: { type: "noul", noul: 0.02 },
      category: { type: "choice", choice: "chest_cardiac" },
      ...overrides,
    },
    usage: { cost: 0.0012, input_tokens: 180, output_tokens: 40 },
  };
}

describe("buildRequest", () => {
  test("carries the model slug and the patient message as state", () => {
    const request = buildRequest("perplexity/pplx-decider-v1.1-27b", MSG);

    expect(request.model).toBe("perplexity/pplx-decider-v1.1-27b");
    expect(request.state.message).toBe("nyeri dada sejak tadi malam");
  });

  test("asks exactly the six questions", () => {
    expect(Object.keys(QUESTIONS).sort()).toEqual([
      "category",
      "clarity",
      "red_flag",
      "red_flag_informal",
      "urgency",
      "wants_human",
    ]);
  });

  test("uses the provider's three question types", () => {
    expect(QUESTIONS.urgency.type).toBe("score");
    expect(QUESTIONS.clarity.type).toBe("choice");
    expect(QUESTIONS.category.type).toBe("choice");
    expect(QUESTIONS.red_flag.type).toBe("noul");
    expect(QUESTIONS.red_flag_informal.type).toBe("noul");
    expect(QUESTIONS.wants_human.type).toBe("noul");
  });

  test("the urgency scale has five ordered levels", () => {
    expect(QUESTIONS.urgency.criteria).toHaveLength(5);
  });

  test("a noul question describes both the true and the false case", () => {
    expect(Object.keys(QUESTIONS.red_flag.criteria).sort()).toEqual(["false", "true"]);
  });

  test("every choice question offers an option per allowed value", () => {
    expect(Object.keys(QUESTIONS.clarity.criteria)).toHaveLength(4);
    expect(Object.keys(QUESTIONS.category.criteria)).toHaveLength(10);
    expect(QUESTIONS.clarity.criteria.crystal_clear).toBeDefined();
    expect(QUESTIONS.category.criteria.chest_cardiac).toBeDefined();
  });

  test("every question carries instructions", () => {
    for (const question of Object.values(QUESTIONS)) {
      expect(question.instructions.length).toBeGreaterThan(20);
    }
  });
});

describe("parseDecision", () => {
  test("maps the six answers onto a Decision", () => {
    const decision = parseDecision(response(), PARSE);

    expect(decision.urgency).toBeCloseTo(3.41);
    expect(decision.urgencyConfidence).toBeCloseTo(0.8);
    expect(decision.clarity).toBe("mostly_clear");
    expect(decision.redFlag).toBe(0.9);
    expect(decision.redFlagInformal).toBeCloseTo(0.44);
    expect(decision.wantsHuman).toBe(0.02);
    expect(decision.category).toBe("chest_cardiac");
  });

  test("records the requested slug, not the dated one echoed back", () => {
    // The cutoff is looked up by model id, so the dated id would miss its slot.
    expect(parseDecision(response(), PARSE).model).toBe("perplexity/pplx-decider-v1.1-27b");
  });

  test("marks the source as the decision model and leaves the floor's fields empty", () => {
    const decision = parseDecision(response(), PARSE);

    expect(decision.source).toBe("decision_model");
    expect(decision.matchedFamily).toBeNull();
  });

  test("keeps the raw body for the audit trail", () => {
    const body = response();

    expect(parseDecision(body, PARSE).raw).toBe(body);
  });

  test("clamps urgency to the slot ceiling", () => {
    expect(parseDecision(response(), { ...PARSE, urgencyCeiling: 2 }).urgency).toBe(2);
  });

  test("clamps a negative score up to zero", () => {
    const body = response({ urgency: { type: "score", score: -0.4 } });

    expect(parseDecision(body, PARSE).urgency).toBe(0);
  });

  test("treats an unrecognised clarity option as ambiguous", () => {
    const body = response({ clarity: { type: "choice", choice: "totally_new" } });

    expect(parseDecision(body, PARSE).clarity).toBe("ambiguous");
  });

  test("treats an unrecognised category as unclassified", () => {
    const body = response({ category: { type: "choice", choice: "neuro" } });

    expect(parseDecision(body, PARSE).category).toBeNull();
  });

  test("a missing category is null, not an error", () => {
    const body = response({ category: undefined });

    expect(parseDecision(body, PARSE).category).toBeNull();
  });

  test("a missing red_flag_informal is null", () => {
    const body = response({ red_flag_informal: undefined });

    expect(parseDecision(body, PARSE).redFlagInformal).toBeNull();
  });

  test("throws when red_flag is absent", () => {
    // The escalation decision turns on this answer. Absent is not "no".
    expect(() => parseDecision(response({ red_flag: undefined }), PARSE)).toThrow(
      DecisionModelError,
    );
  });

  test("throws when wants_human is absent", () => {
    expect(() => parseDecision(response({ wants_human: undefined }), PARSE)).toThrow(
      DecisionModelError,
    );
  });

  test("throws when urgency is absent", () => {
    expect(() => parseDecision(response({ urgency: undefined }), PARSE)).toThrow(
      DecisionModelError,
    );
  });

  test("throws when an answer carries the wrong type discriminant", () => {
    const body = response({ red_flag: { type: "noul", choice: "yes" } });

    expect(() => parseDecision(body, PARSE)).toThrow(DecisionModelError);
  });

  test("throws when a probability is out of range", () => {
    const body = response({ red_flag: { type: "noul", noul: 1.4 } });

    expect(() => parseDecision(body, PARSE)).toThrow(DecisionModelError);
  });

  test("throws on a chat-completions body", () => {
    // The shape this codebase was first written against. It must not parse.
    const legacy = { choices: [{ message: { content: '{"red_flag":0.9}' } }] };

    expect(() => parseDecision(legacy, PARSE)).toThrow(DecisionModelError);
  });

  test("throws on null", () => {
    expect(() => parseDecision(null, PARSE)).toThrow(DecisionModelError);
  });
});
