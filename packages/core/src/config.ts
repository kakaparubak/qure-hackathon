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
  assertRequiredPresent(env);

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
