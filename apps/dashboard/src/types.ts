// Disalin dari packages/core/src/contracts/events.ts.
// TODO: ganti dengan import dari package bersama setelah monorepo jadi.
// TODO: TriageTier dan QueueLane belum didefinisikan backend. Konfirmasi.
export type TriageTier = "P1" | "P2" | "P3" | "P4";
export type QueueLane = string;

export interface QueueRow {
  sessionId: string;
  patientName: string | null;
  tier: TriageTier;
  lane: QueueLane;
  position: number;
  etaMinutes: number | null;
  waitedMinutes: number;
  hasAllergies: boolean;
  callbackSlot?: string | null;
  etaReason?: string;
}

export type QueueEvent =
  | { type: "session_created"; session: QueueRow }
  | { type: "session_escalated"; sessionId: string; tier: "P1" | "P2"; family: string }
  | { type: "queue_updated"; rows: QueueRow[] }
  | { type: "session_served"; sessionId: string };

// TODO: bentuk tiga respons di bawah ini ASUMSI. Cocokkan dengan respons backend yang asli.
// GET /api/sessions/:id
export interface SessionDetail {
  sessionId: string;
  staffHandling?: boolean;
  startedAt: string; // ISO
  patient: { name: string | null; age: number | null };
  conditions: string[];
}

// GET /api/sessions/:id/triage (satu elemen = satu baris triage_results)
export interface TriageResult {
  id: string;
  tier: TriageTier;
  family: string | null;
  reason: string | null;
  createdAt: string; // ISO
}

// GET /api/sessions/:id/messages
export interface ChatMessage {
  id: string;
  role: string;
  content: string;
  createdAt: string; // ISO
}
