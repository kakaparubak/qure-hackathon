import type { FastifyInstance, FastifyReply } from "fastify";
import type { QueueTicketRow } from "@qure/core/queue/tickets";

export type ReadQueueForEvents = () => Promise<QueueTicketRow[]>;

const POLL_MS = 3_000;

/**
 * Server-Sent Events for the nurse dashboard.
 *
 * The team frontend listens for named events (session_created,
 * session_escalated, queue_updated, session_served). Only queue_updated is
 * emitted: it carries the full board, and the dashboard re-fetches truth on
 * reconnect anyway, so the other names are optimisations, not requirements.
 * Emission is poll-based - no pub/sub between the pipeline transaction and
 * this process, and a 3s board refresh is well within triage latency.
 */
export function registerEventsRoute(app: FastifyInstance, readQueue?: ReadQueueForEvents): void {
  const streams=new Set<import('node:http').ServerResponse>();
  app.addHook('preClose',async()=>{for(const stream of streams)stream.end();streams.clear();});
  app.get("/api/events", async (_request, reply: FastifyReply) => {
    if (!readQueue) return reply.code(503).send({ error: "Events unavailable" });

    streams.add(reply.raw);
    reply.raw.once("close",()=>streams.delete(reply.raw));
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    reply.raw.write("retry: 2000\n\n");

    let last: string | null = null;
    let closed = false;
    _request.raw.on("close", () => {
      closed = true;
    });

    const push = async () => {
      if (closed) return;
      try {
        const rows = await readQueue();
        if(closed || reply.raw.writableEnded) return;
        const payload = JSON.stringify(rows);
        if (payload !== last) {
          last = payload;
          reply.raw.write(`event: queue_updated\ndata: ${payload}\n\n`);
        }
      } catch {
        // Transient DB failure: keep the stream open, next tick retries.
      }
    };

    await push();
    const timer = setInterval(push, POLL_MS);
    _request.raw.on("close", () => clearInterval(timer));
  });
}
