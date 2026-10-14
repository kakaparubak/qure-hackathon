/**
 * L1 execution: normalise a message, then test it against the pattern table.
 *
 * On a hit, L2 is skipped entirely. That is a hard architectural rule, not an
 * optimisation - the floor exists precisely because the model cannot be
 * trusted to be the last line of defence.
 */

import { RED_FLAG_RULES, type RedFlagFamily, type RedFlagRule } from "./patterns";

/**
 * The floor's verdict.
 *
 * A discriminated union rather than the flat `{hit, family, tier, playbookId}`
 * shape: on a miss there is no family and no tier, and pretending otherwise
 * invites reading `verdict.family` without checking `hit` first.
 */
export type RedFlagVerdict =
  | { hit: false; family: null; tier: null; playbookId: null; label: null }
  | {
      hit: true;
      family: RedFlagFamily;
      tier: "P1" | "P2";
      playbookId: string;
      label: string;
    };

export const NO_RED_FLAG: RedFlagVerdict = {
  hit: false,
  family: null,
  tier: null,
  playbookId: null,
  label: null,
};

/**
 * Words that carry no clinical signal and sit between the ones that do.
 *
 * This exists because patients do not write patterns. A smoke test on the
 * live process caught exactly this: "dada saya kayak di tinju" walked past a
 * table that listed "dada kayak di tinju", because the pronoun broke the
 * adjacency the substring match depends on. Enumerating every insertion would
 * never finish; dropping the insertions does.
 *
 * Deliberately conservative. Negations ("tidak", "bukan", "tanpa") are NOT
 * here - the floor does not parse negation, and quietly deleting it would look
 * like it does. Durations ("sejak", "hari", "jam") are left alone too: a
 * pattern like "demam tinggi" does not need them, and dropping them would
 * erase context a clinician reading the audit trail expects to see.
 */
const NOISE_WORDS = new Set([
  "saya",
  "aku",
  "gue",
  "gua",
  "kami",
  "kita",
  "kamu",
  "anda",
  "dia",
  "rasanya",
  "rasa",
  "terasa",
  "kayak",
  "kaya",
  "kayaknya",
  "seperti",
  "yang",
  "itu",
  "ini",
]);

/**
 * Lowercase, strip punctuation to spaces, drop noise words, collapse
 * whitespace.
 *
 * Both the message and the pattern table run through this, so a pattern is
 * written the way a patient would say it and still matches the variants.
 */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word !== "" && !NOISE_WORDS.has(word))
    .join(" ");
}

/**
 * The table, normalised once at load.
 *
 * Patterns go through the same function as messages, so "dada kayak di tinju"
 * becomes "dada di tinju" and matches however the patient padded it.
 */
const NORMALIZED_RULES: RedFlagRule[] = RED_FLAG_RULES.map((rule) => ({
  ...rule,
  patterns: rule.patterns.map(normalize),
}));

/**
 * Run the floor.
 *
 * Returns the first matching rule in table order (P1 families first), so a
 * message describing both a cardiac and a sepsis picture reports cardiac.
 */
export function scan(text: string): RedFlagVerdict {
  const normalized = normalize(text);
  if (normalized === "") return NO_RED_FLAG;

  for (const rule of NORMALIZED_RULES) {
    if (rule.patterns.some((pattern) => normalized.includes(pattern))) {
      return {
        hit: true,
        family: rule.family,
        tier: rule.tier,
        playbookId: rule.playbookId,
        label: rule.label,
      };
    }
  }

  return NO_RED_FLAG;
}

/** The normalised pattern table, for tests that assert on matching, not wording. */
export const normalizedPatterns = (): RedFlagRule[] => NORMALIZED_RULES;
