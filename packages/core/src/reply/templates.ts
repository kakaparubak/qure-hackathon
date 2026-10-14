/**
 * Patient-facing Bahasa Indonesia replies.
 *
 * Deliberately plain strings, not generated text: a clinician can correct this
 * file without reading any other code. The conversational LLM replaces the
 * non-escalation branches later; until then these are what reaches patients.
 *
 * ESCALATION IS NOT A TEMPLATE. It is a three-part message built by
 * playbooks.ts (acknowledgement + family playbook + safety closer), so the
 * wording here only covers the four non-escalation branches.
 */

import type { RedFlagFamily } from "../red-flag/patterns";
import { escalationText } from "./playbooks";

export type ReplyKind = "escalation" | "intake" | "follow_up" | "text_only";

export interface ReplyContext {
  /** The family that fired, so escalation can pick the right playbook. */
  family?: RedFlagFamily | null;
  /** Patient age in months, when known. */
  ageMonths?: number;
}

export const TEMPLATES: Record<ReplyKind, string> = {
  // The family-less escalation, i.e. the generic playbook. Kept here so the
  // table stays a complete map; replyFor() overrides it per family.
  escalation: escalationText(null),

  intake: [
    "Terima kasih, keluhan Anda sudah kami catat.",
    "Silakan datang ke puskesmas pada jam buka dan tunjukkan pesan ini di loket",
    "untuk masuk antrean.",
  ].join("\n"),

  follow_up: [
    "Terima kasih. Kami perlu sedikit informasi lagi untuk menilai keluhan Anda.",
    'Bisa dijelaskan: sejak kapan keluhannya, dan apakah ada keluhan lain? Contoh: "demam 3 hari, batuk, dan sesak napas".',
  ].join("\n"),

  text_only: [
    "Maaf, untuk sementara kami hanya bisa membaca pesan teks.",
    "Tolong ketik ya.",
  ].join("\n"),
};

export function replyFor(kind: ReplyKind, context: ReplyContext = {}): string {
  if (kind === "escalation") {
    return escalationText(context.family ?? null, { ageMonths: context.ageMonths });
  }

  return TEMPLATES[kind];
}
