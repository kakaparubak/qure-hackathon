import type { ChatMessage, QueueRow, SessionDetail, TriageResult } from "./types";
import { mockState } from "./mock/queue";
import { mockServe } from "./mock/mockEventSource";
import { mockMessages, mockSession, mockTriage } from "./mock/details";

export const USE_MOCK = import.meta.env.VITE_USE_MOCK !== "false";
export const BASE = import.meta.env.VITE_API_URL ?? "";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} gagal: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

// TODO: konfirmasi bentuk respons GET /api/queue. Di sini diasumsikan array QueueRow[].
export async function getQueue(): Promise<QueueRow[]> {
  if (USE_MOCK) {
    await new Promise((r) => setTimeout(r, 300)); // simulasi jaringan
    return mockState.get();
  }
  return get<QueueRow[]>("/api/queue");
}

// Backend contract (confirmed): 204 on served or already-finished elsewhere -
// an already-served patient reads as done, not as an error to resurrect.
export async function serveSession(sessionId: string): Promise<void> {
  if (USE_MOCK) {
    await new Promise((r) => setTimeout(r, 400)); // simulasi jaringan
    mockServe(sessionId);
    return;
  }
  const res = await fetch(`${BASE}/api/sessions/${encodeURIComponent(sessionId)}/serve`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// Kirim pesan perawat ke pasien lewat WhatsApp. Tersimpan di transkrip yang sama dengan bot.
export async function sendNurseMessage(sessionId: string, body: string): Promise<void> {
  if (USE_MOCK) {
    await new Promise((r) => setTimeout(r, 300));
    return;
  }
  const res = await fetch(`${BASE}/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body }),
  });
  if (res.status === 404) throw new Error("Sesi tidak ditemukan.");
  if (res.status === 503) throw new Error("Pesan gagal terkirim. Coba lagi.");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sessionPath = (id: string) => `/api/sessions/${encodeURIComponent(id)}`;

export async function getSession(id: string): Promise<SessionDetail> {
  if (USE_MOCK) {
    await delay(300);
    return mockSession(id);
  }
  return get<SessionDetail>(sessionPath(id));
}

export async function getTriage(id: string): Promise<TriageResult[]> {
  if (USE_MOCK) {
    await delay(400);
    return mockTriage(id);
  }
  return get<TriageResult[]>(`${sessionPath(id)}/triage`);
}

export async function getMessages(id: string): Promise<ChatMessage[]> {
  if (USE_MOCK) {
    await delay(500);
    return mockMessages(id);
  }
  return get<ChatMessage[]>(`${sessionPath(id)}/messages`);
}
export async function getFhirExport(id:string):Promise<Blob> {
  if(USE_MOCK) throw new Error('Ekspor FHIR tersedia saat tersambung ke data pasien.');
  const res=await fetch(`${BASE}${sessionPath(id)}/fhir`);
  if(res.status === 404) throw new Error('Sesi tidak ditemukan.');
  if(!res.ok) throw new Error('Ekspor FHIR belum tersedia. Coba lagi.');
  return res.blob();
}
