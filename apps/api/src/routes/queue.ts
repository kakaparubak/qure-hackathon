import type { FastifyInstance } from "fastify";
import type { QueueTicketRow } from "@qure/core/queue/tickets";

export type ReadQueue = () => Promise<QueueTicketRow[]>;

export function registerQueueRoute(app: FastifyInstance, readQueue?: ReadQueue): void {
  app.get("/api/queue", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      if (!readQueue) throw new Error("queue reader unavailable");
      return { rows: await readQueue() };
    } catch {
      app.log.warn("Queue read unavailable");
      return reply.code(503).send({ error: "Queue is temporarily unavailable" });
    }
  });
}
