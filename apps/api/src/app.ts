import Fastify, { type FastifyInstance } from "fastify";
import { registerWebhookRoute, type HandleInbound } from "./routes/webhook";

export interface AppDeps {
  /** The orchestrator's handleInbound. Injected so tests need no network. */
  handleInbound: HandleInbound;
}

/** Build the Fastify app without binding a port (testable). */
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({ ok: true, service: "qure-api" }));

  registerWebhookRoute(app, deps.handleInbound);

  return app;
}
