import { HANDOFF_TEXT } from "../intake/engine";
import { describe, expect, test } from "bun:test";
import { FakeChannel } from "../channel/fake";
import type { ModelSlot } from "../config";
import type { InboundMessage } from "../contracts";
import { FakeDecisionModel, neutralDecision } from "../decision-model/fake";
import { ACKNOWLEDGEMENT, SAFETY_CLOSER } from "../reply/playbooks";
import { TEMPLATES } from "../reply/templates";
import {
  createOrchestrator,
  escalationReasonFor,
  replyKindFor,
  type OrchestratorDeps,
} from "./orchestrator";

const SLOTS: ModelSlot[] = [
  { id: "perplexity/pplx-decider-v1.1-27b", cutoff: 0.15, urgencyCeiling: 4 },
  { id: "typesafe/jev-1.13", cutoff: 0.31, urgencyCeiling: 3 },
];

/** Deliberately a message the floor does not fire on. Asserted below. */
const NEUTRAL_TEXT = "mau ambil obat lanjutan hipertensi, stok habis di rumah";

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    phone: "628123456789",
    text: NEUTRAL_TEXT,
    providerMessageId: "MSG-1",
    receivedAt: new Date("2026-10-14T10:00:00Z"),
    kind: "text",
    ...overrides,
  };
}

function deps(model: FakeDecisionModel, options: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return { model, slots: SLOTS, channel: new FakeChannel(), timeoutMs: 50, ...options };
}

describe("the fixture message stays a floor miss", () => {
  test("NEUTRAL_TEXT does not trip the red-flag floor", async () => {
    // If the floor ever starts firing on this, every test below silently
    // becomes a floor test.
    const model = new FakeDecisionModel(neutralDecision());

    await createOrchestrator(deps(model)).handleInbound(message());

    expect(model.calls).toBe(1);
  });
});

describe("escalationReasonFor", () => {
  test("a routine decision has no reason to escalate", () => {
    expect(escalationReasonFor(neutralDecision(), SLOTS)).toBeNull();
  });

  test("urgency 3 escalates", () => {
    expect(escalationReasonFor(neutralDecision({ urgency: 3 }), SLOTS)).toBe("urgency");
  });

  test("urgency 2 alone does not", () => {
    expect(escalationReasonFor(neutralDecision({ urgency: 2 }), SLOTS)).toBeNull();
  });

  test("red flag at the cutoff escalates", () => {
    expect(escalationReasonFor(neutralDecision({ redFlag: 0.15 }), SLOTS)).toBe("red_flag");
  });

  test("the cutoff belongs to the model that answered", () => {
    const onPrimary = neutralDecision({ redFlag: 0.2 });
    const onFallback = neutralDecision({ redFlag: 0.2, model: "typesafe/jev-1.13" });

    expect(escalationReasonFor(onPrimary, SLOTS)).toBe("red_flag");
    // 0.2 is above the primary's 0.15 and below the fallback's 0.31.
    expect(escalationReasonFor(onFallback, SLOTS)).toBeNull();
  });

  test("an unknown model id falls back to the strictest cutoff", () => {
    expect(escalationReasonFor(neutralDecision({ redFlag: 0.2, model: null }), SLOTS)).toBe(
      "red_flag",
    );
  });

  test("a request for a human escalates at 0.5 regardless of urgency", () => {
    expect(escalationReasonFor(neutralDecision({ wantsHuman: 0.5, urgency: 0 }), SLOTS)).toBe(
      "wants_human",
    );
  });

  test("a floor decision always escalates, whatever else is on it", () => {
    const floored = neutralDecision({ source: "red_flag_floor", redFlag: 0, urgency: 0 });

    expect(escalationReasonFor(floored, SLOTS)).toBe("red_flag_floor");
  });

  test("a human request outranks a red flag", () => {
    const decision = neutralDecision({ wantsHuman: 0.9, redFlag: 0.9 });

    expect(escalationReasonFor(decision, SLOTS)).toBe("wants_human");
  });
});

describe("replyKindFor", () => {
  test("a routine complaint goes to intake", () => {
    expect(replyKindFor(neutralDecision(), SLOTS)).toBe("intake");
  });

  test("urgency 3 escalates", () => {
    expect(replyKindFor(neutralDecision({ urgency: 3 }), SLOTS)).toBe("escalation");
  });

  test("ambiguous clarity asks a follow-up", () => {
    expect(replyKindFor(neutralDecision({ clarity: "ambiguous" }), SLOTS)).toBe("follow_up");
  });

  test("gibberish asks a follow-up", () => {
    expect(replyKindFor(neutralDecision({ clarity: "gibberish" }), SLOTS)).toBe("follow_up");
  });

  test("ambiguity never de-escalates a red flag", () => {
    // The whole invariant in one assertion: the follow-up branch sits below the
    // escalation branch and cannot be reached once anything has fired.
    const decision = neutralDecision({ clarity: "ambiguous", redFlag: 0.9 });

    expect(replyKindFor(decision, SLOTS)).toBe("escalation");
  });

  test("ambiguity never de-escalates urgency", () => {
    expect(replyKindFor(neutralDecision({ clarity: "gibberish", urgency: 4 }), SLOTS)).toBe(
      "escalation",
    );
  });
});

describe("the floor short-circuits the model", () => {
  test("a chest-pain message escalates without calling the model", async () => {
    const model = new FakeDecisionModel(neutralDecision({ redFlag: 0, urgency: 0 }));

    const reply = await createOrchestrator(deps(model)).handleInbound(
      message({ text: "nyeri dada sejak tadi malam" }),
    );

    expect(model.calls).toBe(0);
    expect(reply?.text).toContain("Duduk atau setengah berbaring");
    expect(reply?.purpose).toBe("playbook");
  });

  test("the reply carries the playbook for the family that fired", async () => {
    const model = new FakeDecisionModel(neutralDecision());
    const orchestrator = createOrchestrator(deps(model));

    const stroke = await orchestrator.handleInbound(
      message({ text: "mulut miring dan bicara pelo", providerMessageId: "S" }),
    );
    const seizure = await orchestrator.handleInbound(
      message({ text: "anak saya kejang", providerMessageId: "C" }),
    );

    expect(stroke?.text).toContain("Catat jam pertama kali gejala muncul");
    expect(seizure?.text).toContain("Jangan menahan gerakan kejang");
  });

  test("a tier-2 floor hit escalates too", async () => {
    const model = new FakeDecisionModel(neutralDecision());

    const reply = await createOrchestrator(deps(model)).handleInbound(
      message({ text: "demam menggigil tiga hari" }),
    );

    expect(model.calls).toBe(0);
    expect(reply?.text).toContain("Istirahat dan banyak minum air");
  });

  test("every floor escalation carries the acknowledgement and the safety closer", async () => {
    const model = new FakeDecisionModel(neutralDecision());

    const reply = await createOrchestrator(deps(model)).handleInbound(
      message({ text: "saya ingin mati" }),
    );

    expect(reply?.text.startsWith(ACKNOWLEDGEMENT)).toBe(true);
    expect(reply?.text.endsWith(SAFETY_CLOSER)).toBe(true);
  });

  test("a floor hit is not re-litigated by a reassuring model answer", async () => {
    // The model would say "no emergency at all". It does not get a vote.
    const model = new FakeDecisionModel(neutralDecision({ redFlag: 0, urgency: 0, clarity: "gibberish" }));

    const reply = await createOrchestrator(deps(model)).handleInbound(
      message({ text: "gak bisa napas" }),
    );

    expect(reply?.text).toContain("Duduk tegak");
  });
});

describe("createOrchestrator - the ladder", () => {
  test("a routine complaint gets the intake template", async () => {
    const model = new FakeDecisionModel(neutralDecision());
    const reply = await createOrchestrator(deps(model)).handleInbound(message());

    expect(reply?.text).toBe(TEMPLATES.intake);
    expect(reply?.phone).toBe("628123456789");
    expect(reply?.purpose).toBe("reply");
    expect(model.calls).toBe(1);
  });

  test("a red flag above the cutoff escalates with the generic playbook", async () => {
    const model = new FakeDecisionModel(neutralDecision({ redFlag: 0.2 }));

    const reply = await createOrchestrator(deps(model)).handleInbound(message());

    expect(reply?.text).toContain("Segera ke IGD");
    expect(reply?.purpose).toBe("playbook");
  });

  test("urgency 3 escalates", async () => {
    const model = new FakeDecisionModel(neutralDecision({ urgency: 3, redFlag: 0 }));

    expect((await createOrchestrator(deps(model)).handleInbound(message()))?.purpose).toBe(
      "playbook",
    );
  });

  test("wants_human escalates regardless of urgency", async () => {
    const model = new FakeDecisionModel(
      neutralDecision({ wantsHuman: 0.9, urgency: 0, redFlag: 0 }),
    );

    expect((await createOrchestrator(deps(model)).handleInbound(message()))?.text).toContain(
      HANDOFF_TEXT,
    );
  });

  test("ambiguous clarity asks a follow-up", async () => {
    const model = new FakeDecisionModel(neutralDecision({ clarity: "ambiguous" }));

    expect((await createOrchestrator(deps(model)).handleInbound(message()))?.text).toBe(
      TEMPLATES.follow_up,
    );
  });

  test("a model failure escalates with the generic playbook", async () => {
    const model = new FakeDecisionModel(neutralDecision(), "throw");

    const reply = await createOrchestrator(deps(model)).handleInbound(message());

    expect(reply?.text).toContain(SAFETY_CLOSER);
    expect(reply?.text).toContain("Segera ke IGD");
    expect(reply?.purpose).toBe("playbook");
  });

  test("a model timeout escalates rather than passing", async () => {
    const model = new FakeDecisionModel(neutralDecision(), "hang");

    expect((await createOrchestrator(deps(model)).handleInbound(message()))?.text).toContain(
      SAFETY_CLOSER,
    );
  });
});

describe("createOrchestrator - non-text payloads", () => {
  test("a voice note is answered with a text-only request and no model call", async () => {
    const model = new FakeDecisionModel(neutralDecision());

    const reply = await createOrchestrator(deps(model)).handleInbound(
      message({ kind: "audio", text: "" }),
    );

    expect(reply?.text).toBe(TEMPLATES.text_only);
    expect(model.calls).toBe(0);
  });

  test("an empty text message is treated the same way", async () => {
    const model = new FakeDecisionModel(neutralDecision());

    const reply = await createOrchestrator(deps(model)).handleInbound(message({ text: "   " }));

    expect(reply?.text).toBe(TEMPLATES.text_only);
    expect(model.calls).toBe(0);
  });

  test("an image is treated the same way", async () => {
    const model = new FakeDecisionModel(neutralDecision());

    expect(
      (await createOrchestrator(deps(model)).handleInbound(message({ kind: "image", text: "" })))
        ?.text,
    ).toBe(TEMPLATES.text_only);
  });
});

describe("createOrchestrator - delivery", () => {
  test("a duplicate providerMessageId is not answered twice", async () => {
    const orchestrator = createOrchestrator(deps(new FakeDecisionModel(neutralDecision())));

    expect(await orchestrator.handleInbound(message())).not.toBeNull();
    expect(await orchestrator.handleInbound(message())).toBeNull();
  });

  test("a duplicate is not even sent to the model twice", async () => {
    const model = new FakeDecisionModel(neutralDecision());
    const orchestrator = createOrchestrator(deps(model));

    await orchestrator.handleInbound(message());
    await orchestrator.handleInbound(message());

    expect(model.calls).toBe(1);
  });

  test("a re-delivered message is not sent to the channel twice", async () => {
    const channel = new FakeChannel();
    const orchestrator = createOrchestrator(
      deps(new FakeDecisionModel(neutralDecision()), { channel }),
    );

    await orchestrator.onInbound(message());
    await orchestrator.onInbound(message());

    expect(channel.sent).toHaveLength(1);
  });

  test("an escalation is sent to the channel, not just returned", async () => {
    const channel = new FakeChannel();
    const orchestrator = createOrchestrator(
      deps(new FakeDecisionModel(neutralDecision()), { channel }),
    );

    await orchestrator.onInbound(message({ text: "nyeri dada" }));

    expect(channel.sent[0]?.text).toContain(SAFETY_CLOSER);
  });

  test("distinct ids from the same phone are both answered", async () => {
    const orchestrator = createOrchestrator(deps(new FakeDecisionModel(neutralDecision())));

    await orchestrator.handleInbound(message({ providerMessageId: "A" }));
    await orchestrator.handleInbound(message({ providerMessageId: "B" }));

    expect(orchestrator.seenCount()).toBe(2);
  });

  test("the seen-set is bounded", async () => {
    const orchestrator = createOrchestrator(
      deps(new FakeDecisionModel(neutralDecision()), { seenLimit: 3 }),
    );

    for (const id of ["A", "B", "C", "D", "E"]) {
      await orchestrator.handleInbound(message({ providerMessageId: id }));
    }

    expect(orchestrator.seenCount()).toBe(3);
  });

  test("an evicted id is no longer treated as a duplicate", async () => {
    const orchestrator = createOrchestrator(
      deps(new FakeDecisionModel(neutralDecision()), { seenLimit: 2 }),
    );

    for (const id of ["A", "B", "C"]) {
      await orchestrator.handleInbound(message({ providerMessageId: id }));
    }

    // A fell out of the window, so it is answered again rather than dropped.
    expect(await orchestrator.handleInbound(message({ providerMessageId: "A" }))).not.toBeNull();
  });
});


test("explicit petugas command bypasses both classifiers, but chest pain still wins", async () => {
  const model = new FakeDecisionModel(neutralDecision());
  const orchestrator = createOrchestrator(deps(model));
  const human = await orchestrator.assess(message({text:"petugas"}));
  expect(human.reason).toBe("wants_human");
  expect(human.reply.purpose).toBe("reply");
  expect(model.calls).toBe(0);
  const emergency = await orchestrator.assess(message({text:"nyeri dada, bicara dengan petugas"}));
  expect(emergency.family).toBe("cardiac");
  expect(model.calls).toBe(0);
});

test('medical emergency keeps its playbook when a human is requested too',async()=>{
  const model = new FakeDecisionModel(neutralDecision({urgency:4,wantsHuman:0.9}));
  const outcome=await createOrchestrator(deps(model)).assess(message());
  expect(outcome.reason).toBe('wants_human');
  expect(outcome.medicalEmergency).toBe(true);
  expect(outcome.reply.purpose).toBe('playbook');
});
