import { describe, expect, test } from "bun:test";
import { RED_FLAG_RULES, type RedFlagFamily } from "../red-flag/patterns";
import {
  ACKNOWLEDGEMENT,
  INFANT_PLAYBOOK_ID,
  PLAYBOOKS,
  SAFETY_CLOSER,
  escalationText,
  playbookFor,
  renderSteps,
} from "./playbooks";

const ALL_FAMILIES: RedFlagFamily[] = [
  "cardiac",
  "stroke_fast",
  "breathing",
  "consciousness",
  "bleeding_trauma",
  "sepsis_infection",
  "anaphylaxis",
  "pregnancy",
  "mental_health_crisis",
  "severe_pain_poisoning",
];

describe("playbookFor", () => {
  test("returns the cardiac playbook for a cardiac flag", () => {
    expect(playbookFor("cardiac").id).toBe("cardiac");
  });

  test("routes severe pain and poisoning to the generic playbook", () => {
    // The rule table maps this family to "generic" on purpose - there is no
    // poisoning-specific first aid a bot should hand out unattended.
    expect(playbookFor("severe_pain_poisoning").id).toBe("generic");
  });

  test("falls back to generic when no family fired", () => {
    expect(playbookFor(null).id).toBe("generic");
  });

  test("every family resolves to a playbook that exists", () => {
    for (const family of ALL_FAMILIES) {
      const playbook = playbookFor(family);

      expect(PLAYBOOKS[playbook.id]).toBeDefined();
      expect(playbook.steps.length).toBeGreaterThan(0);
    }
  });

  test("infant under 3 months overrides the family playbook", () => {
    const playbook = playbookFor("cardiac", { ageMonths: 1 });

    expect(playbook.id).toBe(INFANT_PLAYBOOK_ID);
    expect(playbook.steps).toHaveLength(1);
    expect(playbook.steps[0]).toContain("Segera bawa");
  });

  test("three months exactly is no longer an infant", () => {
    expect(playbookFor("cardiac", { ageMonths: 3 }).id).toBe("cardiac");
  });

  test("no age known means no infant override", () => {
    expect(playbookFor("cardiac", {}).id).toBe("cardiac");
  });
});

describe("renderSteps", () => {
  test("numbers steps from one", () => {
    const rendered = renderSteps({ id: "x", title: "t", steps: ["a", "b"] });

    expect(rendered).toBe("1. a\n2. b");
  });
});

describe("escalationText", () => {
  test("is acknowledgement, playbook, then safety closer", () => {
    const text = escalationText("cardiac");

    expect(text.startsWith(ACKNOWLEDGEMENT)).toBe(true);
    expect(text.endsWith(SAFETY_CLOSER)).toBe(true);
    expect(text).toContain("1. Duduk atau setengah berbaring.");
  });

  test("always carries the safety closer, even with no family", () => {
    expect(escalationText(null)).toContain(SAFETY_CLOSER);
  });
});

describe("clinical safety invariants", () => {
  test("no playbook mentions aspirin", () => {
    // Documented omission. Aspirin is standard pre-hospital care for suspected
    // MI, but screening for contraindications is not something a bot should
    // gate. Medication advice stays with the nurse.
    const cardiac = PLAYBOOKS.cardiac;

    expect(cardiac).toBeDefined();
    expect(JSON.stringify(PLAYBOOKS).toLowerCase()).not.toContain("aspirin");
  });

  test("no playbook prescribes a medicine to take", () => {
    // "minum obat" appears only as an instruction NOT to, or as something to
    // report. The table must never hand out a dose.
    const prescribed = /(minum|beri|kasih)\s+paracetamol|dosis|mg\b/i;

    expect(JSON.stringify(PLAYBOOKS)).not.toMatch(prescribed);
  });

  test("a family-less escalation still tells the patient to seek care", () => {
    // Urgency can escalate with no red-flag family (a P2 or a high urgency
    // score). The generic playbook must still send them in, not tell them to
    // rest at home.
    expect(renderSteps(playbookFor(null))).toContain("Segera ke IGD");
  });

  test("the stroke playbook forbids food and drink", () => {
    expect(renderSteps(playbookFor("stroke_fast")).toLowerCase()).toContain(
      "jangan beri makanan atau minuman",
    );
  });

  test("the bleeding playbook says not to lift the dressing", () => {
    expect(renderSteps(playbookFor("bleeding_trauma")).toLowerCase()).toContain(
      "jangan mengangkat kain",
    );
  });

  test("the seizure playbook forbids restraining and objects in the mouth", () => {
    const steps = renderSteps(playbookFor("consciousness")).toLowerCase();

    expect(steps).toContain("jangan menahan");
    expect(steps).toContain("jangan memasukkan apa pun ke dalam mulut");
  });

  test("every playbook id matches the key it is stored under", () => {
    for (const [key, playbook] of Object.entries(PLAYBOOKS)) {
      expect(playbook.id).toBe(key);
    }
  });

  test("every rule the table can fire has a playbook behind it", () => {
    for (const rule of RED_FLAG_RULES) {
      expect(PLAYBOOKS[rule.playbookId]).toBeDefined();
    }
  });
});
