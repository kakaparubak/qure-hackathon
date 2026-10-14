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
    const config = loadConfig({
      ...VALID_ENV,
      WA_ENABLED: "true",
      WA_PAIRING_NUMBER: "628123456789",
    });

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
