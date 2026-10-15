import { createDatabase, createPipelineStore, createRepository } from "@qure/db";
import { createIntakeModel } from "@qure/core/intake/llm";
import type { ReadQueue } from "./routes/queue";
import { ConfigError } from "@qure/core/config";
import { persistedPipeline } from "./persisted-pipeline";
/**
 * Composition root. The only file that knows which implementations are live.
 */

import { FakeChannel } from "@qure/core/channel/fake";
import type { Config } from "@qure/core/config";
import { createDecisionModelClient } from "@qure/core/decision-model/client";
import { createOrchestrator, type Orchestrator } from "@qure/core/triage/orchestrator";

export interface Wiring {
  orchestrator: Orchestrator;
  readQueue: ReadQueue;
  /** "baileys" when a phone is linked, "none" when running webhook-only. */
  channelMode: "baileys" | "none";
  close(): Promise<void>;
}

export function parseQueueServiceMinutes(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new ConfigError("QUEUE_SERVICE_MINUTES must be a finite positive number");
  }
  return minutes;
}

export async function wire(config: Config, logger: (message: string) => void): Promise<Wiring> {
  const serviceMinutes = parseQueueServiceMinutes(process.env.QUEUE_SERVICE_MINUTES);
  const database = createDatabase(process.env.DATABASE_URL ?? "");
  const repository = createRepository(database.db);
  const readQueue: ReadQueue = () => repository.readQueueBoard(new Date(), serviceMinutes);
  const intakeModel = createIntakeModel(config.llm);
  const store = createPipelineStore(database.db, {intakeModel});
  const model = createDecisionModelClient(config.model);

  const slots = config.model.slots;

  logger(
    `decision model chain: ${slots
      .map((slot) => `${slot.id} (cutoff ${slot.cutoff}, ceiling ${slot.urgencyCeiling})`)
      .join(" -> ")}`,
  );

  if (!config.whatsapp) {
    // Webhook-only: the pipeline is still fully exercised via curl. The fake
    // channel captures sends that nobody reads, which is the point - nothing
    // here should reach a patient.
    logger("WA_ENABLED is not 'true' - running webhook-only, no WhatsApp channel.");
    const channel = new FakeChannel();
    const core = createOrchestrator({ model, slots, channel, logger });
    return {
      close: database.close,
      readQueue,
      orchestrator: persistedPipeline(core, store, channel, logger),
      channelMode: "none",
    };
  }

  // Imported here rather than at module scope: Baileys is the heaviest
  // dependency in the repo and the webhook-only path must not load it.
  const { createBaileysChannel } = await import("@qure/core/channel/whatsapp");

  const channel = await createBaileysChannel({
    pairingNumber: config.whatsapp.pairingNumber,
    authDir: config.whatsapp.authDir,
    pairingMode: config.whatsapp.pairingMode,
    logger,
  });

  const core = createOrchestrator({ model, slots, channel, logger });
  const orchestrator = persistedPipeline(core, store, channel, logger);
  channel.onMessage((msg) => orchestrator.onInbound(msg));

  return { orchestrator, readQueue, channelMode: "baileys", close:database.close };
}
