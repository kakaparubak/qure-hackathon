/**
 * Baileys implementation of WhatsAppChannel. Demo-only transport.
 *
 * Responsibilities kept here so nothing else learns about WhatsApp:
 *   - JID <-> E.164 normalisation
 *   - dropping groups, self-messages, status broadcasts and history replay
 *   - pacing outbound sends
 *   - reconnecting when the socket drops
 *
 * The pairing code is requested here too: an 8-digit code entered under Linked
 * Devices beats a terminal QR, which expires in seconds and renders badly over
 * SSH and tmux.
 *
 * This module is the only one that imports Baileys, and it is deliberately
 * absent from the package barrel. Import it directly:
 *   import { createBaileysChannel } from "@qure/core/channel/whatsapp";
 */

import { Browsers, DisconnectReason, makeWASocket, useMultiFileAuthState } from "baileys";
import type { InboundMessage, OutboundMessage, WhatsAppChannel } from "../contracts";
import { createRateLimiter } from "./rate-limit";

const OUTBOUND_INTERVAL_MS = 1_200;
const RECONNECT_DELAY_MS = 2_000;

export interface BaileysChannelOptions {
  /** E.164 digits, no leading '+'. */
  pairingNumber: string;
  authDir: string;
  logger?: (message: string) => void;
}

/**
 * "628123456789:12@s.whatsapp.net" -> "628123456789".
 * null for groups, broadcasts, and anything that is not a person.
 */
export function phoneFromJid(jid: string | null | undefined): string | null {
  if (!jid) return null;
  if (!jid.endsWith("@s.whatsapp.net")) return null;

  const bare = jid.split("@")[0] ?? "";
  const withoutDevice = bare.split(":")[0] ?? "";

  return /^\d{8,15}$/.test(withoutDevice) ? withoutDevice : null;
}

/** Maps a Baileys message content onto the contract's kind. */
export function kindOf(
  content: Record<string, unknown> | null | undefined,
): InboundMessage["kind"] {
  if (!content) return "other";
  if (content.conversation || content.extendedTextMessage) return "text";
  if (content.audioMessage) return "audio";
  if (content.imageMessage) return "image";
  if (content.documentMessage) return "document";
  return "other";
}

/** Text of a Baileys message, or "" for payloads that carry none. */
export function textOf(content: Record<string, unknown> | null | undefined): string {
  if (!content) return "";

  const direct = content.conversation;
  if (typeof direct === "string") return direct;

  const extended = content.extendedTextMessage as { text?: unknown } | undefined;
  if (typeof extended?.text === "string") return extended.text;

  // Voice notes and images often carry their content in a caption.
  const withCaption = (content.imageMessage ??
    content.documentMessage ??
    content.audioMessage) as { caption?: unknown } | undefined;

  return typeof withCaption?.caption === "string" ? withCaption.caption : "";
}

/** Baileys timestamps are seconds, either a number or a Long. */
function toDate(timestamp: unknown): Date {
  if (typeof timestamp === "number") return new Date(timestamp * 1000);

  const long = timestamp as { toNumber?: () => number } | null | undefined;
  if (long && typeof long.toNumber === "function") return new Date(long.toNumber() * 1000);

  return new Date();
}

function statusOf(error: unknown): number | undefined {
  return (error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export async function createBaileysChannel(
  options: BaileysChannelOptions,
): Promise<WhatsAppChannel> {
  const log = options.logger ?? (() => {});
  const limiter = createRateLimiter(OUTBOUND_INTERVAL_MS);

  let handler: ((msg: InboundMessage) => Promise<void>) | null = null;
  let socket: ReturnType<typeof makeWASocket> | null = null;
  let pairingRequested = false;
  let reconnecting = false;

  async function connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(options.authDir);
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: Browsers.appropriate("desktop"),
      // Only the tail of history matters; a full sync is slow and noisy.
      syncFullHistory: false,
    });
    socket = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === "open") {
        log(`WhatsApp connected as ${options.pairingNumber}`);
        return;
      }

      if (connection !== "close") return;

      const status = statusOf(lastDisconnect?.error);

      if (status === DisconnectReason.loggedOut) {
        log("WhatsApp logged out. Delete the auth dir and pair again.");
        return;
      }

      if (reconnecting) return;
      reconnecting = true;
      log(`WhatsApp connection closed (status ${status ?? "unknown"}). Reconnecting.`);

      // A short gap keeps a persistent failure from becoming a hot loop.
      setTimeout(() => {
        reconnecting = false;
        void connect().catch((error: unknown) => log(`Reconnect failed: ${message(error)}`));
      }, RECONNECT_DELAY_MS);
    });

    // Pair only when this auth dir has never been registered.
    if (!state.creds.registered && !pairingRequested) {
      pairingRequested = true;
      try {
        const code = await sock.requestPairingCode(options.pairingNumber);
        log(`Pairing code: ${code} - enter it under Linked Devices on that phone.`);
      } catch (error: unknown) {
        log(`Pairing failed: ${message(error)}`);
      }
    }

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      // "notify" is a live message. "append" is history replay on reconnect,
      // which would otherwise be answered as if it had just arrived.
      if (type !== "notify") return;

      for (const incoming of messages) {
        if (incoming.key.fromMe) continue;

        const phone = phoneFromJid(incoming.key.remoteJid);
        if (!phone) continue;

        const content = incoming.message as Record<string, unknown> | null | undefined;
        const inbound: InboundMessage = {
          phone,
          text: textOf(content),
          providerMessageId: incoming.key.id ?? `${phone}-${Date.now()}`,
          receivedAt: toDate(incoming.messageTimestamp),
          kind: kindOf(content),
        };

        void handler?.(inbound).catch((error: unknown) => {
          log(`Handler failed for ${inbound.providerMessageId}: ${message(error)}`);
        });
      }
    });
  }

  await connect();

  return {
    async send(msg: OutboundMessage): Promise<void> {
      await limiter.wait(msg.phone);

      if (!socket) throw new Error("WhatsApp socket is not connected");

      await socket.sendMessage(`${msg.phone}@s.whatsapp.net`, { text: msg.text });
    },

    onMessage(next: (msg: InboundMessage) => Promise<void>): void {
      handler = next;
    },
  };
}
