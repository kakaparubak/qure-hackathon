/**
 * Composition root. The only file that knows which implementations are live.
 */

import { FakeChannel } from "@qure/core/channel/fake";
import type { Config } from "@qure/core/config";
import { createDecisionModelClient } from "@qure/core/decision-model/client";
import { createOrchestrator, type Orchestrator } from "@qure/core/triage/orchestrator";

export interface Wiring {
  orchestrator: Orchestrator;
  /** "baileys" when a phone is linked, "none" when running webhook-only. */
  channelMode: "baileys" | "none";
}

export async function wire(config: Config, logger: (message: string) => void): Promise<Wiring> {
  const model = createDecisionModelClient(config.model);

  const cutoffs = {
    primaryId: config.model.primaryId,
    fallbackId: config.model.fallbackId,
    cutoffPrimary: config.model.cutoffPrimary,
    cutoffFallback: config.model.cutoffFallback,
  };

  if (!config.whatsapp) {
    // Webhook-only: the pipeline is still fully exercised via curl. The fake
    // channel captures sends that nobody reads, which is the point - nothing
    // here should reach a patient.
    logger("WA_ENABLED is not 'true' - running webhook-only, no WhatsApp channel.");
    return {
      orchestrator: createOrchestrator({ model, cutoffs, channel: new FakeChannel() }),
      channelMode: "none",
    };
  }

  // Imported here rather than at module scope: Baileys is the heaviest
  // dependency in the repo and the webhook-only path must not load it.
  const { createBaileysChannel } = await import("@qure/core/channel/whatsapp");

  const channel = await createBaileysChannel({
    pairingNumber: config.whatsapp.pairingNumber,
    authDir: config.whatsapp.authDir,
    logger,
  });

  const orchestrator = createOrchestrator({ model, cutoffs, channel });
  channel.onMessage((msg) => orchestrator.onInbound(msg));

  return { orchestrator, channelMode: "baileys" };
}
