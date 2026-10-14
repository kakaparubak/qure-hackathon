import { describe, expect, test } from "bun:test";
import {
  ALLOWED_TRANSITIONS,
  type Decision,
  type InboundMessage,
  type QueueEvent,
  type QueueRow,
  type WhatsAppChannel,
} from "@qure/core";

/**
 * Verifies the cross-package seam: apps/api must be able to consume the frozen
 * contracts from @qure/core. If the workspace link or the re-exports break,
 * this fails at typecheck time rather than at integration time.
 */
describe("@qure/core contracts are consumable from apps/api", () => {
  test("session transitions are importable at runtime", () => {
    expect(ALLOWED_TRANSITIONS.closed).toEqual([]);
  });

  test("a Decision can be constructed by a channel/pipeline consumer", () => {
    const decision: Decision = {
      source: "red_flag_floor",
      urgency: null,
      urgencyConfidence: null,
      clarity: null,
      redFlag: 1,
      redFlagInformal: null,
      wantsHuman: 0,
      category: "chest_cardiac",
      matchedFamily: "cardiac",
      model: null,
      raw: { matched: "nyeri dada" },
    };

    // the orchestrator's decision rule, as it will actually be written
    const CUTOFFS: Record<string, number> = { "pplx-decider-v1.1-27b": 0.15, "typesafe/jev-1.13": 0.31 };
    const cutoff = decision.model ? (CUTOFFS[decision.model] ?? 0.15) : 0.5;
    const shouldEscalate = decision.redFlag >= cutoff;

    expect(shouldEscalate).toBe(true);
  });

  test("an inbound message normalizes to the envelope shape", () => {
    const msg: InboundMessage = {
      phone: "628123456789", // E.164 without '+'
      text: "dada rasanya ditekan banget",
      providerMessageId: "wa-abc123",
      receivedAt: new Date("2026-10-14T00:00:00Z"),
      kind: "text",
    };

    expect(msg.phone).not.toContain("+");
    expect(msg.kind).toBe("text");
  });

  test("a channel implementation satisfies WhatsAppChannel", () => {
    const sent: string[] = [];
    const channel: WhatsAppChannel = {
      async send(m) {
        sent.push(m.text);
      },
      onMessage() {
        /* no-op for this test */
      },
    };

    void channel.send({
      phone: "628123456789",
      text: "Perawat sedang dihubungi",
      purpose: "playbook",
    });

    expect(sent).toHaveLength(1);
  });

  test("QueueEvent discriminates on its type field", () => {
    const row: QueueRow = {
      sessionId: "s-1",
      patientName: null,
      tier: "P1",
      lane: "priority",
      position: 1,
      etaMinutes: 0,
      waitedMinutes: 0,
      hasAllergies: false,
    };

    const event: QueueEvent = { type: "session_escalated", sessionId: "s-1", tier: "P1", family: "cardiac" };

    if (event.type === "session_escalated") {
      expect(event.family).toBe("cardiac");
      expect(event.tier).toBe("P1");
    }

    const queueEvent: QueueEvent = { type: "queue_updated", rows: [row] };
    expect(queueEvent.type).toBe("queue_updated");
  });
});
