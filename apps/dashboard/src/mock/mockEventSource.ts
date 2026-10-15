import type { QueueEvent, QueueRow } from "../types";
import { mockState } from "./queue";

// Meniru EventSource: open, error, dan event bernama. Dipakai selama backend belum ada.
let active: MockEventSource | null = null;
let counter = 100;
let shouldFailServe = false;
const names = ["Joko Widodo", "Siti Aminah", "Budi Hartono", null, "Maria Ulfa", null];

export class MockEventSource extends EventTarget {
  readyState = 0; // 0 connecting, 1 open, 2 closed (sama seperti EventSource asli)
  private timer: ReturnType<typeof setTimeout>;

  constructor(_url?: string) {
    super();
    active = this;
    this.timer = setTimeout(() => this.open(), 600);
  }

  private open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  close() {
    clearTimeout(this.timer);
    this.readyState = 2;
    if (active === this) active = null;
  }

  // Event hanya terkirim saat terhubung. Saat putus, event HILANG (seperti aslinya).
  emit(event: QueueEvent) {
    if (this.readyState !== 1) return;
    this.dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify(event) }));
  }

  drop() {
    this.readyState = 0;
    this.dispatchEvent(new Event("error"));
  }

  reconnect() {
    this.open();
  }
}

// ---- Tombol simulasi (dipakai DevPanel) ----
function broadcastQueue() {
  active?.emit({ type: "queue_updated", rows: mockState.get() });
}

// Dipanggil oleh api.serveSession di mode mock. Meniru server: ubah data, lalu kirim event.
export function mockServe(sessionId: string) {
  if (shouldFailServe) {
    shouldFailServe = false;
    throw new Error("HTTP 500, simulasi");
  }
  mockState.set(mockState.get().filter((r) => r.sessionId !== sessionId));
  active?.emit({ type: "session_served", sessionId });
  broadcastQueue();
}

export const simulate = {
  newPatient() {
    const row: QueueRow = {
      sessionId: `s-${++counter}`,
      patientName: names[counter % names.length],
      tier: "P3", lane: "standard", position: 0,
      etaMinutes: 45, waitedMinutes: 0, hasAllergies: counter % 3 === 0,
    };
    mockState.set([...mockState.get(), row]);
    const saved = mockState.get().find((r) => r.sessionId === row.sessionId)!;
    active?.emit({ type: "session_created", session: saved });
    broadcastQueue();
  },
  escalate() {
    const rows = mockState.get();
    const target = [...rows].reverse().find((r) => r.tier !== "P1");
    if (!target) return;
    mockState.set(rows.map((r) => (r.sessionId === target.sessionId ? { ...r, tier: "P1", lane: "emergency", etaMinutes: 0 } : r)));
    active?.emit({ type: "session_escalated", sessionId: target.sessionId, tier: "P1", family: "cardiac" });
    broadcastQueue();
  },
  serveTop() {
    const rows = mockState.get();
    if (rows.length === 0) return;
    mockState.set(rows.slice(1));
    active?.emit({ type: "session_served", sessionId: rows[0].sessionId });
    broadcastQueue();
  },
  failNextServe: () => { shouldFailServe = true; },
  drop: () => active?.drop(),
  reconnect: () => active?.reconnect(),
};
