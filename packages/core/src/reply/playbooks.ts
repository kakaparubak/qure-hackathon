/**
 * While-you-wait playbooks.
 *
 * Static, clinically sourced first-aid steps sent on escalation, selected by
 * the red-flag rule family. NEVER LLM-generated: a language model improvising
 * first aid to a patient who may be having a heart attack is not a risk worth
 * taking, and it is the one part of this system that must be auditable
 * line-by-line by a clinician.
 *
 * TWO DELIBERATE OMISSIONS, both load-bearing:
 *
 *   1. No medication advice anywhere. The cardiac playbook carries no aspirin
 *      step even though aspirin is standard pre-hospital care - screening for
 *      contraindications is too error-prone for a bot to gate. Medication
 *      stays with the nurse.
 *   2. Infant fever under 3 months gets no home advice at all: "go now".
 *      The playbook system knows its own limits.
 */

import { RED_FLAG_RULES, type RedFlagFamily } from "../red-flag/patterns";

export const PLAYBOOK_VERSION = "2";

/** Always the first line of an escalation. Queue placement is not a promise of immediate staffing or dispatch. */
export const ACKNOWLEDGEMENT = "Keluhan Anda ditandai darurat dan masuk antrean prioritas. Respons petugas belum dapat dipastikan.";

/** Always the last line of an escalation. PRD requires it present, unconditionally. */
export const SAFETY_CLOSER = "Hubungi 119 sekarang untuk bantuan medis darurat. Jangan menunggu balasan chat atau petugas puskesmas.";

/** Used when a red flag fired but no family-specific playbook applies. */
const GENERIC_PLAYBOOK_ID = "generic";

/** The id used when an infant under 3 months presents - overrides every family. */
export const INFANT_PLAYBOOK_ID = "infant_under_3_months";

export interface Playbook {
  id: string;
  title: string;
  /** Numbered imperative steps, in order. */
  steps: string[];
}

export const PLAYBOOKS: Record<string, Playbook> = {
  cardiac: {
    id: "cardiac",
    title: "Nyeri dada",
    steps: [
      "Duduk atau setengah berbaring. Jangan berbaring datar, jangan berdiri.",
      "Longgarkan pakaian yang ketat di dada dan leher.",
      "Berhenti semua aktivitas. Jangan mengangkat atau berjalan.",
      "Jika pingsan dan tidak bernapas, minta orang di sekitar melakukan tekan dada (CPR).",
    ],
  },

  stroke: {
    id: "stroke",
    title: "Gejala stroke",
    steps: [
      "Catat jam pertama kali gejala muncul. Waktu ini menentukan penanganan.",
      "Jangan beri makanan atau minuman apa pun - risiko tersedak.",
      "Berbaring miring ke sisi yang lemah jika sadar.",
      "Jangan beri obat penurun tekanan darah sendiri.",
    ],
  },

  bleeding: {
    id: "bleeding",
    title: "Perdarahan",
    steps: [
      "Tekan luka langsung dengan kain bersih, kuat dan terus-menerus.",
      "Jangan mengangkat kain untuk melihat luka. Tetap tekan.",
      "Tinggikan bagian yang berdarah di atas jantung jika memungkinkan.",
      "Jangan cabut benda yang menancap di luka. Tekan di sekitarnya.",
    ],
  },

  breathing: {
    id: "breathing",
    title: "Sesak napas",
    steps: [
      "Duduk tegak. Jangan berbaring.",
      "Buka jendela atau pindah ke udara segar.",
      "Longgarkan pakaian yang ketat.",
      "Jika punya inhaler sendiri, gunakan sesuai resep.",
    ],
  },

  consciousness: {
    id: "consciousness",
    title: "Kejang atau penurunan kesadaran",
    steps: [
      "Jangan menahan gerakan kejang.",
      "Jangan memasukkan apa pun ke dalam mulut.",
      "Catat berapa lama kejang berlangsung.",
      "Setelah kejang berhenti, miringkan tubuh ke samping.",
    ],
  },

  anaphylaxis: {
    id: "anaphylaxis",
    title: "Reaksi alergi berat",
    steps: [
      "Berhenti kontak dengan pemicunya, misalnya makanan atau obat.",
      "Duduk tegak jika sesak. Jika pusing, berbaring dengan kaki ditinggikan.",
      "Jika punya auto-injector epinefrin sesuai resep, gunakan pada paha.",
      "Keadaan ini bisa memburuk cepat. Cari bantuan medis darurat sekarang.",
    ],
  },

  pregnancy: {
    id: "pregnancy",
    title: "Darurat kehamilan",
    steps: [
      "Berbaring miring ke kiri.",
      "Catat jumlah dan warna darah yang keluar.",
      "Jangan memasukkan apa pun ke dalam vagina.",
      "Bawa buku KIA atau catatan kehamilan jika ada.",
    ],
  },

  mental_health: {
    id: "mental_health",
    title: "Krisis kesehatan jiwa",
    steps: [
      "Minta orang tepercaya menemani Anda sekarang.",
      "Jauhkan diri dari benda yang bisa melukai.",
      "Temui orang yang bisa menemani Anda sekarang.",
      "Jika merasa akan melukai diri, hubungi 119 sekarang.",
    ],
  },

  infection: {
    id: "infection",
    title: "Infeksi dengan tanda bahaya",
    steps: [
      "Istirahat dan banyak minum air.",
      "Ukur dan catat suhu tubuh setiap beberapa jam.",
      "Kompres hangat jika menggigil.",
      "Catat gejala lain yang muncul, untuk dilaporkan ke perawat.",
    ],
  },

  generic: {
    id: "generic",
    title: "Keluhan darurat",
    steps: [
      "Segera ke IGD puskesmas atau rumah sakit terdekat. Minta orang lain mengantar - jangan menyetir sendiri.",
      "Jangan makan atau minum sampai diperiksa.",
      "Siapkan identitas dan catatan obat yang sedang dikonsumsi.",
      "Tetap dekat dengan orang lain sampai bantuan datang.",
    ],
  },

  [INFANT_PLAYBOOK_ID]: {
    id: INFANT_PLAYBOOK_ID,
    title: "Bayi di bawah 3 bulan",
    steps: ["Segera bawa bayi ke fasilitas kesehatan sekarang. Jangan tunggu di rumah."],
  },
};

export interface PlaybookOptions {
  /**
   * Patient age in months, when known.
   *
   * An infant under 3 months overrides every family playbook: fever or
   * infection at that age is treated as an emergency with no home care, so the
   * only correct message is "go now". Age is not yet carried on the session,
   * so this stays unset until the patient profile lands - the rule is here and
   * tested so it is live the moment age is available.
   */
  ageMonths?: number;
}

/** An infant under 3 months overrides whatever else fired. */
function isInfant(ageMonths: number | undefined): boolean {
  return ageMonths !== undefined && ageMonths < 3;
}

/**
 * The family -> playbook mapping is owned by the rule table (patterns.ts), not
 * duplicated here. `severe_pain_poisoning`, for instance, intentionally maps to
 * the generic playbook - looking the family up by name would have missed it.
 */
function playbookIdFor(family: RedFlagFamily): string | undefined {
  return RED_FLAG_RULES.find((rule) => rule.family === family)?.playbookId;
}

export function playbookFor(family: RedFlagFamily | null, options: PlaybookOptions = {}): Playbook {
  if (isInfant(options.ageMonths)) {
    const infant = PLAYBOOKS[INFANT_PLAYBOOK_ID];
    if (infant) return infant;
  }

  const id = family ? playbookIdFor(family) : undefined;
  const byFamily = id ? PLAYBOOKS[id] : undefined;
  if (byFamily) return byFamily;

  const generic = PLAYBOOKS[GENERIC_PLAYBOOK_ID];
  if (!generic) throw new Error("the generic playbook is missing from the table");
  return generic;
}

/** Renders a playbook as numbered lines. */
export function renderSteps(playbook: Playbook): string {
  return playbook.steps.map((step, index) => `${index + 1}. ${step}`).join("\n");
}

/** The complete escalation message: acknowledgement, playbook, safety closer. */
export function escalationText(
  family: RedFlagFamily | null,
  options: PlaybookOptions = {},
): string {
  return [
    ACKNOWLEDGEMENT,
    "",
    renderSteps(playbookFor(family, options)),
    "",
    SAFETY_CLOSER,
  ].join("\n");
}
