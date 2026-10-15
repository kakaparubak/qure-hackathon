import { describe, expect, test } from "bun:test";
import { loadConfig, slotFor, type ModelSlot } from "./config";

const VALID_ENV: Record<string, string> = {
  OPENROUTER_ENDPOINT: "https://example.test/api/v1/systemone",
  OPENROUTER_API_KEY: "test-key",
  MODEL_PRIMARY_ID: "perplexity/pplx-decider-v1.1-27b",
  MODEL_FALLBACK_ID: "typesafe/jev-1.13",
  RED_FLAG_CUTOFF_PRIMARY: "0.15",
  RED_FLAG_CUTOFF_FALLBACK: "0.31",
  PORT: "3000",
};

const TERTIARY_ENV: Record<string, string> = {
  ...VALID_ENV,
  MODEL_TERTIARY_ID: "cloudflare/clef-27b",
  RED_FLAG_CUTOFF_TERTIARY: "0.11",
};

describe("loadConfig", () => {
  test("parses a complete environment", () => {
    const config = loadConfig(VALID_ENV);

    expect(config.model.endpoint).toBe("https://example.test/api/v1/systemone");
    expect(config.model.slots.map((slot) => slot.id)).toEqual([
      "perplexity/pplx-decider-v1.1-27b",
      "typesafe/jev-1.13",
    ]);
    expect(config.port).toBe(3000);
    expect(config.whatsapp).toBeNull();
  });

  test("keeps each model's own cutoff, which is not 0.5 for any of them", () => {
    const config = loadConfig(TERTIARY_ENV);

    expect(config.model.slots.map((slot) => slot.cutoff)).toEqual([0.15, 0.31, 0.11]);
  });

  test("gives later slots a lower urgency ceiling by default", () => {
    // A small model must not be able to claim urgency 4.
    const config = loadConfig(TERTIARY_ENV);

    expect(config.model.slots.map((slot) => slot.urgencyCeiling)).toEqual([4, 3, 2]);
  });

  test("a ceiling can be set per slot", () => {
    const config = loadConfig({ ...VALID_ENV, MODEL_FALLBACK_URGENCY_CEILING: "2" });

    expect(config.model.slots[1]?.urgencyCeiling).toBe(2);
  });

  test("rejects a ceiling outside 0..4", () => {
    expect(() => loadConfig({ ...VALID_ENV, MODEL_PRIMARY_URGENCY_CEILING: "5" })).toThrow(
      /MODEL_PRIMARY_URGENCY_CEILING/,
    );
  });

  test("the tertiary slot is optional", () => {
    expect(loadConfig(VALID_ENV).model.slots).toHaveLength(2);
  });

  test("a tertiary slot without its cutoff is rejected", () => {
    // Otherwise the extra model silently escalates at the primary's threshold.
    expect(() =>
      loadConfig({ ...VALID_ENV, MODEL_TERTIARY_ID: "cloudflare/clef-27b" }),
    ).toThrow(/RED_FLAG_CUTOFF_TERTIARY/);
  });
});

describe("slotFor", () => {
  const slots: ModelSlot[] = [
    { id: "primary", cutoff: 0.15, urgencyCeiling: 4 },
    { id: "fallback", cutoff: 0.31, urgencyCeiling: 3 },
  ];

  test("finds the slot that answered", () => {
    expect(slotFor(slots, "fallback").cutoff).toBe(0.31);
  });

  test("an unknown model id falls back to the strictest cutoff", () => {
    expect(slotFor(slots, "some/renamed-model").cutoff).toBe(0.15);
    expect(slotFor(slots, null).cutoff).toBe(0.15);
  });
});

describe("loadConfig - validation", () => {
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
    const config = loadConfig({
      ...VALID_ENV,
      WA_ENABLED: "true",
      WA_PAIRING_NUMBER: "628123456789",
    });

    expect(config.whatsapp).toEqual({
      pairingNumber: "628123456789",
      authDir: ".baileys",
      pairingMode: "code",
    });
  });

  test("defaults the pairing mode to a code", () => {
    const config = loadConfig({
      ...VALID_ENV,
      WA_ENABLED: "true",
      WA_PAIRING_NUMBER: "628123456789",
    });

    expect(config.whatsapp?.pairingMode).toBe("code");
  });

  test("accepts qr mode without a pairing number", () => {
    // QR pairing is not bound to a number, so an unset one is not an error.
    const config = loadConfig({
      ...VALID_ENV,
      WA_ENABLED: "true",
      WA_PAIRING_MODE: "qr",
    });

    expect(config.whatsapp).toEqual({ pairingNumber: "", authDir: ".baileys", pairingMode: "qr" });
  });

  test("still validates a pairing number in qr mode when one is given", () => {
    expect(() =>
      loadConfig({ ...VALID_ENV, WA_ENABLED: "true", WA_PAIRING_MODE: "qr", WA_PAIRING_NUMBER: "+62812" }),
    ).toThrow(/WA_PAIRING_NUMBER/);
  });

  test("rejects an unknown pairing mode", () => {
    expect(() =>
      loadConfig({ ...VALID_ENV, WA_ENABLED: "true", WA_PAIRING_MODE: "telepathy" }),
    ).toThrow(/WA_PAIRING_MODE/);
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

test('intake uses a separate configurable chat endpoint and the existing key',()=>{
  const defaults=loadConfig(VALID_ENV);
  expect(defaults.llm.endpoint).toBe('https://openrouter.ai/api/v1/chat/completions');
  expect(defaults.llm.modelId).toBe('openrouter/auto');
  expect(defaults.llm.apiKey).toBe(defaults.model.apiKey);
  const custom=loadConfig({...VALID_ENV,LLM_ENDPOINT:'https://example.test/chat',LLM_MODEL_ID:'provider/model'});
  expect(custom.llm.modelId).toBe('provider/model');
});
