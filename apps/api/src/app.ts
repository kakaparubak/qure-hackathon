import Fastify, { type FastifyInstance } from "fastify";

/** Build the Fastify app without binding a port (testable). */
export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({ ok: true, service: "qure-api" }));

  return app;
}
