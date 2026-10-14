import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "../contracts";
import { FakeChannel } from "../channel/fake";
import { FakeDecisionModel, neutralDecision } from "../decision-model/fake";
import { TEMPLATES } from "../reply/templates";
import { createOrchestrator, replyKindFor, type OrchestratorDeps } from "./orchestrator";

const CUTOFFS = {
  primaryId: "pplx-decider-v1.1",
  fallbackId: "jev-1.13",
  cutoffPrimary: 0.15,
  cutoffFallback: 0.31,
};

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    phone: "628123456789",
    text: "demam tiga hari",
    providerMessageId: "MSG-1",
    receivedAt: new Date("2026-10-14T10:00:00Z"),
    kind: "text",
    ...overrides,
  };
}

function deps(
  model: FakeDecisionModel,
  options: Partial<OrchestratorDeps> = {},
): OrchestratorDeps {
  return { model, cutoffs: CUTOFFS, channel: new FakeChannel(), timeoutMs: 50, ...options };
}

describe("replyKindFor", () => {
  test("routine complaint is routine", () => {
    expect(replyKindFor(neutralDecision(), CUTOFFS)).toBe("routine");
  });

  test("urgency 3 becomes urgent", () => {
    expect(replyKindFor(neutralDecision({ urgency: 3 }), CUTOFFS)).toBe("urgent");
  });

  test("red flag at the cutoff escalates", () => {
    expect(replyKindFor(neutralDecision({ redFlag: 0.15 }), CUTOFFS)).toBe("emergency");
  });

  test("the fallback model uses the looser cutoff", () => {
    const decision = neutralDecision({ redFlag: 0.2, model: "jev-1.13" });

    // 0.2 escalates under the primary cutoff (0.15) but not the fallback's (0.31)
    expect(replyKindFor(decision, CUTOFFS)).toBe("routine");
    expect(replyKindFor({ ...decision, model: "pplx-decider-v1.1" }, CUTOFFS)).toBe("emergency");
  });

  test("an unknown model falls back to the stricter cutoff", () => {
    expect(replyKindFor(neutralDecision({ redFlag: 0.2, model: null }), CUTOFFS)).toBe("emergency");
  });
});

describe("createOrchestrator", () => {
  test("routine complaint gets the routine template", async () => {
    const orchestrator = createOrchestrator(deps(new FakeDecisionModel(neutralDecision())));

    const reply = await orchestrator.handleInbound(message());

    expect(reply?.text).toBe(TEMPLATES.routine);
    expect(reply?.phone).toBe("628123456789");
    expect(reply?.purpose).toBe("reply");
  });

  test("a red flag above the cutoff escalates", async () => {
    const model = new FakeDecisionModel(neutralDecision({ redFlag: 0.2 }));

    expect((await createOrchestrator(deps(model)).handleInbound(message()))?.text).toBe(
      TEMPLATES.emergency,
    );
  });

  test("wants_human escalates regardless of urgency", async () => {
    const model = new FakeDecisionModel(neutralDecision({ wantsHuman: 0.9, urgency: 0 }));

    expect((await createOrchestrator(deps(model)).handleInbound(message()))?.text).toBe(
      TEMPLATES.emergency,
    );
  });

  test("ambiguous clarity asks a follow-up", async () => {
    const model = new FakeDecisionModel(neutralDecision({ clarity: "ambiguous" }));

    expect((await createOrchestrator(deps(model)).handleInbound(message()))?.text).toBe(
      TEMPLATES.unclear,
    );
  });

  test("non-text payloads ask a follow-up instead of crashing", async () => {
    const model = new FakeDecisionModel(neutralDecision());

    const reply = await createOrchestrator(deps(model)).handleInbound(
      message({ kind: "audio", text: "" }),
    );

    expect(reply?.text).toBe(TEMPLATES.unclear);
  });

  test("a duplicate providerMessageId is not answered twice", async () => {
    const orchestrator = createOrchestrator(deps(new FakeDecisionModel(neutralDecision())));

    expect(await orchestrator.handleInbound(message())).not.toBeNull();
    expect(await orchestrator.handleInbound(message())).toBeNull();
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

  test("distinct ids from the same phone are both answered", async () => {
    const orchestrator = createOrchestrator(deps(new FakeDecisionModel(neutralDecision())));

    await orchestrator.handleInbound(message({ providerMessageId: "A" }));
    await orchestrator.handleInbound(message({ providerMessageId: "B" }));

    expect(orchestrator.seenCount()).toBe(2);
  });

  test("a model failure escalates rather than passing", async () => {
    const model = new FakeDecisionModel(neutralDecision(), "throw");

    expect((await createOrchestrator(deps(model)).handleInbound(message()))?.text).toBe(
      TEMPLATES.emergency,
    );
  });

  test("a model timeout escalates rather than passing", async () => {
    const model = new FakeDecisionModel(neutralDecision(), "hang");

    expect((await createOrchestrator(deps(model)).handleInbound(message()))?.text).toBe(
      TEMPLATES.emergency,
    );
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
