/**
 * Channel-to-pipeline message envelope.
 *
 * Both WhatsApp adapters (Baileys for the hackathon demo, Meta Cloud API as the
 * fallback) implement the same interface and emit the same shapes, so the
 * pipeline is unaware of which channel is live.
 */

/**
 * A message that arrived from a patient.
 *
 * `phone` is the patient identity in this system: there is no account creation,
 * no OTP, no login. It is E.164 *without* a leading '+' (e.g. "628123456789"),
 * normalized at the adapter boundary so the pipeline never sees inconsistent
 * formats.
 */
export interface InboundMessage {
  /** E.164 without '+', e.g. "628123456789". This is the patient identity. */
  phone: string;

  /** Message text as typed. Empty string for non-text payloads. */
  text: string;

  /** External provider message id, used to deduplicate retries. */
  providerMessageId: string;

  /** When the message was received. */
  receivedAt: Date;

  /**
   * What actually arrived. Voice notes are common from real users, so the
   * pipeline is forced to handle them explicitly rather than crashing on an
   * unexpected payload.
   */
  kind: "text" | "audio" | "image" | "document" | "other";
}

/** A message the system sends to a patient. */
export interface OutboundMessage {
  /** Recipient in the same normalized format as InboundMessage.phone. */
  phone: string;

  /** Message body. */
  text: string;

  /**
   * Why this message was sent. Used for logging (playbook_log) and to keep
   * automated traffic distinguishable from conversational replies.
   * null for ordinary conversational replies.
   */
  purpose: "reply" | "playbook" | "queue_update" | "surge_broadcast" | null;
}

/**
 * The channel seam. Implementations are responsible for their own transport
 * concerns, including outbound rate limiting (rapid identical sends look like
 * spam automation and risk the number).
 */
export interface WhatsAppChannel {
  /** Send one message. Implementation rate-limits internally. */
  send(msg: OutboundMessage): Promise<void>;

  /** Register the handler that receives every inbound message. */
  onMessage(handler: (msg: InboundMessage) => Promise<void>): void;
}
