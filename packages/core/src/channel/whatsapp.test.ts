import { describe, expect, test } from "bun:test";
import { kindOf, phoneFromJid, textOf } from "./whatsapp";

describe("phoneFromJid", () => {
  test("extracts the number from a plain person JID", () => {
    expect(phoneFromJid("628123456789@s.whatsapp.net")).toBe("628123456789");
  });

  test("strips the device suffix", () => {
    expect(phoneFromJid("628123456789:12@s.whatsapp.net")).toBe("628123456789");
  });

  test("rejects group JIDs", () => {
    expect(phoneFromJid("120363000000000000@g.us")).toBeNull();
  });

  test("rejects the status broadcast", () => {
    expect(phoneFromJid("status@broadcast")).toBeNull();
  });

  test("rejects a newsletter JID", () => {
    expect(phoneFromJid("123@newsletter")).toBeNull();
  });

  test("rejects null and empty", () => {
    expect(phoneFromJid(null)).toBeNull();
    expect(phoneFromJid(undefined)).toBeNull();
    expect(phoneFromJid("")).toBeNull();
  });

  test("rejects a JID whose local part is not a number", () => {
    expect(phoneFromJid("abc@s.whatsapp.net")).toBeNull();
  });

  test("rejects a too-short local part", () => {
    expect(phoneFromJid("123@s.whatsapp.net")).toBeNull();
  });
});

describe("kindOf", () => {
  test("plain conversation text", () => {
    expect(kindOf({ conversation: "halo" })).toBe("text");
  });

  test("extended text", () => {
    expect(kindOf({ extendedTextMessage: { text: "halo" } })).toBe("text");
  });

  test("voice note", () => {
    expect(kindOf({ audioMessage: {} })).toBe("audio");
  });

  test("image", () => {
    expect(kindOf({ imageMessage: {} })).toBe("image");
  });

  test("document", () => {
    expect(kindOf({ documentMessage: {} })).toBe("document");
  });

  test("everything else is other", () => {
    expect(kindOf({ stickerMessage: {} })).toBe("other");
  });

  test("missing content is other, not a crash", () => {
    expect(kindOf(null)).toBe("other");
    expect(kindOf(undefined)).toBe("other");
  });
});

describe("textOf", () => {
  test("reads a plain conversation", () => {
    expect(textOf({ conversation: "demam" })).toBe("demam");
  });

  test("reads extended text", () => {
    expect(textOf({ extendedTextMessage: { text: "demam" } })).toBe("demam");
  });

  test("falls back to an image caption", () => {
    expect(textOf({ imageMessage: { caption: "lihat ini" } })).toBe("lihat ini");
  });

  test("falls back to a voice note caption", () => {
    expect(textOf({ audioMessage: { caption: "rekaman" } })).toBe("rekaman");
  });

  test("returns an empty string for a payload with no text", () => {
    expect(textOf({ audioMessage: {} })).toBe("");
    expect(textOf(null)).toBe("");
  });

  test("prefers the message text over a caption", () => {
    expect(textOf({ conversation: "utama", imageMessage: { caption: "lain" } })).toBe("utama");
  });
});
