import type { InboundMessage, OutboundMessage, WhatsAppChannel } from "../contracts";

/** In-memory channel for tests and for running the pipeline without a phone. */
export class FakeChannel implements WhatsAppChannel {
  readonly sent: OutboundMessage[] = [];

  private handler: ((msg: InboundMessage) => Promise<void>) | null = null;

  async send(msg: OutboundMessage): Promise<void> {
    this.sent.push(msg);
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  /** Simulates an inbound message arriving from the transport. */
  async receive(msg: InboundMessage): Promise<void> {
    if (!this.handler) throw new Error("FakeChannel.receive called before onMessage");
    await this.handler(msg);
  }
}
