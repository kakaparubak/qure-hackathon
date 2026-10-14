import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "../contracts";
import { createDecisionModelClient } from "./client";
import { DecisionModelError } from "./types";

const MSG: InboundMessage = {
  phone: "628123456789",
  text: "sesak napas berat",
  providerMessageId: "ABC",
  receivedAt: new Date("2026-10-14T10:00:00Z"),
  kind: "text",
};

const CONFIG = {
  endpoint: "https://example.test/v1/chat/completions",
  apiKey: "test-key",
  primaryId: "pplx-decider-v1.1",
  fallbackId: "jev-1.13",
};

const GOOD = { red_flag: 0.9, wants_human: 0, urgency: 4 };

function body(answers: Record<string, unknown>): string {
  return JSON.stringify({ choices: [{ message: { content: JSON.stringify(answers) } }] });
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

describe("createDecisionModelClient", () => {
  test("answers from the primary model", async () => {
    const { fetchImpl, calls } = recordingFetch([
      () => new Response(body(GOOD), { status: 200 }),
    ]);

    const decision = await createDecisionModelClient(CONFIG, fetchImpl).decide(MSG);

    expect(decision.model).toBe("pplx-decider-v1.1");
    expect(decision.redFlag).toBe(0.9);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(CONFIG.endpoint);
  });

  test("sends the bearer token and the primary slug", async () => {
    const { fetchImpl, calls } = recordingFetch([
      () => new Response(body(GOOD), { status: 200 }),
    ]);

    await createDecisionModelClient(CONFIG, fetchImpl).decide(MSG);

    expect(calls[0]?.headers.authorization).toBe("Bearer test-key");
    expect(calls[0]?.body.model).toBe("pplx-decider-v1.1");
  });

  test("passes the patient text through as the user turn", async () => {
    const { fetchImpl, calls } = recordingFetch([
      () => new Response(body(GOOD), { status: 200 }),
    ]);

    await createDecisionModelClient(CONFIG, fetchImpl).decide(MSG);

    const messages = calls[0]?.body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]).toEqual({ role: "user", content: "sesak napas berat" });
  });

  test("falls back to the secondary model when the primary errors", async () => {
    const { fetchImpl, calls } = recordingFetch([
      () => new Response("upstream exploded", { status: 502 }),
      () => new Response(body(GOOD), { status: 200 }),
    ]);

    const decision = await createDecisionModelClient(CONFIG, fetchImpl).decide(MSG);

    expect(decision.model).toBe("jev-1.13");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body.model).toBe("jev-1.13");
  });

  test("falls back when the primary returns an unusable body", async () => {
    const { fetchImpl, calls } = recordingFetch([
      () => new Response(JSON.stringify({ choices: [] }), { status: 200 }),
      () => new Response(body(GOOD), { status: 200 }),
    ]);

    expect((await createDecisionModelClient(CONFIG, fetchImpl).decide(MSG)).model).toBe("jev-1.13");
    expect(calls).toHaveLength(2);
  });

  test("throws DecisionModelError when both models fail", async () => {
    const { fetchImpl } = recordingFetch([
      () => new Response("nope", { status: 500 }),
      () => new Response("nope", { status: 500 }),
    ]);

    await expect(createDecisionModelClient(CONFIG, fetchImpl).decide(MSG)).rejects.toThrow(
      DecisionModelError,
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
