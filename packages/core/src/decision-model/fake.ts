import type { Decision, InboundMessage } from "../contracts";
import type { DecisionModel } from "./types";

/**
 * Deterministic stand-in. `mode` selects the behaviour a test needs, so a
 * single fake covers the happy path, provider failure, and a hung response.
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
