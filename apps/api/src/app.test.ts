import { describe, expect, test } from "bun:test";
import { TEMPLATES } from "@qure/core/reply/templates";
import type { InboundMessage } from "@qure/core";
import { buildApp } from "./app";

/**
 * Handler stub. Uses the real contract types so a change to InboundMessage
 * breaks this test rather than silently drifting.
 */
const handleInbound = async (msg: InboundMessage) => ({
  phone: msg.phone,
  text: TEMPLATES.intake,
  purpose: "reply" as const,
});

const VALID_BODY = {
  phone: "628123456789",
  text: "demam tiga hari",
  providerMessageId: "MSG-1",
  receivedAt: "2026-10-14T10:00:00.000Z",
  kind: "text",
};

describe("GET /health", () => {
  test("returns ok with service name", async () => {
    const app = buildApp({ handleInbound });
    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, service: "qure-api" });

    await app.close();
  });
});

describe("POST /webhook/inbound", () => {
  test("returns the reply for a valid message", async () => {
    const app = buildApp({ handleInbound });
    const res = await app.inject({ method: "POST", url: "/webhook/inbound", payload: VALID_BODY });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      reply: { phone: "628123456789", text: TEMPLATES.intake, purpose: "reply" },
    });

    await app.close();
  });

  test("returns reply null when the handler suppresses the message", async () => {
    const app = buildApp({ handleInbound: async () => null });
    const res = await app.inject({ method: "POST", url: "/webhook/inbound", payload: VALID_BODY });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, reply: null });

    await app.close();
  });

  test("rejects a body with no phone", async () => {
    const app = buildApp({ handleInbound });
    const { phone: _phone, ...withoutPhone } = VALID_BODY;
    const res = await app.inject({ method: "POST", url: "/webhook/inbound", payload: withoutPhone });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/phone/);

    await app.close();
  });

  test("rejects an unknown kind", async () => {
    const app = buildApp({ handleInbound });
    const res = await app.inject({
      method: "POST",
      url: "/webhook/inbound",
      payload: { ...VALID_BODY, kind: "telepathy" },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  test("rejects a receivedAt that is not a date", async () => {
    const app = buildApp({ handleInbound });
    const res = await app.inject({
      method: "POST",
      url: "/webhook/inbound",
      payload: { ...VALID_BODY, receivedAt: "yesterday" },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  test("passes the parsed message through with a Date", async () => {
    const seen: InboundMessage[] = [];
    const app = buildApp({
      handleInbound: async (msg) => {
        seen.push(msg);
        return null;
      },
    });

    await app.inject({ method: "POST", url: "/webhook/inbound", payload: VALID_BODY });

    expect(seen[0]?.receivedAt).toBeInstanceOf(Date);
    expect(seen[0]?.providerMessageId).toBe("MSG-1");

    await app.close();
  });
});

describe('GET /ready',()=>{
  test('returns success only after the runtime reports readiness',async()=>{
    let ready=false;const app=buildApp({handleInbound,readiness:async()=>ready});
    try {
      expect((await app.inject('/ready')).statusCode).toBe(503);
      ready=true;const response=await app.inject('/ready');
      expect(response.statusCode).toBe(200);expect(response.json()).toEqual({ok:true});expect(response.headers['cache-control']).toBe('no-store');
    } finally {await app.close();}
  });
  test('missing and failed dependencies stay unavailable without leaking details',async()=>{
    for(const readiness of [undefined,async()=>{throw new Error('private DB URL');}]) {
      const app=buildApp({handleInbound,readiness});
      try {const response=await app.inject('/ready');expect(response.statusCode).toBe(503);expect(response.json()).toEqual({ok:false});}
      finally {await app.close();}
    }
  });
});
