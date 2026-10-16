import { sql } from 'drizzle-orm';
import { startCheckInWorker } from './check-in-worker';
import { parseCheckInOptions } from './check-in-config';
import { createDatabase, createPipelineStore, createRepository, createQueueEngine, createCheckInEngine, createSessionFhirReader, DEFAULT_QUEUE_OPTIONS, type QueueEngineOptions } from "@qure/db";
import { createEmergencyModel } from "@qure/core/emergency/llm";
import { createIntakeModel } from "@qure/core/intake/llm";
import type { ReadQueue, SessionReaders } from "./routes/queue";
import { ConfigError } from "@qure/core/config";
import { persistedPipeline } from "./persisted-pipeline";
import type { WhatsAppChannel } from "@qure/core";
import { startQueueWorker } from './queue-worker';
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
  sessions: SessionReaders;
  /** "baileys" when a phone is linked, "none" when running webhook-only. */
  channelMode: "baileys" | "none";
  ready():Promise<boolean>;
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

export function parseQueueOptions(env:Record<string,string|undefined>):QueueEngineOptions {
  function positive(name:string,fallback:number):number {
    const value=env[name]?.trim();
    if(!value) return fallback;
    const number=Number(value);
    if(!Number.isFinite(number)||number<=0) throw new ConfigError(`${name} must be a finite positive number`);
    return number;
  }
  return {serviceMinutes:parseQueueServiceMinutes(env.QUEUE_SERVICE_MINUTES),
    callbackDelayMinutes:positive('QUEUE_CALLBACK_DELAY_MINUTES',DEFAULT_QUEUE_OPTIONS.callbackDelayMinutes),
    callbackSpacingMinutes:positive('QUEUE_CALLBACK_SPACING_MINUTES',DEFAULT_QUEUE_OPTIONS.callbackSpacingMinutes)};
}

type SessionRepository = Pick<ReturnType<typeof createRepository>,
  'serveSession' | 'sessionDetail' | 'sessionTriage' | 'sessionMessages' | 'claimStaffSession'> & {
  recordNurseMessage(id:string, body:string):Promise<unknown>;
};

export function createSessionReaders(repository:SessionRepository, channel:WhatsAppChannel|null):SessionReaders {
  return {
    serve: (id) => repository.serveSession(id),
    detail: (id) => repository.sessionDetail(id),
    triage: (id) => repository.sessionTriage(id),
    messages: (id) => repository.sessionMessages(id),
    // Nurse chat room: to the patient's WhatsApp first, transcript second. If
    // the transport rejects it, nothing is persisted - the nurse sees the
    // failure and can retry, rather than a sent-but-unrecorded message.
    sendMessage: async (id, body) => {
      if (!channel) throw new Error("WhatsApp is disabled; nurse messages cannot be delivered");
      const phone = await repository.claimStaffSession(id);
      if (!phone) throw new Error("session not found");
      await channel.send({ phone, text: body, purpose: "reply" });
      await repository.recordNurseMessage(id, body);
    },
  };
}

export async function wire(config: Config, logger: (message: string) => void): Promise<Wiring> {
  const queueOptions = parseQueueOptions(process.env);
  const checkInOptions = parseCheckInOptions(process.env);
  const database = createDatabase(process.env.DATABASE_URL ?? "");
  const repository = createRepository(database.db);
  const readFhir=createSessionFhirReader(database.db);
  const readQueue: ReadQueue = () => repository.readQueueBoard(new Date(), queueOptions.serviceMinutes);
  const intakeModel = createIntakeModel(config.llm, fetch, logger);
  const emergencyModel = createEmergencyModel(config.llm, fetch, logger);
  const store = createPipelineStore(database.db, {intakeModel,emergencyModel,queue:queueOptions,checkIn:checkInOptions});
  const queueEngine=createQueueEngine(database.db,queueOptions);
  const checkInEngine=createCheckInEngine(database.db,checkInOptions);
  const model = createDecisionModelClient(config.model);

  const databaseReady=async()=>{
    try {await database.db.execute(sql`select id from sessions limit 0`);await database.db.execute(sql`select id from queue_runtime limit 0`);return true;}
    catch {return false;}
  };
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
    const worker=startQueueWorker(queueEngine,null,logger);
    return {
      ready:databaseReady,
      close: async()=>{await worker.close();await database.close();},
      readQueue,
      sessions: {...createSessionReaders(repository, null),fhir:readFhir},
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
  const worker=startQueueWorker(queueEngine,channel,logger);
  const checkInWorker=startCheckInWorker(checkInEngine,channel,logger);

  return { ready:async()=>channel.isConnected() && await databaseReady(), orchestrator, readQueue, sessions: {...createSessionReaders(repository, channel),fhir:readFhir}, channelMode: "baileys", close:async()=>{await Promise.all([worker.close(),checkInWorker.close()]);await channel.close();await database.close();} };
}
