/**
 * HTTP decision model: primary slug first, fallback slug on any primary
 * failure. Returns a Decision or throws DecisionModelError - it never
 * invents a low-urgency answer.
 */

import type { Config } from "../config";
import type { Decision, InboundMessage } from "../contracts";
import { parseDecision, SYSTEM_PROMPT } from "./schema";
import { DecisionModelError, type DecisionModel } from "./types";

const TIMEOUT_MS = 8_000;

/** Named distinctly from config's ModelConfig: the barrel exports both. */
export type DecisionModelConfig = Pick<
  Config["model"],
  "endpoint" | "apiKey" | "primaryId" | "fallbackId"
>;

async function askModel(
  config: DecisionModelConfig,
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
    const preview = await response.text().catch(() => "");
    throw new DecisionModelError(
      `${modelId} returned HTTP ${response.status}: ${preview.slice(0, 200)}`,
    );
  }

  const body: unknown = await response.json().catch((cause: unknown) => {
    throw new DecisionModelError(`${modelId} returned a body that is not JSON`, cause);
  });

  return parseDecision(body, modelId);
}

export function createDecisionModelClient(
  config: DecisionModelConfig,
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
