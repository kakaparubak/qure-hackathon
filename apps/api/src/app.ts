import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerQueueRoute, type ReadQueue } from "./routes/queue";
import Fastify, { type FastifyInstance } from "fastify";
import { registerWebhookRoute, type HandleInbound } from "./routes/webhook";

export interface AppDeps {
  /** The orchestrator's handleInbound. Injected so tests need no network. */
  handleInbound: HandleInbound;
  /** Enable Fastify's pino logger. Off in tests. */
  logger?: boolean;
  readQueue?: ReadQueue;
  /** Override built asset directory for isolated hosts/tests. */
  dashboardRoot?: string;
}

/** Build the Fastify app without binding a port (testable). */
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false });

  app.get("/health", async () => ({ ok: true, service: "qure-api" }));

  registerWebhookRoute(app, deps.handleInbound);
  registerQueueRoute(app, deps.readQueue);

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
