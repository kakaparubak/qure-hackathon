import { describe, expect, test } from "bun:test";
import { normalize, scan } from "./floor";
import { RED_FLAG_RULES } from "./patterns";

describe("normalize", () => {
  test("lowercases", () => {
    expect(normalize("NYERI DADA")).toBe("nyeri dada");
  });

  test("strips punctuation", () => {
    expect(normalize("Nyeri dada!!")).toBe("nyeri dada");
  });

  test("collapses runs of whitespace", () => {
    expect(normalize("nyeri    dada")).toBe("nyeri dada");
  });

  test("trims", () => {
    expect(normalize("  nyeri dada  ")).toBe("nyeri dada");
  });

  test("empty stays empty", () => {
    expect(normalize("")).toBe("");
    expect(normalize("!!!")).toBe("");
  });
});

describe("scan - formal Bahasa", () => {
  test("chest pain fires cardiac at P1", () => {
    const verdict = scan("saya nyeri dada sejak tadi malam");

    expect(verdict.hit).toBe(true);
    expect(verdict.family).toBe("cardiac");
    expect(verdict.tier).toBe("P1");
    expect(verdict.playbookId).toBe("cardiac");
  });

  test("stroke signs fire stroke_fast", () => {
    expect(scan("mulut miring dan bicara pelo").family).toBe("stroke_fast");
  });

  test("breathing difficulty fires breathing", () => {
    expect(scan("anak saya sesak napas").family).toBe("breathing");
  });

  test("seizure fires consciousness", () => {
    expect(scan("kejang selama dua menit").family).toBe("consciousness");
  });

  test("major bleeding fires bleeding_trauma", () => {
    expect(scan("luka di kaki berdarah terus").family).toBe("bleeding_trauma");
  });

  test("anaphylaxis fires on throat swelling", () => {
    expect(scan("bengkak tenggorokan setelah makan udang").family).toBe("anaphylaxis");
  });

  test("obstetric bleeding fires pregnancy", () => {
    expect(scan("saya hamil keluar darah").family).toBe("pregnancy");
  });

  test("suicidal ideation fires mental_health_crisis", () => {
    expect(scan("saya ingin mati").family).toBe("mental_health_crisis");
  });

  test("poisoning fires severe_pain_poisoning", () => {
    expect(scan("anak saya menelan racun").family).toBe("severe_pain_poisoning");
  });

  test("sepsis picture fires sepsis_infection at P2", () => {
    const verdict = scan("demam menggigil tiga hari");

    expect(verdict.family).toBe("sepsis_infection");
    expect(verdict.tier).toBe("P2");
  });
});

describe("scan - colloquial Bahasa", () => {
  test("dada kayak di tinju", () => {
    expect(scan("dada kayak di tinju rasanya").family).toBe("cardiac");
  });

  test("keringat dingin", () => {
    expect(scan("keringat dingin terus").family).toBe("cardiac");
  });

  test("gak bisa napas", () => {
    expect(scan("gak bisa napas").family).toBe("breathing");
  });

  test("fires when only the surrounding words are misspelled", () => {
    // "bgt", "dr" - the trigger phrase itself is intact.
    expect(scan("nyeri dada bgt dr semalem").family).toBe("cardiac");
  });

  test("does NOT fire when the trigger phrase itself is misspelled", () => {
    // Known and accepted limitation. The floor is exact-substring, so a typo
    // inside "nyeri dada" walks past it. Catching this is exactly what L2's
    // red_flag_informal question exists for, and the table is expanded with
    // variants rather than made fuzzy (fuzzy matching would fire on far more
    // non-emergencies, and this floor is tuned for recall, not cleverness).
    expect(scan("dadaa nyeri bgt dr semalem").hit).toBe(false);
  });

  test("the table carries the common misspelling variants instead", () => {
    expect(scan("sesak nafas").family).toBe("breathing");
    expect(scan("susah nafas").family).toBe("breathing");
  });
});

describe("scan - negation is tolerated by design", () => {
  test("a negated red flag still fires", () => {
    // Documented and intentional: the floor does not parse negation, because a
    // floor that tries to be clever starts missing emergencies. L2 handles it.
    const verdict = scan("tidak ada nyeri dada");

    expect(verdict.hit).toBe(true);
    expect(verdict.family).toBe("cardiac");
  });

  test("a negated seizure still fires", () => {
    expect(scan("tidak kejang").hit).toBe(true);
  });
});

describe("scan - misses", () => {
  test("a routine refill request does not fire", () => {
    const verdict = scan("mau ambil obat lanjutan hipertensi, stok habis");

    expect(verdict.hit).toBe(false);
    expect(verdict.family).toBeNull();
    expect(verdict.tier).toBeNull();
    expect(verdict.playbookId).toBeNull();
  });

  test("an empty message does not fire", () => {
    expect(scan("").hit).toBe(false);
  });

  test("punctuation only does not fire", () => {
    expect(scan("???").hit).toBe(false);
  });
});

describe("scan - precedence", () => {
  test("P1 wins over P2 when both match", () => {
    // "nyeri dada" (cardiac, P1) and "demam tinggi" (sepsis, P2) both present.
    expect(scan("nyeri dada dan demam tinggi").family).toBe("cardiac");
  });
});

describe("the rule table", () => {
  test("covers all ten families", () => {
    const families = new Set(RED_FLAG_RULES.map((rule) => rule.family));

    expect(families.size).toBe(10);
  });

  test("every rule has at least one pattern", () => {
    for (const rule of RED_FLAG_RULES) {
      expect(rule.patterns.length).toBeGreaterThan(0);
    }
  });

  test("every pattern is lowercase and trimmed, so substring matching works", () => {
    for (const rule of RED_FLAG_RULES) {
      for (const pattern of rule.patterns) {
        expect(pattern).toBe(pattern.toLowerCase().trim());
      }
    }
  });

  test("every P1 rule resolves to a playbook", () => {
    const p1 = RED_FLAG_RULES.filter((rule) => rule.tier === "P1");

    expect(p1.length).toBeGreaterThan(0);
    for (const rule of p1) {
      expect(rule.playbookId).not.toBeNull();
    }
  });

  test("P1 rules are listed before P2 rules, so scan reports the worse one", () => {
    const tiers = RED_FLAG_RULES.map((rule) => rule.tier);
    const firstP2 = tiers.indexOf("P2");
    const lastP1 = tiers.lastIndexOf("P1");

    expect(lastP1).toBeLessThan(firstP2);
  });

  test("no duplicate families", () => {
    const families = RED_FLAG_RULES.map((rule) => rule.family);

    expect(new Set(families).size).toBe(families.length);
  });
});
