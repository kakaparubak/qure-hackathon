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
