/**
 * Provider response -> Decision.
 *
 * This file is the ONLY place that knows the provider's JSON shape. If the
 * System One endpoint turns out to differ from the chat-completions shape
 * assumed here, re-record a real body, change PROVIDER_RESPONSE, and nothing
 * outside this file moves.
 */

import { z } from "zod";
import type { Clarity, ComplaintCategory, Decision } from "../contracts";
import { DecisionModelError } from "./types";

const CLARITY_VALUES = ["crystal_clear", "mostly_clear", "ambiguous", "gibberish"] as const;
const CATEGORY_VALUES = [
  "chest_cardiac",
  "breathing",
  "neuro_consciousness",
  "bleeding_trauma",
  "fever_infection",
  "digestive",
  "mental_health",
  "chronic_medication",
  "minor",
  "other",
] as const;

const probability = z.number().min(0).max(1);

/** The six answers, as the model returns them. */
export const ANSWER_SCHEMA = z.object({
  urgency: z.number().min(0).max(4).nullish(),
  urgency_confidence: probability.nullish(),
  clarity: z.enum(CLARITY_VALUES).nullish(),
  red_flag: probability,
  red_flag_informal: probability.nullish(),
  wants_human: probability,
  category: z.enum(CATEGORY_VALUES).nullish(),
});

const PROVIDER_RESPONSE = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string() }) }))
    .min(1, "provider returned no choices"),
});

/** Strips a ```json fence if the model wrapped its JSON in one. */
function unfence(content: string): string {
  const fenced = content.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return (fenced?.[1] ?? content).trim();
}

/**
 * Parse a raw provider body into a Decision.
 *
 * @throws DecisionModelError on any malformed input. Callers escalate.
 */
export function parseDecision(body: unknown, modelId: string): Decision {
  const envelope = PROVIDER_RESPONSE.safeParse(body);
  if (!envelope.success) {
    throw new DecisionModelError(
      `Provider body is not a chat completion: ${envelope.error.message}`,
    );
  }

  const content = envelope.data.choices[0]?.message.content ?? "";

  let decoded: unknown;
  try {
    decoded = JSON.parse(unfence(content));
  } catch (cause) {
    throw new DecisionModelError(`Provider content is not JSON: ${content.slice(0, 200)}`, cause);
  }

  const answers = ANSWER_SCHEMA.safeParse(decoded);
  if (!answers.success) {
    throw new DecisionModelError(`Provider answers failed validation: ${answers.error.message}`);
  }

  const a = answers.data;

  return {
    source: "decision_model",
    urgency: a.urgency ?? null,
    urgencyConfidence: a.urgency_confidence ?? null,
    clarity: (a.clarity ?? null) as Clarity | null,
    redFlag: a.red_flag,
    redFlagInformal: a.red_flag_informal ?? null,
    wantsHuman: a.wants_human,
    category: (a.category ?? null) as ComplaintCategory | null,
    matchedFamily: null,
    model: modelId,
    raw: body,
  };
}

/**
 * The instruction sent as the system turn. Kept beside the schema it must
 * satisfy so the two cannot drift apart.
 */
export const SYSTEM_PROMPT = [
  "You triage WhatsApp messages from patients in Indonesia, for a puskesmas.",
  "Reply with a single JSON object and nothing else. Keys:",
  '  "urgency": number 0-4 (0 no care needed, 4 life-threatening now)',
  '  "urgency_confidence": number 0-1',
  '  "clarity": one of crystal_clear | mostly_clear | ambiguous | gibberish',
  '  "red_flag": number 0-1, probability this is life-threatening right now',
  '  "red_flag_informal": number 0-1, same question with slang and typos discounted',
  '  "wants_human": number 0-1, probability the author wants a human not a bot',
  '  "category": one of chest_cardiac | breathing | neuro_consciousness | bleeding_trauma |',
  "               fever_infection | digestive | mental_health | chronic_medication | minor | other",
  "Text may be Bahasa Indonesia, informal, with slang and typos.",
  "Recall matters more than precision: when unsure, raise red_flag.",
].join("\n");
