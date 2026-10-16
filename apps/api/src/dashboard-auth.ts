import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

const COOKIE = "qure_dashboard_session";
const SESSION_MS = 12 * 60 * 60 * 1000;
const LOGIN_SCHEMA = z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(200) }).strict();

export interface DashboardCredentials { username: string; password: string; secureCookie?: boolean; inboundWebhookToken: string }
interface Session { expiresAt: number }

function equalSecret(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

function cookieValue(request: FastifyRequest): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const pair of header.split(";")) {
    const [name, ...value] = pair.trim().split("=");
    if (name === COOKIE) return value.join("=") || null;
  }
  return null;
}

export function readDashboardCredentials(env: Record<string, string | undefined>): DashboardCredentials {
  const username = env.DASHBOARD_USERNAME?.trim();
  const password = env.DASHBOARD_PASSWORD;
  if (!username || !password) throw new Error("DASHBOARD_USERNAME and DASHBOARD_PASSWORD are required");
  if (password.length < 12 || password === "admin123") {
    throw new Error("DASHBOARD_PASSWORD must be at least 12 characters and must not be admin123");
  }
  const inboundWebhookToken = env.INBOUND_WEBHOOK_TOKEN?.trim();
  if (!inboundWebhookToken || inboundWebhookToken.length < 32) throw new Error("INBOUND_WEBHOOK_TOKEN is required and must be at least 32 characters");
  return { username, password, secureCookie: env.NODE_ENV === "production", inboundWebhookToken };
}

export function registerDashboardAuth(app: FastifyInstance, credentials: DashboardCredentials): void {
  const sessions = new Map<string, Session>();
  const failures = new Map<string, { count: number; since: number; blockedUntil: number }>();

  const getSession = (request: FastifyRequest): Session | null => {
    const id = cookieValue(request);
    if (!id) return null;
    const session = sessions.get(id);
    if (!session || session.expiresAt <= Date.now()) {
      sessions.delete(id);
      return null;
    }
    return session;
  };

  app.addHook("preHandler", async (request, reply) => {
    const path = request.url.split("?", 1)[0]!;
    if (!path.startsWith("/api/") || path.startsWith("/api/auth/")) return;
    if (!getSession(request)) return reply.code(401).header("Cache-Control", "no-store").send({ error: "Login required" });
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method) && request.headers["sec-fetch-site"] !== "same-origin") {
      return reply.code(403).send({ error: "Request origin rejected" });
    }
  });

  app.get("/api/auth/status", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { authenticated: !!getSession(request) };
  });

  app.post("/api/auth/login", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const forwardedFor = request.headers["x-forwarded-for"];
    const ip = typeof forwardedFor === "string" ? forwardedFor.split(",").at(-1)?.trim() || request.ip : request.ip;
    const now = Date.now();
    const state = failures.get(ip);
    if (state?.blockedUntil && state.blockedUntil > now) {
      return reply.code(429).header("Retry-After", String(Math.ceil((state.blockedUntil - now) / 1000))).send({ error: "Too many attempts. Try again later." });
    }

    const input = LOGIN_SCHEMA.safeParse(request.body);
    const valid = input.success && equalSecret(input.data.username, credentials.username) && equalSecret(input.data.password, credentials.password);
    if (!valid) {
      const active = state && now - state.since < 15 * 60 * 1000 ? state : { count: 0, since: now, blockedUntil: 0 };
      active.count += 1;
      if (active.count >= 5) active.blockedUntil = now + 15 * 60 * 1000;
      failures.set(ip, active);
      return reply.code(active.blockedUntil ? 429 : 401).send({ error: active.blockedUntil ? "Too many attempts. Try again later." : "Username or password is incorrect." });
    }

    failures.delete(ip);
    for (const [sessionId, session] of sessions) if (session.expiresAt <= now) sessions.delete(sessionId);
    const id = randomBytes(32).toString("base64url");
    sessions.set(id, { expiresAt: now + SESSION_MS });
    const secure = credentials.secureCookie ? "; Secure" : "";
    reply.header("Set-Cookie", `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${secure}`);
    return reply.send({ ok: true });
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const id = cookieValue(request);
    if (id) sessions.delete(id);
    const secure = credentials.secureCookie ? "; Secure" : "";
    reply.header("Cache-Control", "no-store").header("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
    return reply.send({ ok: true });
  });
}
