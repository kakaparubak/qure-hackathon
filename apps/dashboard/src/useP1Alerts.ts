import { useCallback, useEffect, useRef, useState } from "react";
import type { QueueRow } from "./types";

export interface P1Alert {
  sessionId: string;
  at: Date;
}

// Memunculkan alert untuk baris P1 yang BARU muncul di antrean.
// P1 yang sudah ada saat data pertama dimuat tidak dihitung (sudah terlihat merah di daftar).
export function useP1Alerts(rows: QueueRow[] | undefined) {
  const seen = useRef<Set<string> | null>(null);
  const [alerts, setAlerts] = useState<P1Alert[]>([]);

  useEffect(() => {
    if (!rows) return;
    const p1 = rows.filter((r) => r.tier === "P1").map((r) => r.sessionId);

    if (seen.current === null) {
      seen.current = new Set(p1);
      return;
    }

    const known = seen.current;
    const fresh = p1.filter((id) => !known.has(id));
    fresh.forEach((id) => known.add(id));

    setAlerts((prev) => {
      // Buang alert untuk pasien yang sudah tidak P1 / sudah dilayani.
      const remaining = prev.filter((a) => p1.includes(a.sessionId));
      if (fresh.length === 0 && remaining.length === prev.length) return prev;
      return [...remaining, ...fresh.map((sessionId) => ({ sessionId, at: new Date() }))];
    });
  }, [rows]);

  const dismiss = useCallback(
    (sessionId: string) => setAlerts((prev) => prev.filter((a) => a.sessionId !== sessionId)),
    [],
  );

  return { alerts, dismiss };
}