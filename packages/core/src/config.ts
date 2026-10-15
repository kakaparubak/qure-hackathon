import type { IntakeModelConfig } from "./intake/llm";
/**
 * Environment loading for the API process.
 *
 * Read once, at boot, so a missing or malformed value produces a named error
 * here rather than an `undefined` travelling into a fetch three calls deep.
 */

/**
 * One model slot.
 *
 * Two per-model knobs, and both exist because the slots are not interchangeable:
 *
 * - `cutoff` is the red_flag probability at which this model's answer counts as
 *   an emergency. It is NOT 0.5, and it is NOT shared between models: each was
 *   calibrated against its own score distribution (perplexity 0.15, jev 0.31,
 *   clef 0.11). Using one model's cutoff on another's output silently changes
 *   who gets escalated.
 * - `urgencyCeiling` is the highest urgency a slot may report. A small model
 *   asked for 0-4 will happily say 4; capping it keeps a weak model from
 *   claiming emergency authority it has not earned.
 */
export interface ModelSlot {
  id: string;
  cutoff: number;
  urgencyCeiling: number;
}

export interface ModelConfig {
  /** Full URL of the System One endpoint, path included. */
  endpoint: string;
  apiKey: string;
  /** Tried in order; the first slot that answers wins. */
  slots: ModelSlot[];
}

export interface WhatsAppConfig {
  /** E.164 digits, no leading '+'. */
  pairingNumber: string;
  authDir: string;
  /** "code" (default) or "qr". See PairingMode in channel/whatsapp.ts. */
  pairingMode: "code" | "qr";
}

export interface Config {
  model: ModelConfig;
  llm: IntakeModelConfig;
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

/** Always required, regardless of which channels are enabled. */
const REQUIRED_VARS = [
  "OPENROUTER_ENDPOINT",
  "OPENROUTER_API_KEY",
  "MODEL_PRIMARY_ID",
  "MODEL_FALLBACK_ID",
  "RED_FLAG_CUTOFF_PRIMARY",
  "RED_FLAG_CUTOFF_FALLBACK",
] as const;

/**
 * Default urgency ceilings by slot position: primary 4, fallback 3, tertiary 2.
 *
 * A smaller model sits later in the chain, so it gets less emergency authority.
 * Overridable per slot with MODEL_<POSITION>_URGENCY_CEILING.
 */
const DEFAULT_URGENCY_CEILINGS = [4, 3, 2] as const;

/**
 * Report every missing variable in one error.
 *
 * Failing on the first one turns setting up `.env` into a guessing game of
 * restart-and-see-what-is-missing-next.
 */
function assertRequiredPresent(env: Record<string, string | undefined>): void {
  const missing = REQUIRED_VARS.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new ConfigError(`Missing required environment variable(s): ${missing.join(", ")}`);
  }
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new ConfigError(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optional(env: Record<string, string | undefined>, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

function cutoff(env: Record<string, string | undefined>, name: string): number {
  const raw = required(env, name);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new ConfigError(`${name} must be a number between 0 and 1, got: ${raw}`);
  }
  return value;
}

function urgencyCeiling(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = optional(env, name);
  if (raw === null) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 4) {
    throw new ConfigError(`${name} must be an integer between 0 and 4, got: ${raw}`);
  }
  return value;
}

const POSITIONS = ["PRIMARY", "FALLBACK", "TERTIARY"] as const;

/**
 * Build the model chain from the environment.
 *
 * Primary and fallback are mandatory. Tertiary is optional but must be complete
 * if present: a slot with an id and no cutoff would silently escalate at the
 * primary's threshold.
 */
function modelConfig(env: Record<string, string | undefined>): ModelConfig {
  const slots: ModelSlot[] = [];

  for (const [index, position] of POSITIONS.entries()) {
    const idName = `MODEL_${position}_ID`;
    const isOptional = position === "TERTIARY";

    const id = isOptional ? optional(env, idName) : required(env, idName);
    if (id === null) continue;

    const ceilingName = `MODEL_${position}_URGENCY_CEILING`;
    const defaultCeiling = DEFAULT_URGENCY_CEILINGS[index] ?? 2;

    slots.push({
      id,
      cutoff: cutoff(env, `RED_FLAG_CUTOFF_${position}`),
      urgencyCeiling: urgencyCeiling(env, ceilingName, defaultCeiling),
    });
  }

  return {
    endpoint: required(env, "OPENROUTER_ENDPOINT"),
    apiKey: required(env, "OPENROUTER_API_KEY"),
    // Never logged: the key reaches the provider in an authorization header
    // and nothing else in the process reads it.
    slots,
  };
}

function whatsappConfig(env: Record<string, string | undefined>): WhatsAppConfig | null {
  if (env.WA_ENABLED !== "true") return null;

  const pairingMode = env.WA_PAIRING_MODE?.trim() || "code";
  if (pairingMode !== "code" && pairingMode !== "qr") {
    throw new ConfigError(`WA_PAIRING_MODE must be "code" or "qr", got: ${pairingMode}`);
  }

  // The QR flow is not bound to a number, so an unset pairing number is only
  // fatal in code mode - refusing to boot over an unused variable would be
  // wrong.
  const raw = env.WA_PAIRING_NUMBER?.trim() ?? "";
  if (pairingMode === "code" && raw === "") {
    throw new ConfigError("Missing required environment variable: WA_PAIRING_NUMBER");
  }
  if (raw !== "" && !/^\d{8,15}$/.test(raw)) {
    throw new ConfigError(
      `WA_PAIRING_NUMBER must be 8-15 digits, E.164 without '+', got: ${raw}`,
    );
  }

  return {
    pairingNumber: raw,
    authDir: env.WA_AUTH_DIR?.trim() || ".baileys",
    pairingMode,
  };
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

/**
 * The slot that answered, by id.
 *
 * Falls back to the first slot when the id is unknown (a provider that renames
 * its model mid-response, say). The primary's cutoff is the conservative
 * choice: it is the strictest of the three.
 */
export function slotFor(slots: ModelSlot[], modelId: string | null): ModelSlot {
  const found = modelId === null ? undefined : slots.find((slot) => slot.id === modelId);
  const first = slots[0];
  if (!first) throw new ConfigError("the model chain is empty");
  return found ?? first;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  assertRequiredPresent(env);

  return {
    model: modelConfig(env),
    llm: {
      endpoint: optional(env,'LLM_ENDPOINT') ?? 'https://openrouter.ai/api/v1/chat/completions',
      apiKey: required(env,'OPENROUTER_API_KEY'),
      modelId: optional(env,'LLM_MODEL_ID') ?? 'openrouter/auto',
    },
    whatsapp: whatsappConfig(env),
    port: port(env),
  };
}
