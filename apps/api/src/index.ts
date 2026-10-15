import { ConfigError, loadConfig } from "@qure/core/config";
import type { Orchestrator } from "@qure/core/triage/orchestrator";
import type { ReadQueue } from "./routes/queue";
import { buildApp } from "./app";
import { wire } from "./wiring";

async function main(): Promise<void> {
  const config = loadConfig(process.env);

  // The app is built before the pipeline exists so that wiring can log through
  // the app's own logger rather than reaching for the console. Requests that
  // arrive before wiring finishes get an explicit error, not a silent drop.
  let orchestrator: Orchestrator | null = null;
  let readQueue: ReadQueue | null = null;

  const app = buildApp({
    logger: true,
    readQueue: async () => {
      if (!readQueue) throw new Error("queue is still starting");
      return readQueue();
    },
    handleInbound: async (msg) => {
      if (!orchestrator) throw new Error("pipeline is still starting");
      return orchestrator.handleInbound(msg);
    },
  });

  const wiring = await wire(config, (text) => app.log.info(text));
  orchestrator = wiring.orchestrator;
  readQueue = wiring.readQueue;
  app.addHook("onClose", async () => { await wiring.close(); });

  app.log.info(`channel mode: ${wiring.channelMode}`);
  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`[qure] configuration error: ${error.message}\n`);
    process.stderr.write("[qure] copy .env.example to .env and fill it in.\n");
    process.exit(1);
  }

  process.stderr.write(`[qure] fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
