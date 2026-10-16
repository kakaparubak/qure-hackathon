import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { sendNurseMessage, serveSession } from "../api";
import { useSessionDetail } from "../useSessionDetail";
import { familyLabel, formatAgo, formatClock, formatEta, roleLabel } from "../format";
import type { ChatMessage, QueueRow } from "../types";
import { FhirDownloadButton } from './FhirDownloadButton';
import { TierBadge } from "./TierBadge";

function Section<T>({
  title,
  query,
  children,
}: {
  title: string;
  query: UseQueryResult<T>;
  children: (data: T) => ReactNode;
}) {
  return (
    <section className="rounded-lg border border-line bg-white p-4">
      <h3 className="mb-2 text-lg font-bold">{title}</h3>
      {query.isPending ? (
        <p className="text-muted">Memuat…</p>
      ) : query.data === undefined ? (
        <div role="alert">
          <p className="font-semibold">Tidak bisa dimuat.</p>
          <p className="text-sm text-muted">{query.error?.message}</p>
          <button onClick={() => void query.refetch()} className="mt-2 min-h-11 rounded bg-ink px-4 py-2 text-white">
            Coba lagi
          </button>
        </div>
      ) : (
        <>
          {query.isError && (
            <p role="alert" className="mb-2 text-sm font-semibold text-red-900">
              Pembaruan gagal. Data di bawah mungkin usang.
            </p>
          )}
          {children(query.data)}
        </>
      )}
    </section>
  );
}

function Composer({ sessionId, onSent }: { sessionId: string; onSent: () => void }) {
  const [draft, setDraft] = useState("");
  const send = useMutation({
    mutationFn: () => sendNurseMessage(sessionId, draft.trim()),
    onSuccess: () => {
      setDraft("");
      onSent();
    },
  });

  return (
    <form
      className="mt-3 flex items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (draft.trim()) send.mutate();
      }}
    >
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (draft.trim()) send.mutate();
          }
        }}
        rows={2}
        maxLength={1000}
        placeholder="Tulis pesan ke pasien… (terkirim lewat WhatsApp)"
        className="min-h-11 flex-1 rounded border border-line px-3 py-2 text-sm"
      />
      <button
        type="submit"
        disabled={!draft.trim() || send.isPending}
        className="min-h-11 rounded bg-ink px-4 py-2 text-sm font-bold text-white disabled:opacity-40"
      >
        {send.isPending ? "Mengirim…" : "Kirim"}
      </button>
      {send.isError && (
        <p role="alert" className="text-sm font-semibold text-red-900">
          {send.error instanceof Error ? send.error.message : "Gagal mengirim."}
        </p>
      )}
    </form>
  );
}

function FinishButton({ sessionId, onDone }: { sessionId: string; onDone: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const qc = useQueryClient();
  const finish = useMutation({
    mutationFn: () => serveSession(sessionId),
    // Selesai = pasien keluar antrean; segarkan papan di belakangnya.
    onSettled: () => void qc.invalidateQueries({ queryKey: ["queue"] }),
    onSuccess: onDone,
  });

  if (!confirming)
    return (
      <button
        onClick={() => setConfirming(true)}
        className="min-h-11 rounded border border-line bg-white px-3 py-2 text-sm font-semibold hover:bg-slate-100"
      >
        Tandai selesai dilayani
      </button>
    );

  return (
    <span role="group" aria-label="Konfirmasi selesai" className="inline-flex items-center gap-2">
      <span className="text-sm font-semibold">Tutup sesi ini?</span>
      <button
        onClick={() => finish.mutate()}
        className="min-h-11 rounded bg-ink px-3 py-2 text-sm font-bold text-white"
      >
        {finish.isPending ? "Menyimpan…" : "Ya, selesai"}
      </button>
      <button
        onClick={() => setConfirming(false)}
        className="min-h-11 rounded border border-line bg-white px-3 py-2 text-sm font-semibold"
      >
        Batal
      </button>
      {finish.isError && (
        <p role="alert" className="text-sm font-semibold text-red-900">Gagal. Coba lagi.</p>
      )}
    </span>
  );
}

function Transcript({ messages }: { messages: ChatMessage[] }) {
  const ref = useRef<HTMLOListElement>(null);

  // Pesan terbaru ada di bawah: gulir ke sana saat data masuk.
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  if (messages.length === 0) return <p className="text-muted">Belum ada pesan.</p>;

  return (
    <ol ref={ref} tabIndex={0} aria-label="Transkrip percakapan" className="max-h-[50vh] space-y-3 overflow-y-auto rounded-xl bg-slate-50 p-3 sm:p-4">
      {messages.map((m) => {
        const staff = m.role === "nurse";
        const assistant = m.role === "bot" || m.role === "assistant";
        const system = m.role === "system";
        const bubble = staff
          ? "rounded-tr-sm border-teal-200 bg-teal-100 text-teal-950"
          : assistant
            ? "rounded-tl-sm border-indigo-200 bg-indigo-50 text-indigo-950"
            : system
              ? "border-slate-200 bg-slate-100 text-slate-700"
              : "rounded-tl-sm border-slate-200 bg-white text-slate-900";
        const label = staff ? "text-teal-800" : assistant ? "text-indigo-700" : "text-slate-600";

        return (
          <li key={m.id} className={`flex ${staff ? "justify-end" : system ? "justify-center" : "justify-start"}`}>
            <div className={`min-w-0 max-w-[90%] rounded-2xl border px-3 py-2.5 shadow-sm sm:max-w-[80%] sm:px-4 ${bubble}`}>
              <p className={`mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs ${label}`}>
                <span className="font-bold">{roleLabel(m.role)}</span>
                <time dateTime={m.createdAt} className="ml-auto tabular-nums">{formatClock(m.createdAt)}</time>
              </p>
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed sm:text-base">{m.content}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function SessionDetailView({
  sessionId,
  queueRow,
  queueLoaded,
  now,
  onBack,
}: {
  sessionId: string;
  queueRow: QueueRow | undefined;
  queueLoaded: boolean;
  now: number;
  onBack: () => void;
}) {
  const qc = useQueryClient();
  const { session, triage, messages } = useSessionDetail(sessionId);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    window.scrollTo(0, 0);
    headingRef.current?.focus();
  }, []);

  const name = session.data?.patient?.name ?? queueRow?.patientName ?? null;

  // Pakai yang paling lama dimuat, supaya tidak terlihat lebih segar dari kenyataan.
  const times = [session.dataUpdatedAt, triage.dataUpdatedAt, messages.dataUpdatedAt].filter((t) => t > 0);
  const loadedAt = times.length ? new Date(Math.min(...times)) : null;

  const reload = () => {
    void session.refetch();
    void triage.refetch();
    void messages.refetch();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          onClick={onBack}
          className="min-h-11 rounded border border-line bg-white px-3 py-2 text-sm font-semibold hover:bg-slate-100"
        >
          ← Kembali ke antrean
        </button>
        <FhirDownloadButton sessionId={sessionId} />
      </div>

      {queueLoaded && !queueRow && (
        <p role="status" className="rounded border border-amber-700 bg-amber-100 px-3 py-2 text-sm font-semibold text-amber-950">
          Pasien ini sudah tidak ada di antrean (kemungkinan sudah dilayani). Yang tampil adalah catatan terakhir.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {queueRow && <TierBadge tier={queueRow.tier} />}
        <h2 ref={headingRef} tabIndex={-1} className="text-2xl font-bold">
          {name ?? "Pasien tanpa nama"}
        </h2>
        {queueRow?.hasAllergies && (
          <span className="rounded border border-amber-700 bg-amber-100 px-2 py-1 text-sm font-semibold text-amber-950">
            ⚠ Alergi
          </span>
        )}
      </div>

      {queueRow && (
        <p className="text-sm text-muted">
          Posisi {queueRow.position} · Menunggu {queueRow.waitedMinutes} mnt ·{" "}
          {formatEta(queueRow.tier, queueRow.etaMinutes)}
          {queueRow.callbackSlot && ` · Panggilan balik ${new Date(queueRow.callbackSlot).toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})} WIB`}
        </p>
      )}

      <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
        {loadedAt ? `Dimuat ${loadedAt.toLocaleTimeString("id-ID")} (${formatAgo(loadedAt, now)})` : "Memuat…"}
        <button
          onClick={reload}
          className="min-h-11 rounded border border-line bg-white px-3 py-2 font-semibold text-ink hover:bg-slate-100"
        >
          Muat ulang
        </button>
      </p>

      <Section title="Data pasien" query={session}>
        {(s) => {
          const conditions = s.conditions ?? [];
          return (
            <dl className="space-y-1 text-sm">
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-muted">Umur</dt>
                <dd>{s.patient?.age != null ? `${s.patient.age} tahun` : "Belum dicatat"}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-muted">Sesi mulai</dt>
                <dd>{formatClock(s.startedAt)}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-muted">Kondisi</dt>
                <dd>
                  {conditions.length === 0 ? (
                    "Tidak ada kondisi tercatat"
                  ) : (
                    <ul className="list-inside list-disc">
                      {conditions.map((c) => (
                        <li key={c}>{c}</li>
                      ))}
                    </ul>
                  )}
                </dd>
              </div>
            </dl>
          );
        }}
      </Section>

      <Section title="Hasil triase" query={triage}>
        {(rows) => {
          if (rows.length === 0) return <p className="text-muted">Belum ada hasil triase.</p>;
          const newestFirst = [...rows].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
          return (
            <>
              <p className="mb-2 text-sm text-muted">Terbaru di atas. Baris pertama adalah penilaian saat ini.</p>
              <ol className="space-y-3">
                {newestFirst.map((r) => {
                  const kind = familyLabel(r.family ?? undefined);
                  return (
                    <li key={r.id} className="flex gap-3">
                      <TierBadge tier={r.tier} />
                      <div className="min-w-0">
                        <p className="text-sm text-muted">
                          {formatClock(r.createdAt)}
                          {kind ? ` · ${kind}` : ""}
                        </p>
                        <p className="break-words">{r.reason ?? "Tidak ada alasan tercatat."}</p>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </>
          );
        }}
      </Section>

      <Section title="Percakapan" query={messages}>
        {(msgs) => (
          <>
            {session.data?.staffHandling && (
              <p role="status" className="mb-3 text-sm text-muted">
                Percakapan ditangani petugas. Balasan otomatis dijeda.
              </p>
            )}
            <Transcript messages={msgs} />
            <Composer
              sessionId={sessionId}
              onSent={() => void qc.invalidateQueries({ queryKey: ["session", sessionId] })}
            />
          </>
        )}
      </Section>

      <div className="flex justify-end border-t border-line pt-4">
        <FinishButton sessionId={sessionId} onDone={onBack} />
      </div>
    </div>
  );
}
