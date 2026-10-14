/**
 * The System One wire format, in one file.
 *
 * This is the ONLY place that knows the provider's JSON shape. Request and
 * response live together deliberately: they are two halves of one contract, and
 * splitting them is how the questions the model is asked drift away from the
 * answers the parser expects.
 *
 * Wire format (OpenRouter System One, `POST /api/v1/systemone`):
 *
 *   request   { model, state, questions }
 *             questions is a map of name -> { type, instructions, criteria }
 *   response  { id, model, provider, answers, usage }
 *             answers is keyed by question name; each answer carries its own
 *             `type` discriminant (noul | choice | score).
 *
 * Six questions, one request. They share a single `state` (the patient's
 * message) so the model reasons about one situation rather than six.
 */

import { z } from "zod";
import type { Clarity, ComplaintCategory, Decision, InboundMessage } from "../contracts";
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

/** The five ordered urgency levels. Index is the level, so index 4 is an emergency. */
export const URGENCY_LEVELS = [
  "Tidak perlu perawatan medis; bisa ditangani sendiri di rumah.",
  "Bisa ditangani di rumah dengan pemantauan; tidak perlu datang hari ini.",
  "Perlu diperiksa di puskesmas, tapi tidak darurat - bisa dalam beberapa hari.",
  "Perlu diperiksa hari ini; kondisi bisa memburuk jika ditunda.",
  "Darurat medis sekarang; nyawa terancam jika tidak segera ditangani.",
] as const;

const CLARITY_CRITERIA: Record<Clarity, string> = {
  crystal_clear: "Jelas menyebut keluhan kesehatan, durasi, dan gejala spesifik.",
  mostly_clear: "Ada keluhan kesehatan yang bisa dipahami, walau detail kurang.",
  ambiguous: "Teks bisa jadi keluhan kesehatan, tapi terlalu kabur untuk dinilai.",
  gibberish: "Bukan keluhan kesehatan: sapaan, salah kirim, teks acak, atau kosong.",
};

const CATEGORY_CRITERIA: Record<ComplaintCategory, string> = {
  chest_cardiac: "Nyeri dada, jantung, atau pembuluh darah.",
  breathing: "Sesak napas, batuk, atau saluran napas.",
  neuro_consciousness: "Kejang, pingsan, stroke, atau saraf.",
  bleeding_trauma: "Perdarahan, luka, patah tulang, atau kecelakaan.",
  fever_infection: "Demam atau tanda infeksi.",
  digestive: "Mual, muntah, diare, atau nyeri perut.",
  mental_health: "Kesehatan jiwa, termasuk keinginan menyakiti diri.",
  chronic_medication: "Obat rutin, kontrol penyakit kronis, atau rujukan.",
  minor: "Keluhan ringan yang tidak butuh penanganan segera.",
  other: "Tidak masuk kategori mana pun di atas.",
};

/**
 * The six questions. `criteria` is the provider's own vocabulary for each type:
 * an object of true/false descriptions for `noul`, an option map for `choice`,
 * an ordered array of levels for `score`.
 */
export const QUESTIONS = {
  urgency: {
    type: "score",
    instructions:
      "Seberapa mendesak kondisi ini butuh perhatian medis sekarang? Nilai berdasarkan gejala yang disebut, bukan berdasarkan keparahan kata-kata.",
    criteria: URGENCY_LEVELS,
  },
  clarity: {
    type: "choice",
    instructions: "Seberapa jelas pesan ini menggambarkan keluhan kesehatan yang sebenarnya?",
    criteria: CLARITY_CRITERIA,
  },
  red_flag: {
    type: "noul",
    instructions:
      "Apakah pesan ini menyebut gejala yang bisa mengancam nyawa saat ini? Jika ragu, condong ke jawaban ya.",
    criteria: {
      true: "Ada gejala yang bisa mengancam nyawa saat ini.",
      false: "Tidak ada gejala yang mengancam nyawa.",
    },
  },
  red_flag_informal: {
    type: "noul",
    instructions:
      "Dengan mengabaikan bahasa gaul, singkatan, dan salah ketik, apakah ini bisa jadi kegawatan medis?",
    criteria: {
      true: "Bisa jadi kegawatan medis meskipun bahasanya informal.",
      false: "Tetap bukan kegawatan medis setelah bahasa informal diterjemahkan.",
    },
  },
  wants_human: {
    type: "noul",
    instructions:
      "Apakah penulisnya ingin bicara dengan petugas manusia, bukan sistem otomatis? Termasuk permintaan bicara dengan perawat atau dokter.",
    criteria: {
      true: "Ingin bicara dengan petugas manusia.",
      false: "Tidak meminta petugas manusia.",
    },
  },
  category: {
    type: "choice",
    instructions: "Apa kategori keluhan utama pesan ini?",
    criteria: CATEGORY_CRITERIA,
  },
} as const;

export interface SystemOneRequest {
  model: string;
  state: { message: string };
  questions: typeof QUESTIONS;
}

/**
 * Build the request body.
 *
 * The state is the patient's message and nothing else. Adding derived context
 * here (history, guesses) would change what every question is answered against,
 * and the six are meant to be judged on the same evidence.
 */
export function buildRequest(modelId: string, msg: InboundMessage): SystemOneRequest {
  return {
    model: modelId,
    state: { message: msg.text },
    questions: QUESTIONS,
  };
}

/** `noul` answers: a probability of yes. */
const NOUL_ANSWER = z.object({ type: z.literal("noul"), noul: probability });

/** `choice` answers: the selected option, plus optional per-option probabilities. */
const CHOICE_ANSWER = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  confidence: probability.nullish(),
});

/** `score` answers: a probability-weighted position on the scale. */
const SCORE_ANSWER = z.object({
  type: z.literal("score"),
  score: z.number(),
  confidence: probability.nullish(),
});

const PROVIDER_RESPONSE = z.object({
  answers: z.object({
    urgency: SCORE_ANSWER,
    clarity: CHOICE_ANSWER,
    red_flag: NOUL_ANSWER,
    red_flag_informal: NOUL_ANSWER.nullish(),
    wants_human: NOUL_ANSWER,
    category: CHOICE_ANSWER.nullish(),
  }),
});

function asClarity(value: string): Clarity {
  const match = CLARITY_VALUES.find((option) => option === value);
  // An unrecognised option means the model did not answer the question. L3
  // treats "do not trust this decision" as a follow-up question, which is
  // exactly where "ambiguous" routes, so it is the honest landing spot.
  return match ?? "ambiguous";
}

function asCategory(value: string | null | undefined): ComplaintCategory | null {
  if (value === null || value === undefined) return null;
  return CATEGORY_VALUES.find((option) => option === value) ?? null;
}

export interface ParseOptions {
  /**
   * The slug that was requested. The response echoes a *dated* model id
   * (`...-20251014`), which would not match the configured slot, so the
   * requested id is what gets recorded.
   */
  requestedModelId: string;
  /**
   * Highest urgency this slot may report. A model asked for 0-4 will use 4;
   * the ceiling is how a weak model is kept from claiming emergency authority.
   */
  urgencyCeiling: number;
}

/**
 * Parse a raw provider body into a Decision.
 *
 * @throws DecisionModelError on any malformed input. Callers escalate.
 */
export function parseDecision(body: unknown, options: ParseOptions): Decision {
  const parsed = PROVIDER_RESPONSE.safeParse(body);
  if (!parsed.success) {
    throw new DecisionModelError(
      `Provider body is not a System One response: ${parsed.error.message}`,
    );
  }

  const a = parsed.data.answers;

  return {
    source: "decision_model",
    urgency: Math.min(Math.max(a.urgency.score, 0), options.urgencyCeiling),
    urgencyConfidence: a.urgency.confidence ?? null,
    clarity: asClarity(a.clarity.choice),
    redFlag: a.red_flag.noul,
    redFlagInformal: a.red_flag_informal?.noul ?? null,
    wantsHuman: a.wants_human.noul,
    category: asCategory(a.category?.choice),
    matchedFamily: null,
    model: options.requestedModelId,
    raw: body,
  };
}
