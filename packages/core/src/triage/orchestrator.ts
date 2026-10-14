/**
 * The loop: inbound message in, outbound reply out.
 *
 * Three properties this file exists to guarantee:
 *
 *   1. THE FLOOR RUNS FIRST, and on a hit the decision model is never called.
 *      That is a hard architectural rule, not an optimisation: the floor is
 *      the layer that cannot be talked out of an emergency by a confident
 *      sentence, and calling the model anyway would make its verdict advisory.
 *   2. A model failure ESCALATES. Timeout, provider error, or an unusable body
 *      produces the escalation message, never a reassuring one.
 *   3. A message is answered at most once, no matter how often the transport
 *      re-delivers it.
 *
 * Every branch below can only move a patient UP the ladder. There is no path
 * that reads a red flag and replies with something calmer.
 */

import type { Decision, InboundMessage, OutboundMessage, WhatsAppChannel } from "../contracts";
import type { ModelSlot } from "../config";
import { slotFor } from "../config";
import type { DecisionModel } from "../decision-model/types";
import type { RedFlagFamily } from "../red-flag/patterns";
import { scan } from "../red-flag/floor";
import { replyFor, type ReplyKind } from "../reply/templates";

/** Above this, a request for a human is honoured regardless of urgency. */
const WANTS_HUMAN_CUTOFF = 0.5;

/** At or above this, the urgency answer alone escalates. */
const URGENCY_ESCALATION_THRESHOLD = 3;

const DEFAULT_TIMEOUT_MS = 9_000;
const DEFAULT_SEEN_LIMIT = 500;

export interface OrchestratorDeps {
  model: DecisionModel;
  /** The model chain, in order. Carries each slot's cutoff and urgency ceiling. */
  slots: ModelSlot[];
  channel: WhatsAppChannel;
  timeoutMs?: number;
  seenLimit?: number;
  /**
   * One line per triaged message, naming the layer that decided and why.
   *
   * This is the audit trail: without it, "the floor answered and the model was
   * never called" is only provable in tests, never on a live channel.
   */
  logger?: (message: string) => void;
}

export interface Orchestrator {
  handleInbound(msg: InboundMessage): Promise<OutboundMessage | null>;
  /** Registered on the channel; wires the transport to the loop. */
  onInbound(msg: InboundMessage): Promise<void>;
  seenCount(): number;
}

/**
 * Why a message escalated. Recorded so the audit trail can answer "why was
 * this paged to a nurse?" without re-running the pipeline.
 */
export type EscalationReason =
  | "red_flag_floor"
  | "urgency"
  | "red_flag"
  | "wants_human"
  | "model_failure";

/**
 * The L4 ladder, as a lookup rather than a chain of ifs.
 *
 * Floor first: a hit there is the strongest signal the system has, and it must
 * not be re-litigated by a model that answered a different question.
 */
export function escalationReasonFor(
  decision: Decision,
  slots: ModelSlot[],
): EscalationReason | null {
  if (decision.source === "red_flag_floor") return "red_flag_floor";
  if (decision.wantsHuman >= WANTS_HUMAN_CUTOFF) return "wants_human";
  if ((decision.urgency ?? 0) >= URGENCY_ESCALATION_THRESHOLD) return "urgency";

  // The cutoff belongs to the model that answered: 0.20 is an emergency on a
  // model calibrated at 0.15 and a routine case on one calibrated at 0.31.
  if (decision.redFlag >= slotFor(slots, decision.model).cutoff) return "red_flag";

  return null;
}

/**
 * Decide what the patient gets.
 *
 * Exported so the ladder is testable without constructing an orchestrator.
 */
export function replyKindFor(decision: Decision, slots: ModelSlot[]): ReplyKind {
  if (escalationReasonFor(decision, slots) !== null) return "escalation";

  // Ambiguity is checked AFTER escalation, never before: asking a clarifying
  // question is a de-escalation, and it must be unreachable once anything has
  // fired.
  if (decision.clarity === "ambiguous" || decision.clarity === "gibberish") return "follow_up";

  return "intake";
}

/** A floor hit turned into a Decision, so the rest of the pipeline sees one shape. */
function floorDecision(family: RedFlagFamily, label: string): Decision {
  return {
    source: "red_flag_floor",
    // The floor classifies; it does not score. Inventing an urgency number here
    // would put a made-up value in the audit trail.
    urgency: null,
    urgencyConfidence: null,
    clarity: null,
    redFlag: 1,
    redFlagInformal: null,
    wantsHuman: 0,
    category: null,
    matchedFamily: family,
    model: null,
    raw: { red_flag_floor: label },
  };
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

    // Non-text payloads get no triage at all: there is nothing to read, and a
    // decision invented from an empty string is worse than no decision.
    if (msg.kind !== "text" || msg.text.trim() === "") {
      return { phone: msg.phone, text: replyFor("text_only"), purpose: "reply" };
    }

    // L1. The floor answers without a network call, and on a hit nothing below
    // it runs.
    const verdict = scan(msg.text);

    let decision: Decision;
    let family: RedFlagFamily | null = null;
    let reason: EscalationReason | null = null;

    if (verdict.hit) {
      decision = floorDecision(verdict.family, verdict.label);
      family = verdict.family;
      reason = "red_flag_floor";
    } else {
      try {
        decision = await decideWithin(deps.model, msg, timeoutMs);
      } catch {
        // Never log the failure and reply as if all is well. Escalate.
        decision = escalationDecision();
        reason = "model_failure";
      }

      // Only the floor knows a family; a model that escalated gets the generic
      // playbook, because guessing which first-aid steps apply from a category
      // label is exactly the kind of inference that should not be automated.
      reason ??= escalationReasonFor(decision, deps.slots);
    }

    const kind: ReplyKind = reason !== null ? "escalation" : replyKindFor(decision, deps.slots);

    deps.logger?.(
      `triage ${msg.phone}: source=${decision.source} reason=${reason ?? "none"} kind=${kind}` +
        (family ? ` family=${family}` : ""),
    );

    return {
      phone: msg.phone,
      text: replyFor(kind, { family }),
      // An escalation that carries first-aid guidance is a playbook, not a
      // conversational reply - the distinction is what playbook_log records.
      purpose: kind === "escalation" ? "playbook" : "reply",
    };
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
