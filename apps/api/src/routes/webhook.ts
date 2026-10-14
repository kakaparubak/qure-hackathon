/**
 * The pipeline's second front door.
 *
 * Baileys calls the handler in-process; this route exposes the same handler
 * over HTTP so the LLM half can be proven with curl before (or without) a
 * phone being linked. It is also the shape the Meta Cloud API fallback needs.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { InboundMessage, OutboundMessage } from "@qure/core";

const INBOUND_SCHEMA = z.object({
  phone: z.string().regex(/^\d{8,15}$/, "phone must be E.164 digits without '+'"),
  text: z.string(),
  providerMessageId: z.string().min(1, "providerMessageId is required"),
  receivedAt: z.coerce.date(),
  kind: z.enum(["text", "audio", "image", "document", "other"]),
});

export type HandleInbound = (msg: InboundMessage) => Promise<OutboundMessage | null>;

export function registerWebhookRoute(app: FastifyInstance, handleInbound: HandleInbound): void {
  app.post("/webhook/inbound", async (request, reply) => {
    const parsed = INBOUND_SCHEMA.safeParse(request.body);

    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return reply.status(400).send({
        ok: false,
        error: issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "invalid body",
      });
    }

    const result = await handleInbound(parsed.data);
    return reply.status(200).send({ ok: true, reply: result });
  });
}
