/**
 * Normalized answer shape for the triage decision layers.
 *
 * Three providers (pplx-decider, jev, clef) return three different JSON shapes.
 * Every one of them is converted into this single object so the orchestrator
 * never learns which model answered. That is what makes the model slot
 * swappable (see CLAUDE.md).
 */

/** How clearly the patient's message describes an actual health complaint. */
export type Clarity = "crystal_clear" | "mostly_clear" | "ambiguous" | "gibberish";

/** Main complaint category, used to build the structured pre-visit record. */
export type ComplaintCategory =
  | "chest_cardiac"
  | "breathing"
  | "neuro_consciousness"
  | "bleeding_trauma"
  | "fever_infection"
  | "digestive"
  | "mental_health"
  | "chronic_medication"
  | "minor"
  | "other";

/**
 * Which layer produced the decision. Recorded on every triage_results row so
 * the audit trail can answer "why was this escalated?" - including the case
 * where the deterministic floor short-circuited the model entirely.
 */
export type DecisionSource = "red_flag_floor" | "decision_model" | "llm";

/**
 * The single decision object the pipeline reasons about.
 *
 * Decision logic in the orchestrator reduces to comparing probabilities
 * against a per-model cutoff, e.g. `decision.redFlag >= cutoffFor(decision.model)`.
 */
export interface Decision {
  /** Which layer produced this. */
  source: DecisionSource;

  /**
   * Urgency on a 0-4 scale (0 = no care needed, 4 = life-threatening emergency).
   * Kept as a plain number because models return probability-weighted positions
   * that can land between levels (e.g. 3.41).
   * null when the floor short-circuited: the floor classifies, it does not score.
   */
  urgency: number | null;

  /** Confidence in the urgency answer, 0-1. null when not applicable. */
  urgencyConfidence: number | null;

  /** How clear the complaint was to the model. null when the floor answered. */
  clarity: Clarity | null;

  /** P(yes) that the message describes something life-threatening right now. Always present. */
  redFlag: number;

  /** P(yes) for the same question asked with slang and typos explicitly discounted. */
  redFlagInformal: number | null;

  /** P(yes) that the author wants a human staff member instead of an automated system. */
  wantsHuman: number;

  /** Main complaint category, or null when unclassifiable. */
  category: ComplaintCategory | null;

  /** Which red-flag rule family matched. Set only by the floor, null otherwise. */
  matchedFamily: string | null;

  /** Model that answered, e.g. "pplx-decider-v1.1-27b". null for the floor. */
  model: string | null;

  /** Unmodified provider response, persisted to triage_results.findings for auditing. */
  raw: unknown;
}
