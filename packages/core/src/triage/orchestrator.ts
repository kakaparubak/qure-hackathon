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
export function cutoffFor(modelId: string | null, cutoffs: Cutoffs): number {
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

/**
 * The decision used when the model could not be reached.
 *
 * redFlag is 1 by construction: this is what makes "escalate on failure" a
 * property of the data rather than a special case in the ladder.
 */
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

/** Rejects after `ms`. Used to bound the model call. */
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

  // Insertion-ordered Set used as a ring buffer: re-adding a present id does
  // not move it, so duplicates are caught before any eviction happens.
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
      // Never log the failure and reply as if all is well. Escalate.
      decision = escalationDecision();
    }

    const kind: ReplyKind =
      msg.kind !== "text" || msg.text.trim() === ""
        ? "unclear"
        : replyKindFor(decision, deps.cutoffs);

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
