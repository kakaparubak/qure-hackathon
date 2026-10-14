import { describe, expect, test } from "bun:test";
import { isPaired, kindOf, phoneFromJid, resolvePhone, textOf } from "./whatsapp";

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

describe("resolvePhone", () => {
  const sock = (pn: string | null) => ({
    signalRepository: { lidMapping: { getPNForLID: async () => pn } },
  });

  test("uses the phone-number JID when one is present", async () => {
    const phone = await resolvePhone(sock(null), {
      remoteJid: "628123456789@s.whatsapp.net",
    });

    expect(phone).toBe("628123456789");
  });

  test("prefers remoteJidAlt when remoteJid is a LID", async () => {
    const phone = await resolvePhone(sock("628999999999@s.whatsapp.net"), {
      remoteJid: "100124931915810@lid",
      remoteJidAlt: "628123456789@s.whatsapp.net",
    });

    expect(phone).toBe("628123456789");
  });

  test("resolves a bare LID through the mapping store", async () => {
    // The real shape of a LID-only inbound message. Before this existed the
    // message was dropped without a log line, which is what made a live test
    // look like "nothing arrived".
    const phone = await resolvePhone(sock("6281717150770@s.whatsapp.net"), {
      remoteJid: "100124931915810@lid",
    });

    expect(phone).toBe("6281717150770");
  });

  test("returns null when the LID is not in the mapping store", async () => {
    expect(await resolvePhone(sock(null), { remoteJid: "100124931915810@lid" })).toBeNull();
  });

  test("a failing mapping lookup is not fatal", async () => {
    const failing = {
      signalRepository: {
        lidMapping: {
          getPNForLID: async () => {
            throw new Error("store unavailable");
          },
        },
      },
    };

    expect(await resolvePhone(failing, { remoteJid: "100124931915810@lid" })).toBeNull();
  });

  test("rejects group JIDs rather than resolving them", async () => {
    expect(await resolvePhone(sock("628123456789@s.whatsapp.net"), {
      remoteJid: "120363000000000000@g.us",
    })).toBeNull();
  });
});

describe("isPaired", () => {
  test("an account id means the session is already linked", () => {
    expect(isPaired({ me: { id: "6282258458984:1@s.whatsapp.net" } })).toBe(true);
  });

  test("a QR pairing leaves registered false, so me is what counts", () => {
    // The real shape after scanning a QR: creds.me is set, registered is not.
    // Gating pairing on `registered` re-paired a live session on restart.
    expect(isPaired({ me: { id: "6282258458984:1@s.whatsapp.net" }, registered: false })).toBe(true);
  });

  test("no account id means pairing is still needed", () => {
    expect(isPaired({})).toBe(false);
    expect(isPaired({ registered: false })).toBe(false);
  });

  test("an explicit null me is treated as unpaired", () => {
    expect(isPaired({ me: null })).toBe(false);
  });
});
