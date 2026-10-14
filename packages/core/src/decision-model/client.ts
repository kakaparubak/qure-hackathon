/**
 * HTTP decision model: the configured slots tried in order, first answer wins.
 *
 * Returns a Decision or throws DecisionModelError - it never invents a
 * low-urgency answer. A caller that cannot get a decision must escalate; that
 * is the fail-upward property, and it is enforced by the orchestrator, not
 * softened here.
 */

import type { Decision, InboundMessage } from "../contracts";
import type { ModelSlot } from "../config";
import { buildRequest, parseDecision } from "./schema";
import { DecisionModelError, type DecisionModel } from "./types";

const TIMEOUT_MS = 8_000;

/** Named distinctly from config's ModelConfig: the barrel exports both. */
export interface DecisionModelConfig {
  endpoint: string;
  apiKey: string;
  slots: ModelSlot[];
}

async function askModel(
  config: DecisionModelConfig,
  slot: ModelSlot,
  msg: InboundMessage,
  fetchImpl: typeof fetch,
): Promise<Decision> {
  const response = await fetchImpl(config.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(buildRequest(slot.id, msg)),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    // A quota or auth error arrives as a JSON envelope with an `error` object;
    // the status alone is not enough to tell "rate limited" from "bad key".
    const preview = await response.text().catch(() => "");
    throw new DecisionModelError(
      `${slot.id} returned HTTP ${response.status}: ${preview.slice(0, 200)}`,
    );
  }

  const body: unknown = await response.json().catch((cause: unknown) => {
    throw new DecisionModelError(`${slot.id} returned a body that is not JSON`, cause);
  });

  return parseDecision(body, {
    requestedModelId: slot.id,
    urgencyCeiling: slot.urgencyCeiling,
  });
}

export function createDecisionModelClient(
  config: DecisionModelConfig,
  fetchImpl: typeof fetch = fetch,
): DecisionModel {
  return {
    async decide(msg: InboundMessage): Promise<Decision> {
      const failures: string[] = [];

      for (const slot of config.slots) {
        try {
          return await askModel(config, slot, msg, fetchImpl);
        } catch (error: unknown) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }

      throw new DecisionModelError(
        `All ${config.slots.length} decision model(s) failed: ${failures.join(" | ")}`,
      );
    },
  };
}
