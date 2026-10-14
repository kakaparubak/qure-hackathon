/**
 * L1 - the red-flag floor.
 *
 * A plain pattern table. No model, no network, no dependencies. This is a
 * SAFETY NET, not a classifier: recall over precision. Over-firing costs a
 * nurse one extra glance. Under-firing costs a life.
 *
 * NEGATION IS DELIBERATELY NOT HANDLED. "tidak ada nyeri dada" still fires.
 * Parsing negation correctly is L2's job, and a floor that tries to be clever
 * about it starts missing emergencies. Documented and intentional.
 *
 * Derivation: Permenkes 47/2018 emergency criteria (kriteria gawat darurat,
 * triase P1-P4, SPGDT), CDC stroke FAST signs, NICE NG253 sepsis guidance.
 *
 * Matching is a lowercase substring test against a normalised message, so
 * patterns must be written lowercase with single spaces.
 */

export type RedFlagFamily =
  | "cardiac"
  | "stroke_fast"
  | "breathing"
  | "consciousness"
  | "bleeding_trauma"
  | "sepsis_infection"
  | "anaphylaxis"
  | "pregnancy"
  | "mental_health_crisis"
  | "severe_pain_poisoning";

export interface RedFlagRule {
  family: RedFlagFamily;
  /** P1 = life-threatening now, P2 = urgent but not immediately critical. */
  tier: "P1" | "P2";
  /** Key into PLAYBOOKS. Every P1 rule must have one. */
  playbookId: string;
  /** Readable label for the audit trail, shown to the nurse. */
  label: string;
  /** Lowercase substrings. Any match fires the rule. */
  patterns: string[];
}

/**
 * Ten rule families. Order matters only for reporting: scan() returns the
 * first hit and P1 rules are listed before P2 rules.
 */
export const RED_FLAG_RULES: RedFlagRule[] = [
  {
    family: "cardiac",
    tier: "P1",
    playbookId: "cardiac",
    label: "Possible cardiac event (chest pain / heart attack)",
    patterns: [
      "nyeri dada",
      "dada nyeri",
      "dada sakit",
      "sakit dada",
      "dada terasa ditekan",
      "dada kayak ditekan",
      "dada di tinju",
      "dada kayak di tinju",
      "dada ditusuk",
      "dada terbakar",
      "dada berat",
      "nyeri menjalar",
      "menjalar ke lengan",
      "menjalar ke rahang",
      "keringat dingin",
      "jantung berdebar kencang",
      "berdebar kencang",
      "nyeri ulu hati hebat",
    ],
  },
  {
    family: "stroke_fast",
    tier: "P1",
    playbookId: "stroke",
    label: "Possible stroke (FAST signs)",
    patterns: [
      "wajah miring",
      "muka miring",
      "mulut miring",
      "bicara pelo",
      "pelo",
      "bicara cadel",
      "bicara tidak jelas mendadak",
      "satu sisi lemah",
      "lengan lemah",
      "tangan lemah sebelah",
      "kaki lemah sebelah",
      "badan lemah sebelah",
      "mati rasa sebelah",
      "kesemutan sebelah",
      "lumpuh mendadak",
      "mendadak lemah",
      "pandangan kabur mendadak",
      "sakit kepala hebat mendadak",
      "sakit kepala paling hebat",
    ],
  },
  {
    family: "breathing",
    tier: "P1",
    playbookId: "breathing",
    label: "Severe breathing difficulty",
    patterns: [
      "sesak napas",
      "sesak nafas",
      "susah napas",
      "susah nafas",
      "sulit bernapas",
      "sulit bernafas",
      "tidak bisa napas",
      "tidak bisa nafas",
      "gak bisa napas",
      "nggak bisa napas",
      "napas pendek",
      "napas cepat",
      "napas berbunyi",
      "mengi",
      "wheezing",
      "megap-megap",
      "ngos-ngosan berat",
      "bibir biru",
      "ujung jari biru",
    ],
  },
  {
    family: "consciousness",
    tier: "P1",
    playbookId: "consciousness",
    label: "Reduced consciousness or seizure",
    patterns: [
      "tidak sadar",
      "gak sadar",
      "nggak sadar",
      "hilang kesadaran",
      "pingsan",
      "kejang",
      "step",
      "ayan",
      "epilepsi kambuh",
      "koma",
      "sulit dibangunkan",
      "tidak bisa dibangunkan",
      "mengantuk terus tidak bangun",
      "bingung berat",
    ],
  },
  {
    family: "bleeding_trauma",
    tier: "P1",
    playbookId: "bleeding",
    label: "Major bleeding or trauma",
    patterns: [
      "darah banyak",
      "berdarah terus",
      "tidak berhenti berdarah",
      "pendarahan",
      "perdarahan",
      "muntah darah",
      "batuk darah",
      "bab berdarah banyak",
      "kecelakaan",
      "tabrakan",
      "tertabrak",
      "jatuh dari ketinggian",
      "patah tulang",
      "tulang keluar",
      "luka terbuka lebar",
      "terbentur kepala",
      "kepala terbentur",
    ],
  },
  {
    family: "anaphylaxis",
    tier: "P1",
    playbookId: "anaphylaxis",
    label: "Possible anaphylaxis",
    patterns: [
      "bengkak bibir",
      "bibir bengkak",
      "bengkak tenggorokan",
      "tenggorokan bengkak",
      "lidah bengkak",
      "sulit menelan dan sesak",
      "sesak setelah makan",
      "sesak setelah minum obat",
      "gatal seluruh badan dan sesak",
      "alergi berat",
    ],
  },
  {
    family: "pregnancy",
    tier: "P1",
    playbookId: "pregnancy",
    label: "Obstetric emergency",
    patterns: [
      "hamil keluar darah",
      "hamil berdarah",
      "keluar darah hamil",
      "air ketuban",
      "ketuban pecah",
      "gerakan bayi berkurang",
      "bayi tidak bergerak",
      "nyeri perut hebat hamil",
      "kontraksi hebat",
      "hamil sakit perut hebat",
    ],
  },
  {
    family: "mental_health_crisis",
    tier: "P1",
    playbookId: "mental_health",
    label: "Mental health crisis",
    patterns: [
      "bunuh diri",
      "ingin mati",
      "mau mati",
      "pengen mati",
      "mengakhiri hidup",
      "akhiri hidup",
      "menyakiti diri",
      "nyakitin diri",
      "melukai diri",
      "merusak diri",
      "minum obat banyak sengaja",
    ],
  },
  {
    family: "severe_pain_poisoning",
    tier: "P1",
    playbookId: "generic",
    label: "Severe pain or poisoning",
    patterns: [
      "minum racun",
      "menelan racun",
      "keracunan",
      "racun",
      "pestisida",
      "minum obat banyak",
      "overdosis",
      "sakit perut hebat",
      "nyeri hebat",
      "nyeri tak tertahankan",
      "sakit sekali sampai tidak bisa berdiri",
    ],
  },
  {
    family: "sepsis_infection",
    tier: "P2",
    playbookId: "infection",
    label: "Possible sepsis (infection with warning signs)",
    patterns: [
      "demam tinggi",
      "panas tinggi",
      "demam menggigil",
      "menggigil hebat",
      "demam dan lemas berat",
      "demam tidak turun",
      "luka bernanah dan demam",
      "badan dingin dan lemah",
      "kulit berbintik dan demam",
      "infeksi berat",
    ],
  },
];
