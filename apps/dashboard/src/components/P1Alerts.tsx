import type { QueueRow } from "../types";
import type { P1Alert } from "../useP1Alerts";
import { familyLabel } from "../format";

export function P1Alerts({
  alerts,
  rows,
  families,
  onDismiss,
}: {
  alerts: P1Alert[];
  rows: QueueRow[] | undefined;
  families: Record<string, string>;
  onDismiss: (sessionId: string) => void;
}) {
  if (alerts.length === 0) return null;

  return (
    <div role="alert" aria-live="assertive" className="space-y-2">
      {alerts.map((a) => {
        const row = rows?.find((r) => r.sessionId === a.sessionId);
        const kind = familyLabel(families[a.sessionId]);
        const detail = [
          row ? `Posisi ${row.position}` : null,
          kind,
          `terdeteksi ${a.at.toLocaleTimeString("id-ID")}`,
        ]
          .filter(Boolean)
          .join(" · ");

        return (
          <div
            key={a.sessionId}
            className="flex items-center gap-3 rounded-lg border-4 border-red-900 bg-red-700 p-4 text-white shadow-lg"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold uppercase tracking-wide">⚠ Pasien darurat (P1)</p>
              <p className="truncate text-xl font-bold">{row?.patientName ?? "Tanpa nama"}</p>
              <p className="text-sm">{detail}</p>
            </div>
            <button
              onClick={() => onDismiss(a.sessionId)}
              className="min-h-11 shrink-0 rounded bg-white px-4 py-2 font-bold text-red-900"
            >
              Mengerti
            </button>
          </div>
        );
      })}
    </div>
  );
}