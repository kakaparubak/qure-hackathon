import type { ConnectionStatus as Status } from "../useQueueEvents";
import { formatAgo } from "../format";

const label: Record<Status, string> = {
  connecting: "Menyambung…",
  live: "Terhubung langsung",
  disconnected: "Terputus",
};

const dot: Record<Status, string> = {
  connecting: "bg-yellow-500",
  live: "bg-green-700",
  disconnected: "bg-red-700",
};

export function ConnectionStatus({
  status,
  lastUpdatedAt,
  now,
}: {
  status: Status;
  lastUpdatedAt: Date | null;
  now: number;
}) {
  return (
    <div className="space-y-2">
      <p role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span aria-hidden className={`inline-block size-3 rounded-full ${dot[status]}`} />
        <span className="font-semibold">{label[status]}</span>
        <span className="text-muted">
          · Diperbarui{" "}
          {lastUpdatedAt
            ? `${lastUpdatedAt.toLocaleTimeString("id-ID")} (${formatAgo(lastUpdatedAt, now)})`
            : "belum ada"}
        </span>
      </p>
      {status === "disconnected" && (
        <p role="alert" className="rounded border border-red-700 bg-red-50 px-3 py-2 text-sm font-semibold text-red-900">
          Koneksi terputus. Antrean mungkin sudah usang. Sistem mencoba menyambung ulang.
        </p>
      )}
    </div>
  );
}