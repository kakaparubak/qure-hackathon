import { describe, expect, test } from "bun:test";
import type { RedFlagFamily } from "../red-flag/patterns";
import { TEMPLATES, replyFor, type ReplyKind } from "./templates";

const ESCALATION_FAMILIES: (RedFlagFamily | null)[] = [
  "cardiac",
  "stroke_fast",
  "mental_health_crisis",
  "severe_pain_poisoning",
  null,
];

describe("replyFor", () => {
  test("every branch produces a substantial message", () => {
    const kinds: ReplyKind[] = ["escalation", "intake", "follow_up", "text_only"];

    for (const kind of kinds) {
      expect(replyFor(kind).length).toBeGreaterThan(20);
    }
  });

  test("escalation varies by the family that fired", () => {
    const cardiac = replyFor("escalation", { family: "cardiac" });
    const stroke = replyFor("escalation", { family: "stroke_fast" });

    expect(cardiac).not.toBe(stroke);
    expect(cardiac).toContain("Duduk atau setengah berbaring");
    expect(stroke).toContain("Catat jam pertama kali gejala muncul");
  });

  test("a family-less escalation falls back to the generic playbook", () => {
    expect(replyFor("escalation")).toBe(TEMPLATES.escalation);
    expect(replyFor("escalation", { family: null })).toBe(TEMPLATES.escalation);
  });

  test("an infant escalation carries no home advice", () => {
    const text = replyFor("escalation", { family: "cardiac", ageMonths: 2 });

    expect(text).toContain("Segera bawa bayi");
    expect(text).not.toContain("Duduk atau setengah berbaring");
  });

  test("the intake branch points at the lobby", () => {
    expect(TEMPLATES.intake).toMatch(/loket/);
  });

  test("the follow-up branch asks a question", () => {
    expect(TEMPLATES.follow_up).toMatch(/\?/);
  });

  test("the text-only branch tells the patient to type", () => {
    // PRD section 2: a voice note gets "tolong ketik ya" and no triage decision.
    expect(TEMPLATES.text_only).toContain("Tolong ketik ya");
  });

  test("the text-only branch promises no triage, no queue, no nurse", () => {
    expect(TEMPLATES.text_only).not.toMatch(/antrean|IGD|perawat/i);
  });
});

describe("the template table", () => {
  test("no template has leading or trailing whitespace", () => {
    for (const text of Object.values(TEMPLATES)) {
      expect(text).toBe(text.trim());
    }
  });

  test("every escalation carries both ends of the escalation contract", () => {
    // The acknowledgement and the safety closer are requirements on every
    // escalation, not per-branch decoration.
    for (const family of ESCALATION_FAMILIES) {
      const text = replyFor("escalation", { family });

      expect(text).toContain("Keluhan Anda ditandai penting.");
      expect(text).toContain("Perawat sedang dihubungi.");
      expect(text.endsWith("Jika kondisi memburuk, hubungi 119.")).toBe(true);
    }
  });

  test("no template leaks an English-language instruction", () => {
    // Patients read Bahasa Indonesia only.
    for (const text of Object.values(TEMPLATES)) {
      expect(text).not.toMatch(/\b(please|call|go to|doctor)\b/i);
    }
  });
});
