import { describe, expect, test } from "bun:test";
import { buildApp } from "./app";

describe("GET /health", () => {
  test("returns ok with service name", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, service: "qure-api" });

    await app.close();
  });
});
