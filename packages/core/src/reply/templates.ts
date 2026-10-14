/**
 * Patient-facing Bahasa Indonesia replies.
 *
 * Deliberately plain strings, not generated text: a clinician can correct this
 * file without reading any other code. The conversational LLM replaces this
 * later; until then these are what actually reaches patients.
 */

export type ReplyKind = "emergency" | "urgent" | "routine" | "unclear";

export const TEMPLATES: Record<ReplyKind, string> = {
  emergency: [
    "⚠️ Keluhan Anda bisa berbahaya dan perlu ditangani SEKARANG.",
    "Segera ke IGD puskesmas atau rumah sakit terdekat, atau hubungi 119.",
    "Minta bantuan orang lain untuk mengantar - jangan menyetir sendiri.",
  ].join("\n"),

  urgent: [
    "Terima kasih. Keluhan Anda perlu diperiksa hari ini.",
    "Silakan datang ke puskesmas sekarang dan tunjukkan pesan ini di loket.",
  ].join("\n"),

  routine: [
    "Terima kasih, keluhan Anda sudah kami catat.",
    "Silakan datang ke puskesmas pada jam buka dan tunjukkan pesan ini di loket",
    "untuk masuk antrean.",
  ].join("\n"),

  unclear: [
    "Maaf, kami belum memahami keluhan Anda.",
    'Bisa dijelaskan lagi? Contoh: "demam 3 hari, batuk, dan sesak napas".',
  ].join("\n"),
};

export function replyFor(kind: ReplyKind): string {
  return TEMPLATES[kind];
}
