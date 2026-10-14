import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "../contracts";
import { createDecisionModelClient, type DecisionModelConfig } from "./client";
import { DecisionModelError } from "./types";

const MSG: InboundMessage = {
  phone: "628123456789",
  text: "sesak napas berat",
  providerMessageId: "ABC",
  receivedAt: new Date("2026-10-14T10:00:00Z"),
  kind: "text",
};

const CONFIG: DecisionModelConfig = {
  endpoint: "https://openrouter.ai/api/v1/systemone",
  apiKey: "test-key",
  slots: [
    { id: "perplexity/pplx-decider-v1.1-27b", cutoff: 0.15, urgencyCeiling: 4 },
    { id: "typesafe/jev-1.13", cutoff: 0.31, urgencyCeiling: 3 },
  ],
};

const WITH_TERTIARY: DecisionModelConfig = {
  ...CONFIG,
  slots: [
    ...CONFIG.slots,
    { id: "cloudflare/clef-27b", cutoff: 0.11, urgencyCeiling: 2 },
  ],
};

/** A realistic System One response body. */
function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "gen-1750000000-abc",
    // Note the dated id: it will NOT match the configured slot.
    model: "perplexity/pplx-decider-v1.1-27b-20251014",
    provider: "perplexity",
    answers: {
      urgency: { type: "score", score: 3.41, confidence: 0.8 },
      clarity: { type: "choice", choice: "crystal_clear", confidence: 0.9 },
      red_flag: { type: "noul", noul: 0.9 },
      red_flag_informal: { type: "noul", noul: 0.5 },
      wants_human: { type: "noul", noul: 0.02 },
      category: { type: "choice", choice: "breathing", confidence: 0.7 },
      ...overrides,
    },
    usage: { cost: 0.0012, input_tokens: 180, output_tokens: 40 },
  });
}

interface Recorded {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Serves the given responses in order, recording every call. */
function recordingFetch(responses: Array<() => Response>): {
  fetchImpl: typeof fetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  let index = 0;

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });

    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (!next) throw new Error("recordingFetch ran out of responses");
    return next();
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

const ok = (payload: string) => () => new Response(payload, { status: 200 });
const fail = (status: number) => () => new Response("upstream exploded", { status });

describe("createDecisionModelClient", () => {
  test("answers from the primary slot", async () => {
    const { fetchImpl, calls } = recordingFetch([ok(body())]);

    const decision = await createDecisionModelClient(CONFIG, fetchImpl).decide(MSG);

    expect(decision.redFlag).toBe(0.9);
    expect(decision.urgency).toBeCloseTo(3.41);
    expect(decision.clarity).toBe("crystal_clear");
    expect(decision.category).toBe("breathing");
    expect(decision.source).toBe("decision_model");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(CONFIG.endpoint);
  });

  test("records the requested slug, not the dated one the provider echoes", async () => {
    const { fetchImpl } = recordingFetch([ok(body())]);

    const decision = await createDecisionModelClient(CONFIG, fetchImpl).decide(MSG);

    // The cutoff is looked up by this id. A dated id would match no slot and
    // silently fall back to the primary's threshold.
    expect(decision.model).toBe("perplexity/pplx-decider-v1.1-27b");
  });

  test("sends the bearer token and the slot slug", async () => {
    const { fetchImpl, calls } = recordingFetch([ok(body())]);

    await createDecisionModelClient(CONFIG, fetchImpl).decide(MSG);

    expect(calls[0]?.headers.authorization).toBe("Bearer test-key");
    expect(calls[0]?.body.model).toBe("perplexity/pplx-decider-v1.1-27b");
  });

  test("asks all six questions against the patient message", async () => {
    const { fetchImpl, calls } = recordingFetch([ok(body())]);

    await createDecisionModelClient(CONFIG, fetchImpl).decide(MSG);

    const state = calls[0]?.body.state as { message: string };
    const questions = calls[0]?.body.questions as Record<string, { type: string }>;

    expect(state.message).toBe("sesak napas berat");
    expect(Object.keys(questions).sort()).toEqual([
      "category",
      "clarity",
      "red_flag",
      "red_flag_informal",
      "urgency",
      "wants_human",
    ]);
    expect(questions.urgency?.type).toBe("score");
    expect(questions.red_flag?.type).toBe("noul");
    expect(questions.clarity?.type).toBe("choice");
  });

  test("keeps a weighted urgency score rather than rounding it", async () => {
    const { fetchImpl } = recordingFetch([
      ok(body({ urgency: { type: "score", score: 2.44 } })),
    ]);

    expect((await createDecisionModelClient(CONFIG, fetchImpl).decide(MSG)).urgency).toBeCloseTo(
      2.44,
    );
  });

  test("clamps urgency to the slot's ceiling", async () => {
    // The fallback slot is allowed at most 3, whatever it claims.
    const { fetchImpl } = recordingFetch([fail(502), ok(body())]);

    const decision = await createDecisionModelClient(CONFIG, fetchImpl).decide(MSG);

    expect(decision.model).toBe("typesafe/jev-1.13");
    expect(decision.urgency).toBe(3);
  });

  test("treats an unrecognised clarity option as ambiguous", async () => {
    const { fetchImpl } = recordingFetch([
      ok(body({ clarity: { type: "choice", choice: "some_new_option" } })),
    ]);

    expect((await createDecisionModelClient(CONFIG, fetchImpl).decide(MSG)).clarity).toBe(
      "ambiguous",
    );
  });

  test("falls back to the next slot when the primary errors", async () => {
    const { fetchImpl, calls } = recordingFetch([fail(502), ok(body())]);

    const decision = await createDecisionModelClient(CONFIG, fetchImpl).decide(MSG);

    expect(decision.model).toBe("typesafe/jev-1.13");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body.model).toBe("typesafe/jev-1.13");
  });

  test("falls back when the primary returns a body that is not System One", async () => {
    const { fetchImpl, calls } = recordingFetch([
      ok(JSON.stringify({ choices: [{ message: { content: "{}" } }] })),
      ok(body()),
    ]);

    expect((await createDecisionModelClient(CONFIG, fetchImpl).decide(MSG)).model).toBe(
      "typesafe/jev-1.13",
    );
    expect(calls).toHaveLength(2);
  });

  test("falls back when the primary omits a safety-critical answer", async () => {
    // red_flag is the answer the escalation decision turns on. Absent means the
    // response cannot be trusted, not that it defaults to zero.
    const missingRedFlag = JSON.stringify({
      answers: {
        urgency: { type: "score", score: 0 },
        clarity: { type: "choice", choice: "crystal_clear" },
        wants_human: { type: "noul", noul: 0 },
      },
    });
    const { fetchImpl, calls } = recordingFetch([ok(missingRedFlag), ok(body())]);

    expect((await createDecisionModelClient(CONFIG, fetchImpl).decide(MSG)).model).toBe(
      "typesafe/jev-1.13",
    );
    expect(calls).toHaveLength(2);
  });

  test("walks to the tertiary slot when both others fail", async () => {
    const { fetchImpl, calls } = recordingFetch([fail(500), fail(500), ok(body())]);

    const decision = await createDecisionModelClient(WITH_TERTIARY, fetchImpl).decide(MSG);

    expect(decision.model).toBe("cloudflare/clef-27b");
    expect(calls).toHaveLength(3);
  });

  test("throws DecisionModelError when every slot fails", async () => {
    const { fetchImpl } = recordingFetch([fail(500), fail(500)]);

    await expect(createDecisionModelClient(CONFIG, fetchImpl).decide(MSG)).rejects.toThrow(
      DecisionModelError,
    );
  });

  test("names every failed slot in the error", async () => {
    const { fetchImpl } = recordingFetch([fail(500), fail(503)]);

    await expect(createDecisionModelClient(CONFIG, fetchImpl).decide(MSG)).rejects.toThrow(
      /pplx-decider-v1\.1-27b.*jev-1\.13/s,
    );
  });

  test("throws DecisionModelError when the network itself fails", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    await expect(createDecisionModelClient(CONFIG, failing).decide(MSG)).rejects.toThrow(
      DecisionModelError,
    );
  });
});
