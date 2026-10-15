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
      expect(response.json()).toEqual({ rows });
      expect(response.headers["cache-control"]).toBe("no-store");
    } finally { await app.close(); }
  });

  test("returns an empty board", async () => {
    const app = buildApp({ handleInbound: async () => null, readQueue: async () => [] });
    try { expect((await app.inject("/api/queue")).json()).toEqual({ rows: [] }); }
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
