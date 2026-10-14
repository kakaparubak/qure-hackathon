# WhatsApp ↔ decision-model pipeline — implementation plan

> **PARTLY SUPERSEDED.** This plan shipped the thin slice, but three of its
> assumptions turned out to be wrong and the PRD's red-flag floor was missing
> from it. Read the design spec's "Changes made while implementing this spec"
> before following anything below: the wire format is System One rather than
> chat completions, the floor now runs first, and escalation text comes from
> `reply/playbooks.ts`. Kept as a record of what was planned, not as current
> instructions.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A real WhatsApp message reaches the decision model and gets a Bahasa Indonesia reply sent back, with the pipeline also driveable by `curl` so it is provable without a linked phone.

**Architecture:** One Bun process. `BaileysChannel` and `POST /webhook/inbound` both feed the same orchestrator; the orchestrator owns dedup, the model call, and the failure rule. The model and the channel are each behind an interface, so the orchestrator tests run offline against fakes.

**Tech Stack:** Bun, TypeScript strict, Fastify, zod, Drizzle (unused tonight), Baileys, OpenRouter System One.

**Spec:** `docs/superpowers/specs/2026-10-14-whatsapp-llm-pipeline-design.md`

---

## File structure

| File | Responsibility |
|---|---|
| `packages/core/src/config.ts` | Read + validate env once, fail fast |
| `packages/core/src/config.test.ts` | env validation cases |
| `packages/core/src/decision-model/types.ts` | `DecisionModel` interface + `DecisionModelError` |
| `packages/core/src/decision-model/schema.ts` | zod schema for the provider payload, mapped to `Decision` |
| `packages/core/src/decision-model/schema.test.ts` | mapping + rejection cases |
| `packages/core/src/decision-model/client.ts` | HTTP impl, primary then fallback |
| `packages/core/src/decision-model/client.test.ts` | fallback + error cases against a stub fetch |
| `packages/core/src/decision-model/fake.ts` | `FakeDecisionModel` |
| `packages/core/src/channel/fake.ts` | `FakeChannel` (captures sends) |
| `packages/core/src/channel/rate-limit.ts` | per-phone min-interval outbound gate |
| `packages/core/src/channel/rate-limit.test.ts` | gate cases |
| `packages/core/src/channel/whatsapp.ts` | Baileys impl of `WhatsAppChannel` |
| `packages/core/src/reply/templates.ts` | Decision → Bahasa text |
| `packages/core/src/reply/templates.test.ts` | template selection per branch |
| `packages/core/src/triage/orchestrator.ts` | dedup → decide → template |
| `packages/core/src/triage/orchestrator.test.ts` | happy path, dedup, failure escalation |
| `apps/api/src/routes/webhook.ts` | `POST /webhook/inbound` |
| `apps/api/src/app.ts` | modify: accept deps, register route |
| `apps/api/src/app.test.ts` | modify: health test + webhook test |
| `apps/api/src/wiring.ts` | composition root, reads config |

Each file has one job. `whatsapp.ts` is the only file that imports Baileys; `client.ts` is the only one that does network I/O.

---

### Task 1: Config loader

**Files:**
- Create: `packages/core/src/config.ts`
- Test: `packages/core/src/config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config";

const VALID_ENV: Record<string, string> = {
  OPENROUTER_ENDPOINT: "https://example.test/v1/chat/completions",
  OPENROUTER_API_KEY: "test-key",
  MODEL_PRIMARY_ID: "pplx-decider-v1.1",
  MODEL_FALLBACK_ID: "jev-1.13",
  RED_FLAG_CUTOFF_PRIMARY: "0.15",
  RED_FLAG_CUTOFF_FALLBACK: "0.31",
  PORT: "3000",
};

describe("loadConfig", () => {
  test("parses a complete environment", () => {
    const config = loadConfig(VALID_ENV);

    expect(config.model.endpoint).toBe("https://example.test/v1/chat/completions");
    expect(config.model.primaryId).toBe("pplx-decider-v1.1");
    expect(config.model.cutoffPrimary).toBe(0.15);
    expect(config.model.cutoffFallback).toBe(0.31);
    expect(config.port).toBe(3000);
    expect(config.whatsapp).toBeNull();
  });

  test("names every missing variable at once", () => {
    expect(() => loadConfig({})).toThrow(/OPENROUTER_ENDPOINT/);
    expect(() => loadConfig({})).toThrow(/OPENROUTER_API_KEY/);
  });

  test("rejects a cutoff outside 0..1", () => {
    expect(() => loadConfig({ ...VALID_ENV, RED_FLAG_CUTOFF_PRIMARY: "1.4" })).toThrow(
      /RED_FLAG_CUTOFF_PRIMARY/,
    );
  });

  test("rejects a non-numeric cutoff", () => {
    expect(() => loadConfig({ ...VALID_ENV, RED_FLAG_CUTOFF_FALLBACK: "abc" })).toThrow(
      /RED_FLAG_CUTOFF_FALLBACK/,
    );
  });

  test("whatsapp is null when not enabled", () => {
    expect(loadConfig(VALID_ENV).whatsapp).toBeNull();
  });

  test("whatsapp requires a pairing number when enabled", () => {
    expect(() => loadConfig({ ...VALID_ENV, WA_ENABLED: "true" })).toThrow(/WA_PAIRING_NUMBER/);
  });

  test("whatsapp carries the pairing number when enabled", () => {
    const config = loadConfig({ ...VALID_ENV, WA_ENABLED: "true", WA_PAIRING_NUMBER: "628123456789" });

    expect(config.whatsapp).toEqual({ pairingNumber: "628123456789", authDir: ".baileys" });
  });

  test("rejects a pairing number that is not digits", () => {
    expect(() =>
      loadConfig({ ...VALID_ENV, WA_ENABLED: "true", WA_PAIRING_NUMBER: "+62812" }),
    ).toThrow(/WA_PAIRING_NUMBER/);
  });

  test("defaults the port when unset", () => {
    const { PORT: _port, ...withoutPort } = VALID_ENV;

    expect(loadConfig(withoutPort).port).toBe(3000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/config.test.ts`
Expected: FAIL — "Cannot find module './config'"

- [ ] **Step 3: Write the implementation**

```ts
/**
 * Environment loading for the API process.
 *
 * Read once, at boot, so a missing or malformed value produces a named error
 * here rather than an `undefined` travelling into a fetch three calls deep.
 */

export interface ModelConfig {
  /** Full URL of the chat-completions endpoint, path included. */
  endpoint: string;
  apiKey: string;
  primaryId: string;
  fallbackId: string;
  cutoffPrimary: number;
  cutoffFallback: number;
}

export interface WhatsAppConfig {
  /** E.164 digits, no leading '+'. */
  pairingNumber: string;
  authDir: string;
}

export interface Config {
  model: ModelConfig;
  /** null when WhatsApp is not enabled; the webhook route still works. */
  whatsapp: WhatsAppConfig | null;
  port: number;
}

/** Thrown when the environment is unusable. Names the offending variable. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new ConfigError(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function cutoff(env: Record<string, string | undefined>, name: string): number {
  const raw = required(env, name);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new ConfigError(`${name} must be a number between 0 and 1, got: ${raw}`);
  }
  return value;
}

function whatsappConfig(env: Record<string, string | undefined>): WhatsAppConfig | null {
  if (env.WA_ENABLED !== "true") return null;

  const pairingNumber = required(env, "WA_PAIRING_NUMBER");
  if (!/^\d{8,15}$/.test(pairingNumber)) {
    throw new ConfigError(
      `WA_PAIRING_NUMBER must be 8-15 digits, E.164 without '+', got: ${pairingNumber}`,
    );
  }

  return { pairingNumber, authDir: env.WA_AUTH_DIR?.trim() || ".baileys" };
}

function port(env: Record<string, string | undefined>): number {
  const raw = env.PORT;
  if (raw === undefined || raw.trim() === "") return 3000;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new ConfigError(`PORT must be an integer between 1 and 65535, got: ${raw}`);
  }
  return value;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  return {
    model: {
      endpoint: required(env, "OPENROUTER_ENDPOINT"),
      apiKey: required(env, "OPENROUTER_API_KEY"),
      primaryId: required(env, "MODEL_PRIMARY_ID"),
      fallbackId: required(env, "MODEL_FALLBACK_ID"),
      cutoffPrimary: cutoff(env, "RED_FLAG_CUTOFF_PRIMARY"),
      cutoffFallback: cutoff(env, "RED_FLAG_CUTOFF_FALLBACK"),
    },
    whatsapp: whatsappConfig(env),
    port: port(env),
  };
}
```

Note: `WA_ENABLED` gates WhatsApp. Without it the process boots webhook-only, which is the spec's stated mitigation for pairing taking all night.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/src/config.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config.ts packages/core/src/config.test.ts
git commit -m "feat(core): env config loader with fail-fast validation"
```

---

### Task 2: Decision model — provider schema and mapping

**Files:**
- Create: `packages/core/src/decision-model/schema.ts`
- Create: `packages/core/src/decision-model/types.ts`
- Test: `packages/core/src/decision-model/schema.test.ts`

- [ ] **Step 1: Install zod**

Run: `bun add zod --filter @qure/core`
Expected: zod in `packages/core/package.json` dependencies.

- [ ] **Step 2: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { DecisionModelError } from "./types";
import { parseDecision } from "./schema";

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
      choices: [{ message: { content: "```json\n{\"red_flag\":0.4,\"wants_human\":0.1}\n```" } }],
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/core/src/decision-model/schema.test.ts`
Expected: FAIL — "Cannot find module './schema'"

- [ ] **Step 4: Write `types.ts`**

```ts
import type { Decision, InboundMessage } from "../contracts";

/**
 * The seam the orchestrator talks to. The client that implements this may be
 * backed by HTTP, a fake, or a local model - the orchestrator never knows.
 */
export interface DecisionModel {
  decide(msg: InboundMessage): Promise<Decision>;
}

/**
 * Any failure to obtain a usable Decision: network, non-2xx, malformed body,
 * or a payload that fails the schema. The orchestrator treats every instance
 * of this as "escalate", so the distinction never reaches the patient.
 */
export class DecisionModelError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DecisionModelError";
  }
}
```

- [ ] **Step 5: Write `schema.ts`**

```ts
/**
 * Provider response -> Decision.
 *
 * This file is the ONLY place that knows the provider's JSON shape. If the
 * System One endpoint turns out to differ from the chat-completions shape
 * assumed here, re-record a real body, change PROVIDER_RESPONSE, and nothing
 * outside this file moves.
 */

import { z } from "zod";
import type { Clarity, ComplaintCategory, Decision } from "../contracts";
import { DecisionModelError } from "./types";

const CLARITY_VALUES = ["crystal_clear", "mostly_clear", "ambiguous", "gibberish"] as const;
const CATEGORY_VALUES = [
  "chest_cardiac",
  "breathing",
  "neuro_consciousness",
  "bleeding_trauma",
  "fever_infection",
  "digestive",
  "mental_health",
  "chronic_medication",
  "minor",
  "other",
] as const;

const probability = z.number().min(0).max(1);

/** The six answers, as the model returns them. */
export const ANSWER_SCHEMA = z.object({
  urgency: z.number().min(0).max(4).nullish(),
  urgency_confidence: probability.nullish(),
  clarity: z.enum(CLARITY_VALUES).nullish(),
  red_flag: probability,
  red_flag_informal: probability.nullish(),
  wants_human: probability,
  category: z.enum(CATEGORY_VALUES).nullish(),
});

const PROVIDER_RESPONSE = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string() }) }))
    .min(1, "provider returned no choices"),
});

/** Strips a ```json fence if the model wrapped its JSON in one. */
function unfence(content: string): string {
  const fenced = content.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return (fenced?.[1] ?? content).trim();
}

/**
 * Parse a raw provider body into a Decision.
 *
 * @throws DecisionModelError on any malformed input. Callers escalate.
 */
export function parseDecision(body: unknown, modelId: string): Decision {
  const envelope = PROVIDER_RESPONSE.safeParse(body);
  if (!envelope.success) {
    throw new DecisionModelError(`Provider body is not a chat completion: ${envelope.error.message}`);
  }

  const content = envelope.data.choices[0]?.message.content ?? "";

  let decoded: unknown;
  try {
    decoded = JSON.parse(unfence(content));
  } catch (cause) {
    throw new DecisionModelError(`Provider content is not JSON: ${content.slice(0, 200)}`, cause);
  }

  const answers = ANSWER_SCHEMA.safeParse(decoded);
  if (!answers.success) {
    throw new DecisionModelError(`Provider answers failed validation: ${answers.error.message}`);
  }

  const a = answers.data;

  return {
    source: "decision_model",
    urgency: a.urgency ?? null,
    urgencyConfidence: a.urgency_confidence ?? null,
    clarity: (a.clarity ?? null) as Clarity | null,
    redFlag: a.red_flag,
    redFlagInformal: a.red_flag_informal ?? null,
    wantsHuman: a.wants_human,
    category: (a.category ?? null) as ComplaintCategory | null,
    matchedFamily: null,
    model: modelId,
    raw: body,
  };
}

/** The instruction sent as the user turn. Kept beside the schema it must satisfy. */
export const SYSTEM_PROMPT = [
  "You triage WhatsApp messages from patients in Indonesia, for a puskesmas.",
  "Reply with a single JSON object and nothing else. Keys:",
  '  "urgency": number 0-4 (0 no care needed, 4 life-threatening now)',
  '  "urgency_confidence": number 0-1',
  '  "clarity": one of crystal_clear | mostly_clear | ambiguous | gibberish',
  '  "red_flag": number 0-1, probability this is life-threatening right now',
  '  "red_flag_informal": number 0-1, same question with slang and typos discounted',
  '  "wants_human": number 0-1, probability the author wants a human not a bot',
  '  "category": one of chest_cardiac | breathing | neuro_consciousness | bleeding_trauma |',
  "               fever_infection | digestive | mental_health | chronic_medication | minor | other",
  "Recall matters more than precision: when unsure, raise red_flag.",
].join("\n");
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test packages/core/src/decision-model/schema.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 7: Commit**

```bash
git add packages/core/package.json bun.lock packages/core/src/decision-model/
git commit -m "feat(core): decision-model provider schema and Decision mapping"
```

---

### Task 3: Decision model client

**Files:**
- Create: `packages/core/src/decision-model/client.ts`
- Test: `packages/core/src/decision-model/client.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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

function body(model: string, answers: Record<string, unknown>): string {
  return JSON.stringify({
    choices: [{ message: { content: JSON.stringify(answers) }, model } }],
  });
}

const GOOD = { red_flag: 0.9, wants_human: 0, urgency: 4 };

/** Records every call so tests can assert on routing. */
function recordingFetch(responses: Array<() => Response>): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; body: unknown }>;
} {
  const calls: Array<{ url: string; body: unknown }> = [];
  let index = 0;

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return next!();
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

describe("createDecisionModelClient", () => {
  test("answers from the primary model", async () => {
    const { fetchImpl, calls } = recordingFetch([
      () => new Response(body("pplx-decider-v1.1", GOOD), { status: 200 }),
    ]);

    const decision = await createDecisionModelClient(CONFIG, fetchImpl).decide(MSG);

    expect(decision.model).toBe("pplx-decider-v1.1");
    expect(decision.redFlag).toBe(0.9);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(CONFIG.endpoint);
  });

  test("sends the bearer token and the primary slug", async () => {
    const { fetchImpl, calls } = recordingFetch([
      () => new Response(body("pplx-decider-v1.1", GOOD), { status: 200 }),
    ]);

    const headers: Array<Record<string, string>> = [];
    const spy = (async (url: string | URL, init?: RequestInit) => {
      headers.push(init?.headers as Record<string, string>);
      return fetchImpl(url, init);
    }) as unknown as typeof fetch;

    await createDecisionModelClient(CONFIG, spy).decide(MSG);

    expect(headers[0]?.authorization).toBe("Bearer test-key");
    expect((calls[0]?.body as { model: string }).model).toBe("pplx-decider-v1.1");
  });

  test("falls back to the secondary model when the primary errors", async () => {
    const { fetchImpl, calls } = recordingFetch([
      () => new Response("upstream exploded", { status: 502 }),
      () => new Response(body("jev-1.13", GOOD), { status: 200 }),
    ]);

    const decision = await createDecisionModelClient(CONFIG, fetchImpl).decide(MSG);

    expect(decision.model).toBe("jev-1.13");
    expect(calls).toHaveLength(2);
    expect((calls[1]?.body as { model: string }).model).toBe("jev-1.13");
  });

  test("falls back when the primary returns an unusable body", async () => {
    const { fetchImpl, calls } = recordingFetch([
      () => new Response(JSON.stringify({ choices: [] }), { status: 200 }),
      () => new Response(body("jev-1.13", GOOD), { status: 200 }),
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

  test("passes the patient text through as the user turn", async () => {
    const { fetchImpl, calls } = recordingFetch([
      () => new Response(body("m", GOOD), { status: 200 }),
    ]);

    await createDecisionModelClient(CONFIG, fetchImpl).decide(MSG);

    const messages = (calls[0]?.body as { messages: Array<{ role: string; content: string }> }).messages;
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]).toEqual({ role: "user", content: "sesak napas berat" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/decision-model/client.test.ts`
Expected: FAIL — "Cannot find module './client'"

- [ ] **Step 3: Write the implementation**

```ts
/**
 * HTTP decision model: primary slug first, fallback slug on any primary
 * failure. Returns a Decision or throws DecisionModelError - it never
 * invents a low-urgency answer.
 */

import type { Decision, InboundMessage } from "../contracts";
import type { Config } from "../config";
import { parseDecision, SYSTEM_PROMPT } from "./schema";
import { DecisionModelError, type DecisionModel } from "./types";

const TIMEOUT_MS = 8_000;

export type ModelConfig = Pick<
  Config["model"],
  "endpoint" | "apiKey" | "primaryId" | "fallbackId"
>;

async function askModel(
  config: ModelConfig,
  modelId: string,
  msg: InboundMessage,
  fetchImpl: typeof fetch,
): Promise<Decision> {
  const response = await fetchImpl(config.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: msg.text },
      ],
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    const preview = (await response.text().catch(() => "")).slice(0, 200);
    throw new DecisionModelError(`${modelId} returned HTTP ${response.status}: ${preview}`);
  }

  const body: unknown = await response.json().catch((cause: unknown) => {
    throw new DecisionModelError(`${modelId} returned a body that is not JSON`, cause);
  });

  return parseDecision(body, modelId);
}

export function createDecisionModelClient(
  config: ModelConfig,
  fetchImpl: typeof fetch = fetch,
): DecisionModel {
  return {
    async decide(msg: InboundMessage): Promise<Decision> {
      const failures: string[] = [];

      for (const modelId of [config.primaryId, config.fallbackId]) {
        try {
          return await askModel(config, modelId, msg, fetchImpl);
        } catch (error: unknown) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }

      throw new DecisionModelError(`Both decision models failed: ${failures.join(" | ")}`);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/src/decision-model/client.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/decision-model/client.ts packages/core/src/decision-model/client.test.ts
git commit -m "feat(core): decision model HTTP client with primary/fallback"
```

---

### Task 4: Reply templates

**Files:**
- Create: `packages/core/src/reply/templates.ts`
- Test: `packages/core/src/reply/templates.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { replyFor, TEMPLATES, type ReplyKind } from "./templates";

describe("replyFor", () => {
  test("every kind produces non-empty Bahasa text", () => {
    const kinds: ReplyKind[] = ["emergency", "urgent", "routine", "unclear"];

    for (const kind of kinds) {
      expect(replyFor(kind).length).toBeGreaterThan(20);
    }
  });

  test("emergency tells the patient to go to the ER", () => {
    expect(TEMPLATES.emergency).toMatch(/IGD/);
  });

  test("unclear asks a question", () => {
    expect(TEMPLATES.unclear).toMatch(/\?/);
  });

  test("kinds are distinct", () => {
    const texts = Object.values(TEMPLATES);
    expect(new Set(texts).size).toBe(texts.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/reply/templates.test.ts`
Expected: FAIL — "Cannot find module './templates'"

- [ ] **Step 3: Write the implementation**

```ts
/**
 * Patient-facing Bahasa Indonesia replies.
 *
 * Deliberately plain strings, not generated text: a clinician can correct this
 * file without reading any other code. The conversational LLM replaces this
 * later; until then these are what actually reaches patients.
 */

export type ReplyKind = "emergency" | "urgent" | "routine" | "unclear";

export const TEMPLATES: Record<ReplyKind, string> = {
  emergency: [
    "⚠️ Keluhan Anda bisa berbahaya dan perlu ditangani SEKARANG.",
    "Segera ke IGD puskesmas atau rumah sakit terdekat, atau hubungi 119.",
    "Minta bantuan orang lain untuk mengantar - jangan menyetir sendiri.",
  ].join("\n"),

  urgent: [
    "Terima kasih. Keluhan Anda perlu diperiksa hari ini.",
    "Silakan datang ke puskesmas sekarang dan tunjukkan pesan ini di loket.",
  ].join("\n"),

  routine: [
    "Terima kasih, keluhan Anda sudah kami catat.",
    "Silakan datang ke puskesmas pada jam buka dan tunjukkan pesan ini di loket",
    "untuk masuk antrean.",
  ].join("\n"),

  unclear: [
    "Maaf, kami belum memahami keluhan Anda.",
    "Bisa dijelaskan lagi? Contoh: \"demam 3 hari, batuk, dan sesak napas\".",
  ].join("\n"),
};

export function replyFor(kind: ReplyKind): string {
  return TEMPLATES[kind];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/src/reply/templates.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/reply/
git commit -m "feat(core): Bahasa Indonesia reply templates"
```

---

### Task 5: Orchestrator

**Files:**
- Create: `packages/core/src/triage/orchestrator.ts`
- Create: `packages/core/src/channel/fake.ts`
- Create: `packages/core/src/decision-model/fake.ts`
- Test: `packages/core/src/triage/orchestrator.test.ts`

- [ ] **Step 1: Write the fakes**

`packages/core/src/channel/fake.ts`:

```ts
import type { InboundMessage, OutboundMessage, WhatsAppChannel } from "../contracts";

/** In-memory channel for tests and for running the pipeline without a phone. */
export class FakeChannel implements WhatsAppChannel {
  readonly sent: OutboundMessage[] = [];

  private handler: ((msg: InboundMessage) => Promise<void>) | null = null;

  async send(msg: OutboundMessage): Promise<void> {
    this.sent.push(msg);
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  /** Simulates an inbound message arriving from the transport. */
  async receive(msg: InboundMessage): Promise<void> {
    if (!this.handler) throw new Error("FakeChannel.receive called before onMessage");
    await this.handler(msg);
  }
}
```

`packages/core/src/decision-model/fake.ts`:

```ts
import type { Decision, InboundMessage } from "../contracts";
import type { DecisionModel } from "./types";

/**
 * Deterministic stand-in. `mode` selects the behaviour a test needs, so a
 * single fake covers the happy path, provider failure, and slow responses.
 */
export class FakeDecisionModel implements DecisionModel {
  constructor(
    private readonly decision: Decision,
    private readonly mode: "ok" | "throw" | "hang" = "ok",
  ) {}

  async decide(_msg: InboundMessage): Promise<Decision> {
    if (this.mode === "throw") throw new Error("provider unavailable");
    if (this.mode === "hang") return new Promise<Decision>(() => {});
    return this.decision;
  }
}

/** A Decision with everything neutral; override what a test cares about. */
export function neutralDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    source: "decision_model",
    urgency: 1,
    urgencyConfidence: 0.9,
    clarity: "mostly_clear",
    redFlag: 0,
    redFlagInformal: 0,
    wantsHuman: 0,
    category: "minor",
    matchedFamily: null,
    model: "pplx-decider-v1.1",
    raw: null,
    ...overrides,
  };
}
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import type { InboundMessage, OutboundMessage } from "../contracts";
import { FakeChannel } from "../channel/fake";
import { FakeDecisionModel, neutralDecision } from "../decision-model/fake";
import { TEMPLATES } from "../reply/templates";
import { createOrchestrator, type OrchestratorDeps } from "./orchestrator";

const CUTOFFS = {
  primaryId: "pplx-decider-v1.1",
  fallbackId: "jev-1.13",
  cutoffPrimary: 0.15,
  cutoffFallback: 0.31,
};

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    phone: "628123456789",
    text: "demam tiga hari",
    providerMessageId: "MSG-1",
    receivedAt: new Date("2026-10-14T10:00:00Z"),
    kind: "text",
    ...overrides,
  };
}

function deps(model: FakeDecisionModel, options: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return { model, cutoffs: CUTOFFS, channel: new FakeChannel(), timeoutMs: 50, ...options };
}

describe("orchestrator", () => {
  test("routine complaint gets the routine template", async () => {
    const orchestrator = createOrchestrator(deps(new FakeDecisionModel(neutralDecision())));

    const reply = await orchestrator.handleInbound(message());

    expect(reply?.text).toBe(TEMPLATES.routine);
    expect(reply?.phone).toBe("628123456789");
    expect(reply?.purpose).toBe("reply");
  });

  test("red flag above the primary cutoff escalates", async () => {
    const model = new FakeDecisionModel(neutralDecision({ redFlag: 0.2 }));

    expect((await createOrchestrator(deps(model)).handleInbound(message()))?.text).toBe(
      TEMPLATES.emergency,
    );
  });

  test("red flag below the primary cutoff does not escalate", async () => {
    const model = new FakeDecisionModel(neutralDecision({ redFlag: 0.14 }));

    expect((await createOrchestrator(deps(model)).handleInbound(message()))?.text).toBe(
      TEMPLATES.routine,
    );
  });

  test("the fallback model uses the looser cutoff", async () => {
    const model = new FakeDecisionModel(
      neutralDecision({ redFlag: 0.2, model: "jev-1.13" }),
    );

    // 0.2 escalates under the primary cutoff (0.15) but not the fallback's (0.31)
    expect((await createOrchestrator(deps(model)).handleInbound(message()))?.text).toBe(
      TEMPLATES.routine,
    );
  });

  test("wants_human escalates regardless of urgency", async () => {
    const model = new FakeDecisionModel(neutralDecision({ wantsHuman: 0.9, urgency: 0 }));

    expect((await createOrchestrator(deps(model)).handleInbound(message()))?.text).toBe(
      TEMPLATES.emergency,
    );
  });

  test("ambiguous clarity asks a follow-up", async () => {
    const model = new FakeDecisionModel(neutralDecision({ clarity: "ambiguous" }));

    expect((await createOrchestrator(deps(model)).handleInbound(message()))?.text).toBe(
      TEMPLATES.unclear,
    );
  });

  test("non-text payloads ask a follow-up instead of crashing", async () => {
    const model = new FakeDecisionModel(neutralDecision());

    const reply = await createOrchestrator(deps(model)).handleInbound(
      message({ kind: "audio", text: "" }),
    );

    expect(reply?.text).toBe(TEMPLATES.unclear);
  });

  test("a duplicate providerMessageId is not answered twice", async () => {
    const orchestrator = createOrchestrator(deps(new FakeDecisionModel(neutralDecision())));

    expect(await orchestrator.handleInbound(message())).not.toBeNull();
    expect(await orchestrator.handleInbound(message())).toBeNull();
  });

  test("distinct ids from the same phone are both answered", async () => {
    const orchestrator = createOrchestrator(deps(new FakeDecisionModel(neutralDecision())));

    await orchestrator.handleInbound(message({ providerMessageId: "A" }));
    await orchestrator.handleInbound(message({ providerMessageId: "B" }));

    expect(orchestrator.seenCount()).toBe(2);
  });

  test("a model failure escalates rather than passing", async () => {
    const model = new FakeDecisionModel(neutralDecision(), "throw");

    expect((await createOrchestrator(deps(model)).handleInbound(message()))?.text).toBe(
      TEMPLATES.emergency,
    );
  });

  test("a model timeout escalates rather than passing", async () => {
    const model = new FakeDecisionModel(neutralDecision(), "hang");

    expect((await createOrchestrator(deps(model)).handleInbound(message()))?.text).toBe(
      TEMPLATES.emergency,
    );
  });

  test("the seen-set is bounded", async () => {
    const orchestrator = createOrchestrator(
      deps(new FakeDecisionModel(neutralDecision()), { seenLimit: 3 }),
    );

    for (const id of ["A", "B", "C", "D", "E"]) {
      await orchestrator.handleInbound(message({ providerMessageId: id }));
    }

    expect(orchestrator.seenCount()).toBe(3);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/core/src/triage/orchestrator.test.ts`
Expected: FAIL — "Cannot find module './orchestrator'"

- [ ] **Step 4: Write the implementation**

```ts
/**
 * The loop: inbound message in, outbound reply out.
 *
 * Two properties this file exists to guarantee:
 *   1. A model failure ESCALATES. Timeout, provider error, or an unusable
 *      body produces the emergency template, never a reassuring one.
 *   2. A message is answered at most once, no matter how often the transport
 *      re-delivers it.
 */

import type { Decision, InboundMessage, OutboundMessage, WhatsAppChannel } from "../contracts";
import type { DecisionModel } from "../decision-model/types";
import { replyFor, type ReplyKind } from "../reply/templates";

/** Above this, a request for a human is honoured regardless of urgency. */
const WANTS_HUMAN_CUTOFF = 0.5;

const DEFAULT_TIMEOUT_MS = 9_000;
const DEFAULT_SEEN_LIMIT = 500;

export interface Cutoffs {
  primaryId: string;
  fallbackId: string;
  cutoffPrimary: number;
  cutoffFallback: number;
}

export interface OrchestratorDeps {
  model: DecisionModel;
  cutoffs: Cutoffs;
  channel: WhatsAppChannel;
  timeoutMs?: number;
  seenLimit?: number;
}

export interface Orchestrator {
  handleInbound(msg: InboundMessage): Promise<OutboundMessage | null>;
  /** Registered on the channel; wires the transport to the loop. */
  onInbound(msg: InboundMessage): Promise<void>;
  seenCount(): number;
}

/** The threshold that applies to whichever model answered. */
function cutoffFor(modelId: string | null, cutoffs: Cutoffs): number {
  return modelId === cutoffs.fallbackId ? cutoffs.cutoffFallback : cutoffs.cutoffPrimary;
}

/**
 * Decide which template the patient gets.
 *
 * Exported so the ladder is testable without constructing an orchestrator.
 */
export function replyKindFor(decision: Decision, cutoffs: Cutoffs): ReplyKind {
  if (decision.redFlag >= cutoffFor(decision.model, cutoffs)) return "emergency";
  if (decision.wantsHuman >= WANTS_HUMAN_CUTOFF) return "emergency";
  if (decision.clarity === "ambiguous" || decision.clarity === "gibberish") return "unclear";
  if ((decision.urgency ?? 0) >= 3) return "urgent";
  return "routine";
}

/** The decision used when the model could not be reached. Escalates by construction. */
function escalationDecision(): Decision {
  return {
    source: "decision_model",
    urgency: null,
    urgencyConfidence: null,
    clarity: null,
    redFlag: 1,
    redFlagInformal: null,
    wantsHuman: 0,
    category: null,
    matchedFamily: null,
    model: null,
    raw: null,
  };
}

/** A promise that rejects after `ms`, used to bound the model call. */
function timeout(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

async function decideWithin(
  model: DecisionModel,
  msg: InboundMessage,
  ms: number,
): Promise<Decision> {
  const { signal, cancel } = timeout(ms);

  try {
    return await Promise.race([
      model.decide(msg),
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error(`model timed out after ${ms}ms`)));
      }),
    ]);
  } finally {
    cancel();
  }
}

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const seenLimit = deps.seenLimit ?? DEFAULT_SEEN_LIMIT;

  // Insertion-ordered Set used as a ring buffer: re-adding an id that is
  // already present would not move it, so a duplicate is detected before
  // any eviction happens.
  const seen = new Set<string>();

  function remember(id: string): boolean {
    if (seen.has(id)) return false;

    seen.add(id);
    while (seen.size > seenLimit) {
      const oldest = seen.values().next().value;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }
    return true;
  }

  async function handleInbound(msg: InboundMessage): Promise<OutboundMessage | null> {
    if (!remember(msg.providerMessageId)) return null;

    let decision: Decision;
    try {
      decision = await decideWithin(deps.model, msg, timeoutMs);
    } catch {
      decision = escalationDecision();
    }

    const kind: ReplyKind =
      msg.kind !== "text" || msg.text.trim() === "" ? "unclear" : replyKindFor(decision, deps.cutoffs);

    return { phone: msg.phone, text: replyFor(kind), purpose: "reply" };
  }

  return {
    handleInbound,
    async onInbound(msg: InboundMessage): Promise<void> {
      const reply = await handleInbound(msg);
      if (reply) await deps.channel.send(reply);
    },
    seenCount: () => seen.size,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/core/src/triage/orchestrator.test.ts`
Expected: PASS, 12 tests

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/triage/ packages/core/src/channel/fake.ts packages/core/src/decision-model/fake.ts
git commit -m "feat(core): orchestrator with dedup and escalate-on-failure"
```

---

### Task 6: Webhook route and app wiring

**Files:**
- Create: `apps/api/src/routes/webhook.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/app.test.ts`

- [ ] **Step 1: Write the failing test**

Replace `apps/api/src/app.test.ts` entirely:

```ts
import { describe, expect, test } from "bun:test";
import { buildApp } from "./app";
import { TEMPLATES } from "@qure/core/reply/templates";

/** Minimal handler stub: echoes a fixed reply so routing can be asserted. */
const handleInbound = async (msg: { phone: string }) => ({
  phone: msg.phone,
  text: TEMPLATES.routine,
  purpose: "reply" as const,
});

const VALID_BODY = {
  phone: "628123456789",
  text: "demam tiga hari",
  providerMessageId: "MSG-1",
  receivedAt: "2026-10-14T10:00:00.000Z",
  kind: "text",
};

describe("GET /health", () => {
  test("returns ok with service name", async () => {
    const app = buildApp({ handleInbound });
    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, service: "qure-api" });

    await app.close();
  });
});

describe("POST /webhook/inbound", () => {
  test("returns the reply for a valid message", async () => {
    const app = buildApp({ handleInbound });
    const res = await app.inject({ method: "POST", url: "/webhook/inbound", payload: VALID_BODY });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      reply: { phone: "628123456789", text: TEMPLATES.routine, purpose: "reply" },
    });

    await app.close();
  });

  test("returns reply null when the handler suppresses the message", async () => {
    const app = buildApp({ handleInbound: async () => null });
    const res = await app.inject({ method: "POST", url: "/webhook/inbound", payload: VALID_BODY });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, reply: null });

    await app.close();
  });

  test("rejects a body with no phone", async () => {
    const app = buildApp({ handleInbound });
    const { phone: _phone, ...withoutPhone } = VALID_BODY;
    const res = await app.inject({ method: "POST", url: "/webhook/inbound", payload: withoutPhone });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/phone/);

    await app.close();
  });

  test("rejects an unknown kind", async () => {
    const app = buildApp({ handleInbound });
    const res = await app.inject({
      method: "POST",
      url: "/webhook/inbound",
      payload: { ...VALID_BODY, kind: "telepathy" },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  test("rejects a receivedAt that is not a date", async () => {
    const app = buildApp({ handleInbound });
    const res = await app.inject({
      method: "POST",
      url: "/webhook/inbound",
      payload: { ...VALID_BODY, receivedAt: "yesterday" },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  test("passes the parsed message through with a Date", async () => {
    const seen: unknown[] = [];
    const app = buildApp({
      handleInbound: async (msg) => {
        seen.push(msg);
        return null;
      },
    });

    await app.inject({ method: "POST", url: "/webhook/inbound", payload: VALID_BODY });

    expect((seen[0] as { receivedAt: Date }).receivedAt).toBeInstanceOf(Date);
    expect((seen[0] as { providerMessageId: string }).providerMessageId).toBe("MSG-1");

    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/api/src/app.test.ts`
Expected: FAIL — `buildApp` takes no arguments / route 404

- [ ] **Step 3: Write the route**

`apps/api/src/routes/webhook.ts`:

```ts
/**
 * The pipeline's second front door.
 *
 * Baileys calls the handler in-process; this route exposes the same handler
 * over HTTP so the LLM half can be proven with curl before (or without) a
 * phone being linked. It is also the shape the Meta Cloud API fallback needs.
 */

import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { InboundMessage, OutboundMessage } from "@qure/core";

const INBOUND_SCHEMA = z.object({
  phone: z.string().regex(/^\d{8,15}$/, "phone must be E.164 digits without '+'"),
  text: z.string(),
  providerMessageId: z.string().min(1),
  receivedAt: z.coerce.date(),
  kind: z.enum(["text", "audio", "image", "document", "other"]),
});

export type HandleInbound = (msg: InboundMessage) => Promise<OutboundMessage | null>;

export function registerWebhookRoute(app: FastifyInstance, handleInbound: HandleInbound): void {
  app.post("/webhook/inbound", async (request, reply) => {
    const parsed = INBOUND_SCHEMA.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({ ok: false, error: parsed.error.issues[0]?.message ?? "invalid body" });
    }

    const result = await handleInbound(parsed.data);
    return reply.status(200).send({ ok: true, reply: result });
  });
}
```

- [ ] **Step 4: Rewrite `app.ts`**

```ts
import Fastify, { type FastifyInstance } from "fastify";
import { registerWebhookRoute, type HandleInbound } from "./routes/webhook";

export interface AppDeps {
  /** The orchestrator's handleInbound. Injected so tests need no network. */
  handleInbound: HandleInbound;
}

/** Build the Fastify app without binding a port (testable). */
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({ ok: true, service: "qure-api" }));
  registerWebhookRoute(app, deps.handleInbound);

  return app;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test apps/api/src/app.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/app.ts apps/api/src/app.test.ts apps/api/src/routes/
git commit -m "feat(api): POST /webhook/inbound drives the pipeline over HTTP"
```

---

### Task 7: Rate limiter and Baileys channel

**Files:**
- Create: `packages/core/src/channel/rate-limit.ts`
- Test: `packages/core/src/channel/rate-limit.test.ts`
- Create: `packages/core/src/channel/whatsapp.ts`

- [ ] **Step 1: Install Baileys**

Run: `bun add baileys --filter @qure/core`
Expected: baileys in `packages/core/package.json`.

- [ ] **Step 2: Write the failing rate-limiter test**

```ts
import { describe, expect, test } from "bun:test";
import { createRateLimiter } from "./rate-limit";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createRateLimiter", () => {
  test("first call is not delayed", async () => {
    const limiter = createRateLimiter(200);
    const started = Date.now();

    await limiter.wait("628111");

    expect(Date.now() - started).toBeLessThan(50);
  });

  test("second call to the same phone is delayed", async () => {
    const limiter = createRateLimiter(200);

    await limiter.wait("628111");
    const started = Date.now();
    await limiter.wait("628111");

    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });

  test("different phones do not block each other", async () => {
    const limiter = createRateLimiter(200);

    await limiter.wait("628111");
    const started = Date.now();
    await limiter.wait("628222");

    expect(Date.now() - started).toBeLessThan(50);
  });

  test("serialises concurrent calls to the same phone", async () => {
    const limiter = createRateLimiter(150);
    const order: number[] = [];

    await Promise.all(
      [0, 1, 2].map(async (index) => {
        await limiter.wait("628111");
        order.push(index);
      }),
    );

    expect(order).toEqual([0, 1, 2]);
  });

  test("sleeps rather than dropping the message", async () => {
    const limiter = createRateLimiter(120);
    const started = Date.now();

    await limiter.wait("628111");
    await limiter.wait("628111");

    // If the limiter dropped sends, the second call would return instantly.
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  test("keeps the gap after a long pause", async () => {
    const limiter = createRateLimiter(100);

    await limiter.wait("628111");
    await sleep(150);
    const started = Date.now();
    await limiter.wait("628111");

    expect(Date.now() - started).toBeLessThan(50);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/core/src/channel/rate-limit.test.ts`
Expected: FAIL — "Cannot find module './rate-limit'"

- [ ] **Step 4: Write the rate limiter**

```ts
/**
 * Per-phone outbound pacing.
 *
 * Rapid identical sends are what spam heuristics look for, and the number is
 * the demo. Sends are delayed, never dropped: a patient waiting on their
 * emergency reply must not have it silently discarded.
 */

export interface RateLimiter {
  wait(phone: string): Promise<void>;
}

export function createRateLimiter(minIntervalMs: number): RateLimiter {
  const lastSentAt = new Map<string, number>();
  const queues = new Map<string, Promise<void>>();

  async function pace(phone: string): Promise<void> {
    const previous = lastSentAt.get(phone);
    const now = Date.now();

    if (previous !== undefined) {
      const wait = minIntervalMs - (now - previous);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }

    lastSentAt.set(phone, Date.now());
  }

  return {
    wait(phone: string): Promise<void> {
      // Chain onto this phone's tail so concurrent sends serialise instead of
      // both reading the same "last sent" timestamp.
      const tail = queues.get(phone) ?? Promise.resolve();
      const next = tail.then(() => pace(phone));
      queues.set(
        phone,
        next.catch(() => undefined),
      );
      return next;
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/core/src/channel/rate-limit.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 6: Write the Baileys adapter**

`packages/core/src/channel/whatsapp.ts`:

```ts
/**
 * Baileys implementation of WhatsAppChannel. Demo-only transport.
 *
 * Responsibilities kept here so nothing else learns about WhatsApp:
 *   - JID <-> E.164 normalisation
 *   - dropping groups, self-messages, status broadcasts and history sync
 *   - pacing outbound sends
 *   - reconnecting when the socket drops
 *
 * The pairing code is requested here too: an 8-digit code entered under Linked
 * Devices beats a terminal QR, which expires in seconds and renders badly over
 * SSH and tmux.
 */

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  type WASocket,
} from "baileys";
import type { InboundMessage, OutboundMessage, WhatsAppChannel } from "../contracts";
import { createRateLimiter } from "./rate-limit";

const OUTBOUND_INTERVAL_MS = 1_200;

export interface BaileysChannelOptions {
  /** E.164 digits, no leading '+'. */
  pairingNumber: string;
  authDir: string;
  logger?: (message: string) => void;
}

/** "628123456789:12@s.whatsapp.net" -> "628123456789". null when not a person. */
export function phoneFromJid(jid: string | null | undefined): string | null {
  if (!jid) return null;
  if (jid.endsWith("@g.us")) return null;
  if (jid.endsWith("@broadcast")) return null;
  if (!jid.endsWith("@s.whatsapp.net")) return null;

  const bare = jid.split("@")[0] ?? "";
  const withoutDevice = bare.split(":")[0] ?? "";
  return /^\d{8,15}$/.test(withoutDevice) ? withoutDevice : null;
}

/** Maps a Baileys message content onto the contract's kind. */
export function kindOf(content: Record<string, unknown> | null | undefined): InboundMessage["kind"] {
  if (!content) return "other";
  if (content.conversation || content.extendedTextMessage) return "text";
  if (content.audioMessage) return "audio";
  if (content.imageMessage) return "image";
  if (content.documentMessage) return "document";
  return "other";
}

/** Text of a Baileys message, or "" for non-text payloads. */
export function textOf(content: Record<string, unknown> | null | undefined): string {
  if (!content) return "";
  const direct = content.conversation;
  if (typeof direct === "string") return direct;

  const extended = content.extendedTextMessage as { text?: unknown } | undefined;
  if (typeof extended?.text === "string") return extended.text;

  const caption = (content.imageMessage ?? content.documentMessage ?? content.audioMessage) as
    | { caption?: unknown }
    | undefined;
  return typeof caption?.caption === "string" ? caption.caption : "";
}

export async function createBaileysChannel(options: BaileysChannelOptions): Promise<WhatsAppChannel> {
  const log = options.logger ?? (() => {});
  const limiter = createRateLimiter(OUTBOUND_INTERVAL_MS);
  let handler: ((msg: InboundMessage) => Promise<void>) | null = null;
  let socket: WASocket | null = null;
  let pairingRequested = false;

  async function connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(options.authDir);
    const sock = makeWASocket({ auth: state, printQRInTerminal: false });
    socket = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === "open") {
        log(`WhatsApp connected as ${options.pairingNumber}`);
        return;
      }

      if (connection === "close") {
        const status = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
          ?.output?.statusCode;

        if (status === DisconnectReason.loggedOut) {
          log("WhatsApp logged out. Delete the auth dir and pair again.");
          return;
        }

        log(`WhatsApp connection closed (status ${status ?? "unknown"}). Reconnecting.`);
        void connect();
      }
    });

    // Pair only when this is a fresh auth dir.
    if (!state.creds.registered && !pairingRequested) {
      pairingRequested = true;
      try {
        const code = await sock.requestPairingCode(options.pairingNumber);
        log(`Pairing code: ${code}  (enter under Linked Devices on that phone)`);
      } catch (error: unknown) {
        log(`Pairing failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      // "notify" is a live message. "append" is history replay on reconnect.
      if (type !== "notify") return;

      for (const incoming of messages) {
        if (incoming.key.fromMe) continue;

        const phone = phoneFromJid(incoming.key.remoteJid);
        if (!phone) continue;

        const content = incoming.message as Record<string, unknown> | null | undefined;
        const msg: InboundMessage = {
          phone,
          text: textOf(content),
          providerMessageId: incoming.key.id ?? `${phone}-${Date.now()}`,
          receivedAt: new Date((incoming.messageTimestamp ?? Date.now() / 1000) as number * 1000),
          kind: kindOf(content),
        };

        void handler?.(msg).catch((error: unknown) => {
          log(`Handler failed for ${msg.providerMessageId}: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    });
  }

  await connect();

  return {
    async send(msg: OutboundMessage): Promise<void> {
      await limiter.wait(msg.phone);

      if (!socket) throw new Error("WhatsApp socket is not connected");

      await socket.sendMessage(`${msg.phone}@s.whatsapp.net`, { text: msg.text });
    },

    onMessage(next: (msg: InboundMessage) => Promise<void>): void {
      handler = next;
    },
  };
}
```

- [ ] **Step 7: Typecheck**

Run: `bun run typecheck`
Expected: no errors. Baileys' `makeWASocket` signature varies by version; if the import or the `auth` option name differs, fix it here and note the version in the commit message.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/channel/ packages/core/package.json bun.lock
git commit -m "feat(core): Baileys channel with pacing, JID normalisation, reconnect"
```

---

### Task 8: Composition root and `core` barrel

**Files:**
- Create: `apps/api/src/wiring.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `apps/api/src/index.ts`

- [ ] **Step 1: Export the new modules from core**

Append to `packages/core/src/index.ts`:

```ts
export * from "./config";
export * from "./channel/fake";
export * from "./channel/whatsapp";
export * from "./channel/rate-limit";
export * from "./decision-model/types";
export * from "./decision-model/client";
export * from "./decision-model/fake";
export * from "./reply/templates";
export * from "./triage/orchestrator";
```

- [ ] **Step 2: Write `wiring.ts`**

```ts
/**
 * Composition root. The only file that knows which implementations are live.
 */

import { FastifyInstance } from "fastify";
import { loadConfig, type Config } from "@qure/core/config";
import { createDecisionModelClient } from "@qure/core/decision-model/client";
import { createBaileysChannel } from "@qure/core/channel/whatsapp";
import { FakeChannel } from "@qure/core/channel/fake";
import { createOrchestrator, type Orchestrator } from "@qure/core/triage/orchestrator";

export interface Wiring {
  orchestrator: Orchestrator;
  /** "baileys" when a phone is linked, "none" when running webhook-only. */
  channelMode: "baileys" | "none";
}

export async function wire(config: Config, logger: (message: string) => void): Promise<Wiring> {
  const model = createDecisionModelClient(config.model);

  const cutoffs = {
    primaryId: config.model.primaryId,
    fallbackId: config.model.fallbackId,
    cutoffPrimary: config.model.cutoffPrimary,
    cutoffFallback: config.model.cutoffFallback,
  };

  if (!config.whatsapp) {
    // Webhook-only: the pipeline is still fully exercised via curl.
    logger("WA_ENABLED is not 'true' - running webhook-only, no WhatsApp channel.");
    return {
      orchestrator: createOrchestrator({ model, cutoffs, channel: new FakeChannel() }),
      channelMode: "none",
    };
  }

  const channel = await createBaileysChannel({
    pairingNumber: config.whatsapp.pairingNumber,
    authDir: config.whatsapp.authDir,
    logger,
  });

  const orchestrator = createOrchestrator({ model, cutoffs, channel });
  channel.onMessage((msg) => orchestrator.onInbound(msg));

  return { orchestrator, channelMode: "baileys" };
}
```

- [ ] **Step 3: Rewrite `apps/api/src/index.ts`**

```ts
import { loadConfig, ConfigError } from "@qure/core/config";
import { buildApp } from "./app";
import { wire } from "./wiring";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const wiring = await wire(config, (message) => console.log(`[qure] ${message}`));

  const app = buildApp({ handleInbound: (msg) => wiring.orchestrator.handleInbound(msg) });

  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(`[qure] configuration error: ${error.message}`);
    console.error("[qure] copy .env.example to .env and fill it in.");
    process.exit(1);
  }

  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 4: Typecheck and run the whole suite**

Run: `bun run typecheck && bun test`
Expected: typecheck clean; all tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/wiring.ts apps/api/src/index.ts packages/core/src/index.ts
git commit -m "feat(api): composition root, wire Baileys + orchestrator + routes"
```

---

### Task 9: Live verification

**Files:** none — this task produces evidence, not code.

- [ ] **Step 1: Prove the LLM half with curl**

```bash
cp .env.example .env   # fill in OPENROUTER_ENDPOINT, OPENROUTER_API_KEY, slugs
bun run dev
```

In another shell:

```bash
curl -s -X POST localhost:3000/webhook/inbound \
  -H 'content-type: application/json' \
  -d '{"phone":"628123456789","text":"nyeri dada dan sesak napas","providerMessageId":"curl-1","receivedAt":"2026-10-14T10:00:00.000Z","kind":"text"}'
```

Expected: `{"ok":true,"reply":{"phone":"628123456789","text":"⚠️ ...","purpose":"reply"}}`. A chest-pain message must return the emergency template, not the routine one.

- [ ] **Step 2: Prove dedup**

Repeat the exact same curl (same `providerMessageId`). Expected: `{"ok":true,"reply":null}`.

- [ ] **Step 3: Prove the channel half**

Set `WA_ENABLED=true` and `WA_PAIRING_NUMBER`, restart, read the pairing code from the log, enter it under Linked Devices, then send a real message from another phone.

Expected: reply arrives on WhatsApp; the log shows the inbound id.

- [ ] **Step 4: Record what happened**

Note in the Notion page which endpoints and slugs actually worked, so the values do not have to be rediscovered.

---

## Self-review

**Spec coverage.** Architecture → Tasks 5-8. Components → each has a task (`client` T3, `whatsapp` T7, `orchestrator` T5, `templates` T4, `webhook` T6, `wiring` T8). Data flow → T5 and T7. Safety rules: escalate-on-failure → T5 tests; bounded dedup → T5 test; ignore self/groups/status → T7 `phoneFromJid` + `fromMe` guard; `.baileys/` gitignored → already committed; secrets in `.env` → T1. Config table → T1. Error table → T5 and T7. Testing → colocated throughout. Manual verification → T9.

**Deviations from spec, deliberate:**
- `OPENROUTER_BASE_URL` became `OPENROUTER_ENDPOINT` holding the *full* endpoint URL. Guessing a path suffix would have been a coin flip; a full URL is correct whatever the provider's path is. `.env.example` needs this rename.
- Added `WA_ENABLED` and `WA_AUTH_DIR`. Without a gate, a broken Baileys install would stop the process booting, which contradicts the spec's own mitigation that the webhook route keeps the pipeline provable.
- Added zod as a dependency for boundary validation, per the project's TypeScript rules.

**Type consistency.** `DecisionModel.decide` (T2) is called in T5 and T6 as `decide(msg)`. `Orchestrator.handleInbound` (T5) is the `HandleInbound` shape registered in T6 and passed in T8. `Cutoffs` fields match `Config["model"]` names via `wiring.ts`. `ReplyKind` is defined in T4 and consumed in T5. `FakeChannel`/`FakeDecisionModel` are defined in T5 and used in T5's tests only, plus T8's webhook-only path.
