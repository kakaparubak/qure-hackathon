/**
 * L1 execution: normalise a message, then test it against the pattern table.
 *
 * On a hit, L2 is skipped entirely. That is a hard architectural rule, not an
 * optimisation - the floor exists precisely because the model cannot be
 * trusted to be the last line of defence.
 */

import { RED_FLAG_RULES, type RedFlagFamily } from "./patterns";

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
 * Lowercase, strip punctuation to spaces, collapse whitespace.
 *
 * Patients write "Nyeri  dada!!" and "nyeri dadanya" - the first must match,
 * the second must still match on the "nyeri dada" substring.
 */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Run the floor.
 *
 * Returns the first matching rule in table order (P1 families first), so a
 * message describing both a cardiac and a sepsis picture reports cardiac.
 */
export function scan(text: string): RedFlagVerdict {
  const normalized = normalize(text);
  if (normalized === "") return NO_RED_FLAG;

  for (const rule of RED_FLAG_RULES) {
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
