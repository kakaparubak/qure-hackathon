import type { ServeFailure } from "../useServe";

export function ServeError({ failure, onDismiss }: { failure: ServeFailure | null; onDismiss: () => void }) {
  if (!failure) return null;
  return (
    <div
      role="alert"
      className="flex items-center gap-3 rounded border-2 border-red-900 bg-red-50 p-3 text-red-900 shadow"
    >
      <p className="flex-1 text-sm font-semibold">
        Gagal menandai {failure.patientName ?? "pasien tanpa nama"} sebagai dilayani ({failure.message}).
        Pasien dikembalikan ke antrean. Coba lagi.
      </p>
      <button
        onClick={onDismiss}
        className="min-h-11 shrink-0 rounded border border-red-900 bg-white px-3 py-2 text-sm font-bold"
      >
        Tutup
      </button>
    </div>
  );
}