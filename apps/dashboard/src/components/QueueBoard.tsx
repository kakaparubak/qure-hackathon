import { useEffect, useRef, useState } from "react";
import { useQueue } from "../useQueue";
import { formatEta, isLongWait, laneLabel } from "../format";
import type { QueueRow } from "../types";
import { TierBadge } from "./TierBadge";

function ClockIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

const btnBase = "min-h-11 rounded px-3 py-2 text-sm";

function QueueItem({
  row,
  onServe,
  onOpen,
  restoreFocus,
}: {
  row: QueueRow;
  onServe: (row: QueueRow) => void;
  onOpen: (sessionId: string) => void;
  restoreFocus: boolean;
}) {
  const isP1 = row.tier === "P1";
  const long = isLongWait(row.waitedMinutes);
  const lane = laneLabel(row.lane);
  const name = row.patientName ?? "pasien tanpa nama";
  const [confirming, setConfirming] = useState(false);
  const openRef = useRef<HTMLButtonElement>(null);

  // Kembali dari halaman detail: fokus ke baris yang tadi dibuka.
  useEffect(() => {
    if (restoreFocus) openRef.current?.focus();
  }, []);

  // Konfirmasi menutup sendiri setelah 6 detik supaya tidak tertinggal terbuka.
  useEffect(() => {
    if (!confirming) return;
    const id = setTimeout(() => setConfirming(false), 6000);
    return () => clearTimeout(id);
  }, [confirming]);

  return (
    <li
      className={`relative grid grid-cols-[2.5rem_3.5rem_1fr_auto] items-center gap-3 border-b border-line px-4 py-3 ${
        isP1 ? "border-l-8 border-l-red-700 bg-red-50" : "border-l-8 border-l-transparent bg-white"
      }`}
    >
      <span className="text-lg font-semibold tabular-nums text-muted">{row.position}</span>
      <TierBadge tier={row.tier} />
      <div className="min-w-0">
        <p className="truncate text-base font-semibold">
          {/* after:* membuat seluruh baris bisa ditekan, tapi tombol tetap satu (mudah dijangkau keyboard). */}
          <button
            ref={openRef}
            onClick={() => onOpen(row.sessionId)}
            aria-label={`Buka detail ${name}`}
            className="text-left hover:underline after:absolute after:inset-0"
          >
            {row.patientName ?? <span className="font-normal italic text-muted">Tanpa nama</span>}
          </button>
        </p>
        <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-muted">
          <span className={long ? "inline-flex items-center gap-1 font-bold text-ink" : undefined}>
            {long && <ClockIcon />}
            Menunggu {row.waitedMinutes} mnt
            {long && <span className="sr-only"> (lama)</span>}
          </span>
          <span aria-hidden>·</span>
          <span className={isP1 ? "font-bold text-red-900" : undefined}>{formatEta(row.tier, row.etaMinutes)}</span>
          {lane && (
            <>
              <span aria-hidden>·</span>
              <span>{lane}</span>
            </>
          )}
        </p>
      </div>
      <div className="relative z-[1] flex items-center gap-2">
        {row.hasAllergies && (
          <span className="rounded border border-amber-700 bg-amber-100 px-2 py-1 text-sm font-semibold text-amber-950">
            ⚠ Alergi
          </span>
        )}
        {!confirming && (
          <button
            onClick={() => setConfirming(true)}
            className={`${btnBase} border border-line bg-white font-semibold hover:bg-slate-100`}
          >
            Layani
          </button>
        )}
      </div>

      {confirming && (
        <div
          role="group"
          aria-label={`Konfirmasi melayani ${name}`}
          className="relative z-[1] col-span-full flex flex-wrap items-center gap-2"
        >
          <span className="mr-auto text-sm font-semibold">
            Layani {name} (no. {row.position})?
          </span>
          <button
            onClick={() => {
              setConfirming(false);
              onServe(row);
            }}
            className={`${btnBase} bg-ink font-bold text-white`}
          >
            Ya, layani
          </button>
          <button
            onClick={() => setConfirming(false)}
            className={`${btnBase} border border-line bg-white font-semibold hover:bg-slate-100`}
          >
            Batal
          </button>
        </div>
      )}
    </li>
  );
}

export function QueueBoard({
  polling = false,
  onServe,
  onOpen,
  restoreFocusId = null,
}: {
  polling?: boolean;
  onServe: (row: QueueRow) => void;
  onOpen: (sessionId: string) => void;
  restoreFocusId?: string | null;
}) {
  const { data, isPending, isError, error, refetch } = useQueue(polling);

  if (isPending) return <p className="p-6 text-muted">Memuat antrean…</p>;

  // Kalau pengambilan ulang gagal tapi data lama masih ada, tetap tampilkan data lama.
  if (isError && !data)
    return (
      <div className="p-6" role="alert">
        <p className="font-semibold">Antrean tidak bisa dimuat.</p>
        <p className="text-sm text-muted">{error?.message}</p>
        <button onClick={() => refetch()} className="mt-3 rounded bg-ink px-4 py-2 text-white">
          Coba lagi
        </button>
      </div>
    );

  if (!data || data.length === 0)
    return <p className="p-6 text-muted">Belum ada pasien dalam antrean.</p>;

  return (
    <ol className="overflow-hidden rounded-lg border border-line">
      {data.map((row) => (
        <QueueItem
          key={row.sessionId}
          row={row}
          onServe={onServe}
          onOpen={onOpen}
          restoreFocus={row.sessionId === restoreFocusId}
        />
      ))}
    </ol>
  );
}