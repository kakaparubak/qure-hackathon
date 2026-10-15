import { simulate } from "../mock/mockEventSource";
import { detailSim } from "../mock/details";

const btn = "rounded border border-line bg-white px-3 py-2 text-sm hover:bg-slate-100";

// Hanya tampil di mode mock. Untuk menguji tanpa backend.
export function DevPanel() {
  return (
    <section className="mt-6 rounded-lg border border-dashed border-line p-4">
      <h2 className="mb-1 font-semibold">Panel simulasi</h2>
      <p className="mb-3 text-sm text-muted">Hanya di mode mock. Hilang saat VITE_USE_MOCK=false.</p>
      <div className="flex flex-wrap gap-2">
        <button className={btn} onClick={detailSim.failNextMessages}>Gagalkan muat percakapan berikutnya</button>
        <button className={btn} onClick={simulate.failNextServe}>Gagalkan "Layani" berikutnya</button>
        <button className={btn} onClick={simulate.newPatient}>Pasien baru (P3)</button>
        <button className={btn} onClick={simulate.escalate}>Eskalasi jadi P1</button>
        <button className={btn} onClick={simulate.serveTop}>Layani pasien teratas</button>
        <button className={btn} onClick={simulate.drop}>Putuskan koneksi</button>
        <button className={btn} onClick={simulate.reconnect}>Sambungkan lagi</button>
      </div>
    </section>
  );
}
