import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApp } from "./app";

const rows = [{ sessionId: "synthetic-session", patientName: null, tier: "P1" as const,
  lane: "priority" as const, position: 1, etaMinutes: null, waitedMinutes: 3,
  hasAllergies: true, ticketNumber: 7, ticketDate: "2026-10-15" }];

describe("GET /api/queue", () => {
  test("returns the reader's ordered ticket rows without caching", async () => {
    const app = buildApp({ handleInbound: async () => null, readQueue: async () => rows });
    try {
      const response = await app.inject("/api/queue");
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(rows);
      expect(response.headers["cache-control"]).toBe("no-store");
    } finally { await app.close(); }
  });

  test("returns an empty board", async () => {
    const app = buildApp({ handleInbound: async () => null, readQueue: async () => [] });
    try { expect((await app.inject("/api/queue")).json()).toEqual([]); }
    finally { await app.close(); }
  });

  test("hides database failures behind a generic 503", async () => {
    const app = buildApp({ handleInbound: async () => null, readQueue: async () => {
      throw new Error("postgres secret://credentials select * from patients");
    } });
    try {
      const response = await app.inject("/api/queue");
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: "Queue is temporarily unavailable" });
      expect(response.body).not.toMatch(/postgres|credentials|patients/);
    } finally { await app.close(); }
  });

  test("keeps existing app construction working without a queue reader", async () => {
    const app = buildApp({ handleInbound: async () => null });
    try { expect((await app.inject("/api/queue")).statusCode).toBe(503); }
    finally { await app.close(); }
  });
});

test("serves a built dashboard and assets on the API origin", async () => {
  const root = await mkdtemp(join(tmpdir(), "qure-dashboard-"));
  await writeFile(join(root, "index.html"), '<!doctype html><title>Synthetic dashboard</title>');
  await writeFile(join(root, "app.js"), 'console.log("synthetic");');
  const app = buildApp({ handleInbound: async () => null, dashboardRoot: root });
  try {
    expect((await app.inject("/dashboard/")).body).toContain("Synthetic dashboard");
    expect((await app.inject("/dashboard/app.js")).statusCode).toBe(200);
    expect((await app.inject("/health")).statusCode).toBe(200);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test("works in source checkouts without dashboard assets", async () => {
  const app = buildApp({ handleInbound: async () => null, dashboardRoot: "/tmp/qure-dashboard-does-not-exist" });
  try {
    expect((await app.inject("/health")).statusCode).toBe(200);
    expect((await app.inject("/dashboard/")).statusCode).toBe(503);
  } finally { await app.close(); }
});

describe("nurse session endpoints", () => {
  const sessionId = "0b8f6c1e-1111-4222-8333-444455556666";

  const readers = {
    sendMessage: async () => {},
    serve: async (id: string) => (id === sessionId ? "served" : "missing"),
    detail: async (id: string) => (id === sessionId ? { sessionId: id, patient: { name: "Sari", age: 40 }, conditions: [] } : null),
    triage: async (id: string) => (id === sessionId ? [] : null),
    messages: async (id: string) => (id === sessionId ? [] : null),
  };

  test("POST serve returns 204 and 404 for an unknown session", async () => {
    const app = buildApp({ handleInbound: async () => null, sessions: readers });
    try {
      expect((await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/serve` })).statusCode).toBe(204);
      const missing = await app.inject({ method: "POST", url: `/api/sessions/0b8f6c1e-1111-4222-8333-444455556667/serve` });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error).toBe("Session not found");
    } finally { await app.close(); }
  });

  test("malformed session ids are 404 before any database call", async () => {
    const seen: string[] = [];
    const app = buildApp({
      handleInbound: async () => null,
      sessions: { ...readers, serve: async (id) => { seen.push(id); return "missing"; } },
    });
    try {
      expect((await app.inject({ method: "POST", url: "/api/sessions/not-a-uuid/serve" })).statusCode).toBe(404);
      expect((await app.inject({ url: "/api/sessions/; DROP TABLE patients/detail" })).statusCode).toBe(404);
      expect(seen).toEqual([]);
    } finally { await app.close(); }
  });

  test("detail, triage and messages return the reader payload", async () => {
    const app = buildApp({ handleInbound: async () => null, sessions: readers });
    try {
      const detail = await app.inject(`/api/sessions/${sessionId}`);
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toEqual({ sessionId, patient: { name: "Sari", age: 40 }, conditions: [] });
      expect((await app.inject(`/api/sessions/${sessionId}/triage`)).json()).toEqual([]);
      expect((await app.inject(`/api/sessions/${sessionId}/messages`)).json()).toEqual([]);
    } finally { await app.close(); }
  });

  test("endpoint failures are a generic 503 with no internals", async () => {
    const app = buildApp({
      handleInbound: async () => null,
      sessions: { ...readers, detail: async () => { throw new Error("postgres secret://credentials"); } },
    });
    try {
      const res = await app.inject(`/api/sessions/${sessionId}`);
      expect(res.statusCode).toBe(503);
      expect(res.body).not.toMatch(/postgres|secret/);
    } finally { await app.close(); }
  });
});

test("GET /api/events streams queue_updated frames", async () => {
  const rows = [{ sessionId: "s", patientName: null, tier: "P1" as const, lane: "priority" as const,
    position: 1, etaMinutes: null, waitedMinutes: 0, hasAllergies: false, ticketNumber: 1, ticketDate: "2026-10-15" }];
  const app = buildApp({ handleInbound: async () => null, readQueue: async () => rows });
  try {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const base = `http://127.0.0.1:${(app.server?.address() as { port: number }).port}`;
    const controller = new AbortController();
    const response = await fetch(`${base}/api/events`, { signal: controller.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    const frame = new TextDecoder().decode(value);
    expect(frame).toContain("event: queue_updated");
    expect(frame).toContain('"ticketNumber":1');
    controller.abort();
  } finally { await app.close(); }
});

describe("POST /api/sessions/:id/messages - nurse chat room", () => {
  const sessionId = "0b8f6c1e-1111-4222-8333-444455556666";
  const readers = {
    sendMessage: async (_id: string, body: string) => {
      if (body === "transport down") throw new Error("websocket gone");
    },
    serve: async (): Promise<"served" | "already_finished" | "missing"> => "served",
    detail: async () => ({}),
    triage: async () => [],
    messages: async () => [],
  };

  test("a typed nurse message is delivered and answers 201", async () => {
    const sent: Array<{ id: string; body: string }> = [];
    const app = buildApp({
      handleInbound: async () => null,
      sessions: { ...readers, sendMessage: async (id, body) => { sent.push({ id, body }); } },
    });
    try {
      const res = await app.inject({
        method: "POST", url: `/api/sessions/${sessionId}/messages`, payload: { body: "Saya perawat Dewi. Bisa cerita lebih detail keluhannya?" },
      });
      expect(res.statusCode).toBe(201);
      expect(sent).toEqual([{ id: sessionId, body: "Saya perawat Dewi. Bisa cerita lebih detail keluhannya?" }]);
    } finally { await app.close(); }
  });

  test("transport failure is a 503 and persists nothing", async () => {
    const app = buildApp({ handleInbound: async () => null, sessions: readers });
    try {
      const res = await app.inject({
        method: "POST", url: `/api/sessions/${sessionId}/messages`, payload: { body: "transport down" },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("Message could not be delivered");
    } finally { await app.close(); }
  });

  test("empty and oversized bodies are 400 before any send", async () => {
    const app = buildApp({ handleInbound: async () => null, sessions: readers });
    try {
      expect((await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/messages`, payload: { body: "   " } })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/messages`, payload: { body: "x".repeat(1001) } })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/messages`, payload: {} })).statusCode).toBe(400);
    } finally { await app.close(); }
  });
});

test('shutdown closes an active SSE stream so the container can stop gracefully',async()=>{
  const app=buildApp({handleInbound:async()=>null,readQueue:async()=>rows});
  await app.listen({host:'127.0.0.1',port:0});
  const address=app.server.address();if(!address || typeof address==='string')throw new Error('Missing test port');
  const response=await fetch(`http://127.0.0.1:${address.port}/api/events`);
  const reader=response.body!.getReader();await reader.read();
  let forced=false;
  const timeout=setTimeout(()=>{forced=true;void reader.cancel();},1500);
  try {await app.close();} finally {clearTimeout(timeout);await reader.cancel().catch(()=>{});}
  expect(app.server.listening).toBe(false);
  expect(forced).toBe(false);
});
