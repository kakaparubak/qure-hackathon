import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { QueueTicketRow } from "@qure/core/queue/tickets";

const NURSE_MESSAGE_SCHEMA = z.object({ body: z.string().trim().min(1).max(1000) }).strict();

/**
 * Nurse-facing reads. Row shape is the contract QueueRow plus the stable
 * ticket identity; the team dashboard consumes a bare array (its api.ts TODO
 * says exactly that).
 */
export type ReadQueue = () => Promise<QueueTicketRow[]>;

export interface SessionReaders {
  fhir?: (id:string)=>Promise<import("@qure/core/fhir/mapper").FhirBundle|null>;
  serve: (id: string) => Promise<"served" | "already_finished" | "missing">;
  detail: (id: string) => Promise<unknown>;
  triage: (id: string) => Promise<unknown>;
  messages: (id: string) => Promise<unknown>;
  /** Sends a nurse's message to the patient over the live transport. */
  sendMessage: (id: string, body: string) => Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerQueueRoute(
  app: FastifyInstance,
  readQueue?: ReadQueue,
  sessions?: SessionReaders,
): void {
  app.get("/api/queue", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      if (!readQueue) throw new Error("queue reader unavailable");
      return await readQueue();
    } catch {
      app.log.warn("Queue read unavailable");
      return reply.code(503).send({ error: "Queue is temporarily unavailable" });
    }
  });

  if (!sessions) return;

  // Team dashboard's serve TODO: an id served elsewhere first should read as
  // finished, not error the nurse's row back into existence. 404 only when
  // the session itself does not exist.
  app.post("/api/sessions/:id/serve", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(404).send({ error: "Session not found" });
    try {
      const outcome = await sessions.serve(id);
      if (outcome === "missing") return reply.code(404).send({ error: "Session not found" });
      return reply.code(204).send();
    } catch {
      app.log.warn(`Serve failed for ${id}`);
      return reply.code(503).send({ error: "Serve is temporarily unavailable" });
    }
  });

  const uuidGuard = (
    handler: (id: string) => Promise<unknown>,
  ) => async (request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => {
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(404).send({ error: "Session not found" });
    try {
      const payload = await handler(id);
      if (payload === null) return reply.code(404).send({ error: "Session not found" });
      reply.header("Cache-Control", "no-store");
      return payload;
    } catch {
      app.log.warn(`Session read failed for ${id}`);
      return reply.code(503).send({ error: "Session data is temporarily unavailable" });
    }
  };

  app.get('/api/sessions/:id/fhir',async(request,reply)=>{
    reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff');
    const {id}=request.params as {id:string};
    if(!UUID.test(id)) return reply.code(404).send({error:'Session not found'});
    try {
      if(!sessions.fhir) throw new Error('FHIR reader unavailable');
      const bundle=await sessions.fhir(id);
      if(!bundle) return reply.code(404).send({error:'Session not found'});
      return reply.type('application/fhir+json').header('Content-Disposition',`attachment; filename="qure-${id}.fhir.json"`).send(bundle);
    } catch {
      app.log.warn('FHIR export unavailable');
      return reply.code(503).send({error:'FHIR export is temporarily unavailable'});
    }
  });

  app.get("/api/sessions/:id", uuidGuard(sessions.detail));
  app.get("/api/sessions/:id/triage", uuidGuard(sessions.triage));
  app.get("/api/sessions/:id/messages", uuidGuard(sessions.messages));

  // The nurse chat room: a message typed in the dashboard goes to the
  // patient's WhatsApp and lands in the same transcript the bot writes to.
  app.post("/api/sessions/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(404).send({ error: "Session not found" });

    const parsed = NURSE_MESSAGE_SCHEMA.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "body: a message of 1-1000 characters is required" });
    }

    try {
      await sessions.sendMessage(id, parsed.data.body);
      return reply.code(201).send({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "session not found") return reply.code(404).send({ error: "Session not found" });
      app.log.warn(`Nurse message send failed for ${id}`);
      return reply.code(503).send({ error: "Message could not be delivered" });
    }
  });
}
