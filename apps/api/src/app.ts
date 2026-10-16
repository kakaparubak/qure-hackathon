import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerQueueRoute, type ReadQueue, type SessionReaders } from "./routes/queue";
import { registerEventsRoute } from "./routes/events";
import Fastify, { type FastifyInstance } from "fastify";
import { registerWebhookRoute, type HandleInbound } from "./routes/webhook";

export interface AppDeps {
  /** The orchestrator's handleInbound. Injected so tests need no network. */
  handleInbound: HandleInbound;
  /** Enable Fastify's pino logger. Off in tests. */
  logger?: boolean;
  readiness?:()=>Promise<boolean>;
  readQueue?: ReadQueue;
  /** Nurse-facing session reads/writes. Omit for webhook-only tests. */
  sessions?: SessionReaders;
  /** Override built asset directory for isolated hosts/tests. */
  dashboardRoot?: string;
}

/** Build the Fastify app without binding a port (testable). */
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false });

  app.get("/health", async () => ({ ok: true, service: "qure-api" }));

  app.get('/ready',async(_request,reply)=>{
    reply.header('Cache-Control','no-store');
    try {if(deps.readiness && await deps.readiness()) return {ok:true};} catch { /* No dependency details in a probe. */ }
    return reply.code(503).send({ok:false});
  });

  registerWebhookRoute(app, deps.handleInbound);
  registerQueueRoute(app, deps.readQueue, deps.sessions);
  registerEventsRoute(app, deps.readQueue);

  const dashboardRoot = deps.dashboardRoot ?? fileURLToPath(new URL("../../dashboard/dist/", import.meta.url));
  app.get("/dashboard", async (_request, reply) => reply.redirect("/dashboard/"));
  if (existsSync(join(dashboardRoot, "index.html"))) {
    app.register(fastifyStatic, { root: dashboardRoot, prefix: "/dashboard/" });
  } else {
    app.get("/dashboard/", async (_request, reply) =>
      reply.code(503).send({ error: "Dashboard assets unavailable; run bun run build" }));
  }

  return app;
}
