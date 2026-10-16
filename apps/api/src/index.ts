import { ConfigError, loadConfig, type Config } from "@qure/core/config";
import type { Orchestrator } from "@qure/core/triage/orchestrator";
import type { ReadQueue, SessionReaders } from "./routes/queue";
import { buildApp } from "./app";
import { wire, type Wiring } from "./wiring";
import { installShutdown } from "./shutdown";
import { readDashboardCredentials } from "./dashboard-auth";

export async function createServer(config:Config,wireRuntime:typeof wire=wire,logger=true,dashboardAuth?:ReturnType<typeof readDashboardCredentials>) {

  // The app is built before the pipeline exists so that wiring can log through
  // the app's own logger rather than reaching for the console. Requests that
  // arrive before wiring finishes get an explicit error, not a silent drop.
  let orchestrator: Orchestrator | null = null;
  let readQueue: ReadQueue | null = null;
  let sessions: SessionReaders | null = null;
  let wiring:Wiring|null=null;

  const app = buildApp({
    logger,
    dashboardAuth,
    readiness:async()=>wiring !== null && await wiring.ready(),
    readQueue: async () => {
      if (!readQueue) throw new Error("queue is still starting");
      return readQueue();
    },
    sessions: {
      fhir:async(id)=>{
        if(!sessions?.fhir) throw new Error('FHIR export is still starting');
        return sessions.fhir(id);
      },
      serve: async (id) => {
        if (!sessions) throw new Error("sessions are still starting");
        return sessions.serve(id);
      },
      detail: async (id) => {
        if (!sessions) throw new Error("sessions are still starting");
        return sessions.detail(id);
      },
      triage: async (id) => {
        if (!sessions) throw new Error("sessions are still starting");
        return sessions.triage(id);
      },
      messages: async (id) => {
        if (!sessions) throw new Error("sessions are still starting");
        return sessions.messages(id);
      },
      sendMessage: async (id, body) => {
        if (!sessions) throw new Error("sessions are still starting");
        return sessions.sendMessage(id, body);
      },
    },
    handleInbound: async (msg) => {
      if (!orchestrator) throw new Error("pipeline is still starting");
      return orchestrator.handleInbound(msg);
    },
  });

  wiring = await wireRuntime(config, (text) => app.log.info(text));
  orchestrator = wiring.orchestrator;
  readQueue = wiring.readQueue;
  sessions = wiring.sessions;
  app.addHook("onClose", async () => { await wiring?.close(); });
  app.log.info(`channel mode: ${wiring.channelMode}`);
  return app;
}

async function main() {
  const config=loadConfig(process.env);
  const dashboardAuth=readDashboardCredentials(process.env);
  const app=await createServer(config,wire,true,dashboardAuth);
  const removeShutdown=installShutdown(app,process);
  app.addHook('onClose',async()=>{removeShutdown();});
  await app.listen({port:config.port,host:'0.0.0.0'});
}

if(import.meta.main) main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`[qure] configuration error: ${error.message}\n`);
    process.stderr.write("[qure] copy .env.example to .env and fill it in.\n");
    process.exit(1);
  }

  process.stderr.write(`[qure] fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
