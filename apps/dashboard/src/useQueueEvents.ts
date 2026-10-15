import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BASE, USE_MOCK } from "./api";
import { MockEventSource } from "./mock/mockEventSource";
import type { QueueRow } from "./types";

export type ConnectionStatus = "connecting" | "live" | "disconnected";

const EVENT_NAMES = ["session_created", "session_escalated", "queue_updated", "session_served"];

interface Stream {
  addEventListener(type: string, listener: (e: Event) => void): void;
  close(): void;
}

function openStream(): Stream {
  // TODO: konfirmasi URL dan apakah perlu kredensial/otentikasi.
  return USE_MOCK ? new MockEventSource() : (new EventSource(`${BASE}/api/events`) as Stream);
}

export function useQueueEvents() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [lastEventAt, setLastEventAt] = useState<Date | null>(null);
  const [families, setFamilies] = useState<Record<string, string>>({});

  useEffect(() => {
    const es = openStream();

    es.addEventListener("open", () => {
      setStatus("live");
      // Event yang terlewat saat putus tidak diulang server. Ambil ulang kebenarannya.
      qc.invalidateQueries({ queryKey: ["queue"] });
    });

    // EventSource asli menyambung ulang sendiri dan memicu "open" lagi.
    es.addEventListener("error", () => setStatus("disconnected"));

    const handle = (e: Event) => {
      const m = e as MessageEvent<string>;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(m.data);
      } catch {
        return; // abaikan data rusak
      }
      // Dukung dua gaya: event bernama (e.type) atau {type} di dalam JSON.
      const type = (payload.type as string | undefined) ?? (m.type !== "message" ? m.type : undefined);
      setLastEventAt(new Date());

      switch (type) {
        case "queue_updated":
          // Server adalah sumber urutan. Tulis apa adanya, jangan diurutkan ulang.
          if (Array.isArray(payload.rows)) qc.setQueryData<QueueRow[]>(["queue"], payload.rows as QueueRow[]);
          else qc.invalidateQueries({ queryKey: ["queue"] });
          break;
        case "session_served":
          if (typeof payload.sessionId === "string") {
            qc.setQueryData<QueueRow[]>(["queue"], (old) => old?.filter((r) => r.sessionId !== payload.sessionId));
          }
          break;
        case "session_escalated": {
          const id = payload.sessionId;
          const family = payload.family;
          if (typeof id === "string" && typeof family === "string") {
            setFamilies((prev) => ({ ...prev, [id]: family }));
          }
          // Event ini tidak membawa urutan lengkap. Ambil ulang dari server.
          qc.invalidateQueries({ queryKey: ["queue"] });
          break;
        }
        case "session_created":
          qc.invalidateQueries({ queryKey: ["queue"] });
          break;
      }
    };

    EVENT_NAMES.forEach((n) => es.addEventListener(n, handle));
    es.addEventListener("message", handle);

    return () => es.close();
  }, [qc]);

    return { status, lastEventAt, families };
}
