import type { QueueRow, TriageTier } from "../types";

const tierRank: Record<TriageTier, number> = { P1: 1, P2: 2, P3: 3, P4: 4 };

// Hanya untuk mock: meniru server yang menghitung urutan. Di mode asli, JANGAN
// urutkan di klien, pakai urutan dari backend.
export function reorder(rows: QueueRow[]): QueueRow[] {
  return [...rows]
    .sort((a, b) => tierRank[a.tier] - tierRank[b.tier] || b.waitedMinutes - a.waitedMinutes)
    .map((r, i) => ({ ...r, position: i + 1 }));
}

let rows: QueueRow[] = reorder([
  { sessionId: "s-001", patientName: "Slamet Riyadi", tier: "P1", lane: "emergency", position: 1, etaMinutes: 0, waitedMinutes: 2, hasAllergies: true },
  { sessionId: "s-002", patientName: null, tier: "P2", lane: "priority", position: 2, etaMinutes: 5, waitedMinutes: 14, hasAllergies: false },
  { sessionId: "s-003", patientName: "Ratna Wulandari", tier: "P3", lane: "standard", position: 3, etaMinutes: null, waitedMinutes: 25, hasAllergies: false },
  { sessionId: "s-004", patientName: "Dewi Lestari", tier: "P3", lane: "standard", position: 4, etaMinutes: 32, waitedMinutes: 58, hasAllergies: true },
  { sessionId: "s-005", patientName: "Agus Santoso", tier: "P3", lane: "standard", position: 5, etaMinutes: 40, waitedMinutes: 21, hasAllergies: false },
  { sessionId: "s-006", patientName: "Bu Tini", tier: "P4", lane: "green", position: 6, etaMinutes: 55, waitedMinutes: 12, hasAllergies: false },
  { sessionId: "s-007", patientName: null, tier: "P4", lane: "green", position: 7, etaMinutes: null, waitedMinutes: 9, hasAllergies: false },
  { sessionId: "s-008", patientName: "Hendra Gunawan", tier: "P4", lane: "green", position: 8, etaMinutes: 70, waitedMinutes: 4, hasAllergies: false },
]);

export const mockState = {
  get: (): QueueRow[] => rows.map((r) => ({ ...r })),
  set: (next: QueueRow[]) => {
    rows = reorder(next);
  },
};
