import { describe, expect, test } from "bun:test";
import { replyFor, TEMPLATES, type ReplyKind } from "./templates";

describe("replyFor", () => {
  test("every kind produces non-empty Bahasa text", () => {
    const kinds: ReplyKind[] = ["emergency", "urgent", "routine", "unclear"];

    for (const kind of kinds) {
      expect(replyFor(kind).length).toBeGreaterThan(20);
    }
  });

  test("emergency tells the patient to go to the ER", () => {
    expect(TEMPLATES.emergency).toMatch(/IGD/);
  });

  test("unclear asks a question", () => {
    expect(TEMPLATES.unclear).toMatch(/\?/);
  });

  test("kinds are distinct", () => {
    const texts = Object.values(TEMPLATES);
    expect(new Set(texts).size).toBe(texts.length);
  });
});
