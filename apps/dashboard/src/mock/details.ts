import type { ChatMessage, QueueRow, SessionDetail, TriageResult } from "../types";
import { mockState } from "./queue";

// Data contoh untuk panel detail. Dibuat dari baris antrean yang ada di mock.
let failNextMessages = false;
export const detailSim = {
  failNextMessages: () => {
    failNextMessages = true;
  },
};

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const AGES: Record<string, number> = { "s-001": 61, "s-004": 47 };
const CONDITIONS: Record<string, string[]> = {
  "s-001": ["Hipertensi", "Alergi penisilin"],
  "s-004": ["Diabetes melitus tipe 2", "Alergi sulfa"],
};

function rowOf(id: string): QueueRow {
  const row = mockState.get().find((r) => r.sessionId === id);
  if (!row) throw new Error("HTTP 404");
  return row;
}

export function mockSession(id: string): SessionDetail {
  const row = rowOf(id);
  return {
    sessionId: id,
    startedAt: ago(row.waitedMinutes + 3),
    patient: { name: row.patientName, age: AGES[id] ?? null },
    conditions: CONDITIONS[id] ?? (row.hasAllergies ? ["Alergi (rincian belum dicatat)"] : []),
  };
}

export function mockTriage(id: string): TriageResult[] {
  const row = rowOf(id);
  const first: TriageResult = {
    id: `${id}-t1`,
    tier: row.tier === "P1" ? "P3" : row.tier,
    family: null,
    reason: "Penilaian awal dari keluhan yang disampaikan pasien.",
    createdAt: ago(row.waitedMinutes + 2),
  };
  if (row.tier !== "P1") return [first];
  return [
    first,
    {
      id: `${id}-t2`,
      tier: "P1",
      family: "cardiac",
      reason: "Pasien menyebut nyeri dada yang menjalar ke lengan kiri.",
      createdAt: ago(1),
    },
  ];
}

export function mockMessages(id: string): ChatMessage[] {
  if (failNextMessages) {
    failNextMessages = false;
    throw new Error("HTTP 500, simulasi");
  }
  const row = rowOf(id);
  const t = row.waitedMinutes + 2;
  const msgs: ChatMessage[] = [
    { id: `${id}-m1`, role: "assistant", content: "Selamat datang. Apa keluhan utama Anda hari ini?", createdAt: ago(t) },
    { id: `${id}-m2`, role: "patient", content: "Saya merasa tidak enak badan sejak pagi.", createdAt: ago(t - 1) },
    { id: `${id}-m3`, role: "assistant", content: "Baik. Apakah ada demam, nyeri, atau sesak?", createdAt: ago(t - 1) },
  ];
  if (row.tier === "P1") {
    msgs.push({
      id: `${id}-m4`,
      role: "patient",
      content: "Dada saya sakit sekali, rasanya menjalar ke lengan kiri.",
      createdAt: ago(1),
    });
  }
  return msgs;
}