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
import qrcode from "qrcode-terminal";
import type { InboundMessage, OutboundMessage, WhatsAppChannel } from "../contracts";
import { createRateLimiter } from "./rate-limit";

/**
 * How the operator proves control of the phone.
 *
 * - "code": Baileys asks WhatsApp for an 8-character code bound to
 *   `pairingNumber`; the operator types it on that phone. Clean over SSH, but
 *   it is bound to one number and dies after roughly two minutes.
 * - "qr": the usual WhatsApp Web flow. Not bound to any number, so it survives
 *   a wrong or unreachable `WA_PAIRING_NUMBER`, at the cost of needing a
 *   terminal to render in.
 */
export type PairingMode = "code" | "qr";

const OUTBOUND_INTERVAL_MS = 1_200;
const RECONNECT_DELAY_MS = 2_000;
/** Pairing codes expire; this caps how many the adapter will mint unattended. */
const MAX_PAIRING_ATTEMPTS = 5;
/**
 * WhatsApp pairing codes are valid for roughly two minutes. Re-mint a little
 * before that so the code in the log is always typeable, rather than the
 * operator having to ask for a restart mid-flow.
 */
const PAIRING_CODE_TTL_MS = 110_000;
/** Reconnect backoff ceiling. Never hammer a provider that is refusing us. */
const MAX_RECONNECT_DELAY_MS = 60_000;

export interface BaileysChannelOptions {
  /** E.164 digits, no leading '+'. Unused when pairingMode is "qr". */
  pairingNumber: string;
  authDir: string;
  /** Defaults to "code". */
  pairingMode?: PairingMode;
  logger?: (message: string) => void;
  /**
   * Where the QR art goes. Deliberately not the logger: the structured logger
   * JSON-escapes newlines, which turns a scannable QR into one unreadable line.
   */
  qrSink?: (art: string) => void;
}

/**
 * Whether this auth dir already holds a linked account.
 *
 * `creds.registered` is NOT that signal, despite the name. Baileys sets it in
 * exactly one place - the pairing-*code* path (messages-recv.js, the
 * link_code_pairing_ref branch). A QR pairing sets `creds.me` and leaves
 * `registered` false forever, so gating on it would print a QR and request a
 * pairing code over a session that is already live, on every restart.
 *
 * Baileys itself branches on `creds.me` (Socket/socket.js: no `me` means
 * "send the pairing IQ", otherwise "generate the login node"), and this
 * follows the same rule.
 */
export function isPaired(creds: { me?: unknown; registered?: boolean }): boolean {
  return creds.me !== undefined && creds.me !== null;
}

/**
 * The phone number behind an inbound message key.
 *
 * WhatsApp is migrating accounts to LIDs, so `remoteJid` is frequently
 * "1234567890@lid" rather than a phone-number JID - and a message whose JID is
 * a LID would otherwise be dropped in silence. Two ways out, in order:
 *
 * 1. `remoteJidAlt`, which carries the phone-number form alongside a LID.
 * 2. The LID mapping store, which Baileys persists next to the session as
 *    `lid-mapping-<lid>_reverse.json`.
 */
export async function resolvePhone(
  sock: { signalRepository: { lidMapping: { getPNForLID(lid: string): Promise<string | null> } } },
  key: { remoteJid?: string | null; remoteJidAlt?: string | null },
): Promise<string | null> {
  const fromAlt = phoneFromJid(key.remoteJidAlt);
  if (fromAlt) return fromAlt;

  const fromJid = phoneFromJid(key.remoteJid);
  if (fromJid) return fromJid;

  const jid = key.remoteJid;
  if (!jid || !jid.endsWith("@lid")) return null;

  const pn = await sock.signalRepository.lidMapping
    .getPNForLID(jid)
    .catch(() => null);

  return phoneFromJid(pn);
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

export interface BaileysChannel extends WhatsAppChannel {
  isConnected():boolean;
  close():Promise<void>;
}
interface ChannelDependencies {openSocket:typeof makeWASocket;loadAuth:typeof useMultiFileAuthState;}
export async function createBaileysChannel(
  options: BaileysChannelOptions,
  dependencies:ChannelDependencies={openSocket:makeWASocket,loadAuth:useMultiFileAuthState},
): Promise<BaileysChannel> {
  const log = options.logger ?? (() => {});
  const mode: PairingMode = options.pairingMode ?? "code";
  const qrSink = options.qrSink ?? ((art: string) => process.stdout.write(art));
  const limiter = createRateLimiter(OUTBOUND_INTERVAL_MS);

  let handler: ((msg: InboundMessage) => Promise<void>) | null = null;
  let socket: ReturnType<typeof makeWASocket> | null = null;
  let pairingRequested = false;
  let pairingAttempts = 0;
  let reconnecting = false;
  let reconnectDelay = RECONNECT_DELAY_MS;
  let stopped=false;
  let connected=false;
  let closing:Promise<void>|null=null;
  const timers=new Set<ReturnType<typeof setTimeout>>();
  const inFlight=new Set<Promise<void>>();
  const authWrites=new Set<Promise<void>>();
  function schedule(callback:()=>void,delay:number) {
    const timer=setTimeout(()=>{timers.delete(timer);if(!stopped)callback();},delay);
    timers.add(timer);
  }

  async function connect(): Promise<void> {
    if(stopped) return;
    const { state, saveCreds } = await dependencies.loadAuth(options.authDir);
    if(stopped) return;
    const sock = dependencies.openSocket({
      auth: state,
      printQRInTerminal: false,
      browser: Browsers.appropriate("desktop"),
      // Only the tail of history matters; a full sync is slow and noisy.
      syncFullHistory: false,
    });
    socket = sock;

    sock.ev.on("creds.update",()=>{
      const write=saveCreds().catch(()=>log('WhatsApp credential save failed.')).finally(()=>authWrites.delete(write));
      authWrites.add(write);
    });

    sock.ev.on("connection.update", (update) => {
      if(stopped || socket !== sock) return;
      const { connection, lastDisconnect } = update;

      if (connection === "open") {
        connected=true;
        log(`WhatsApp connected as ${options.pairingNumber}`);
        // A working connection clears the backoff, so a later blip starts
        // from the short delay again instead of the ceiling.
        reconnectDelay = RECONNECT_DELAY_MS;
        return;
      }

      if (connection !== "close") return;
      connected=false;

      const status = statusOf(lastDisconnect?.error);

      // Terminal only for a session that was actually linked: the credentials
      // are dead and only a human can re-pair. An *unregistered* socket gets
      // loggedOut too - a rejected or lapsed pairing code - and stopping there
      // strands the process with no way forward, so it falls through to the
      // reconnect below and mints a new code.
      if (status === DisconnectReason.loggedOut && isPaired(state.creds)) {
        log("WhatsApp logged out. Delete the auth dir and pair again.");
        return;
      }

      // A code that expired unentered closes the socket (408/428), and the
      // reconnect loop would then sit there forever: `pairingRequested` stays
      // true, so no new code is ever minted. Forgetting the request lets the
      // next qr frame issue a fresh one instead of needing a process restart.
      if (!isPaired(state.creds)) pairingRequested = false;

      // Stop once the pairing budget is spent. An unregistered socket that
      // keeps answering 401 is a rejected or lapsed pairing, and retrying that
      // on a fixed short timer is how a spare number gets rate-limited: a live
      // run hammered the endpoint every 2s for nine minutes. Sitting quiet and
      // telling the operator to restart is the safe failure.
      if (mode === "code" && !isPaired(state.creds) && pairingAttempts >= MAX_PAIRING_ATTEMPTS) {
        log("Pairing attempts exhausted; not reconnecting. Restart to try a new code.");
        return;
      }

      if (reconnecting) return;
      reconnecting = true;

      // Backoff, not a fixed gap: a provider that is refusing us right now is
      // not going to accept us two seconds from now either.
      const delay = reconnectDelay;
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
      log(
        `WhatsApp connection closed (status ${status ?? "unknown"}). ` +
          `Reconnecting in ${Math.round(delay / 1000)}s.`,
      );

      schedule(() => {
        reconnecting = false;
        void connect().catch((error: unknown) => log(`Reconnect failed: ${message(error)}`));
      }, delay);
    });

    // Pair only when this auth dir has never been registered, and only once the
    // socket has something to pair with: the first `qr` frame means the noise
    // handshake completed. Asking earlier throws "Connection Closed" - the
    // socket exists but the websocket is not up yet.
    if (!isPaired(state.creds)) {
      if (mode === "qr") {
        let lastQr: string | null = null;

        sock.ev.on("connection.update", (update) => {
          // WhatsApp rotates the QR every ~20s and only the newest one is
          // scannable, so each new value is printed rather than the first.
          if (stopped || !update.qr || update.qr === lastQr) return;
          lastQr = update.qr;

          log("Scan this QR: WhatsApp -> Settings -> Linked Devices -> Link a device.");
          qrcode.generate(update.qr, { small: true }, (art: string) => {
            qrSink(`\n${art}\n`);
          });
        });
      } else {
        sock.ev.on("connection.update", (update) => {
          if (stopped || !update.qr || pairingRequested) return;

          if (pairingAttempts >= MAX_PAIRING_ATTEMPTS) {
            // Bounded on purpose: an unbounded loop against WhatsApp's pairing
            // endpoint is how a spare number gets rate-limited or flagged.
            if (pairingAttempts === MAX_PAIRING_ATTEMPTS) {
              pairingAttempts += 1;
              log(
                `Giving up after ${MAX_PAIRING_ATTEMPTS} pairing attempts. ` +
                  "Check WA_PAIRING_NUMBER is the number of the phone you are " +
                  "entering the code on, or set WA_PAIRING_MODE=qr, then restart.",
              );
            }
            return;
          }

          pairingRequested = true;
          pairingAttempts += 1;
          void sock
            .requestPairingCode(options.pairingNumber)
            .then((code: string) => {
              log(
                `Pairing code: ${code} - enter it under Linked Devices on that phone. ` +
                  `(expires in about two minutes; a fresh one is minted automatically)`,
              );

              // Clear the guard just before this code lapses, so the next qr
              // frame mints a new one. Bounded by MAX_PAIRING_ATTEMPTS.
              schedule(() => {
                if (!isPaired(state.creds)) pairingRequested = false;
              }, PAIRING_CODE_TTL_MS);
            })
            .catch((error: unknown) => {
              // Allow the next qr frame (~20s) to retry rather than wedging
              // forever on one bad attempt.
              pairingRequested = false;
              log(`Pairing failed: ${message(error)}`);
            });
        });
      }
    }

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if(stopped || socket !== sock || type !== 'notify' || !handler) return;
      const run=handler;
      for(const incoming of messages) {
        if(incoming.key.fromMe) continue;
        // Register accepted work before its first await, including LID lookup.
        // A SIGTERM arriving during resolution must still drain this message.
        const task=(async()=>{
          const phone=await resolvePhone(sock,incoming.key);
          if(!phone) {log('Ignored a message with no resolvable phone number.');return;}
          const content=incoming.message as Record<string,unknown>|null|undefined;
          const inbound:InboundMessage={phone,text:textOf(content),providerMessageId:incoming.key.id ?? `${phone}-${Date.now()}`,
            receivedAt:toDate(incoming.messageTimestamp),kind:kindOf(content)};
          log(`Inbound ${inbound.kind} from ${phone}.`);
          await run(inbound);
        })().catch(()=>log('Inbound WhatsApp handling failed.')).finally(()=>inFlight.delete(task));
        inFlight.add(task);
      }
    });
  }

  await connect();

  return {
    isConnected:()=>connected && !stopped,
    close() {
      if(closing) return closing;
      stopped=true;connected=false;handler=null;
      for(const timer of timers) clearTimeout(timer);
      timers.clear();
      closing=(async()=>{
        await Promise.allSettled([...inFlight]);
        socket?.end(new Error('Service shutting down'));socket=null;
        await Promise.allSettled([...authWrites]);
      })();
      return closing;
    },
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
