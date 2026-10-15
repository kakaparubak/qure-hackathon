import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { QueueTicketRow } from "@qure/core/queue/tickets";
import "./style.css";

const REFRESH_MS = 4_000;
const STALE_MS = 12_000;
const lanes = { priority: "Prioritas", normal: "Reguler", green: "Jalur hijau" };
const ticketLabel = (number: number) => `Q-${String(number).padStart(3, "0")}`;
const clock = (time: number) => new Date(time).toLocaleTimeString("id-ID", {
  timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

function App() {
  const [rows, setRows] = useState<QueueTicketRow[] | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [error, setError] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let active = true;
    let pending = false;
    let controller: AbortController | undefined;
    async function refresh() {
      if (pending) return;
      pending = true;
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), 8_000);
      try {
        const response = await fetch("/api/queue", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("queue unavailable");
        const data: { rows?: QueueTicketRow[] } = await response.json();
        if (!Array.isArray(data.rows)) throw new Error("invalid queue response");
        if (active) {
          setRows(data.rows);
          setLastUpdated(Date.now());
          setError(false);
        }
      } catch {
        if (active) setError(true);
      } finally {
        window.clearTimeout(timeout);
        pending = false;
      }
    }
    void refresh();
    const poll = window.setInterval(() => { void refresh(); }, REFRESH_MS);
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      active = false;
      window.clearInterval(poll);
      window.clearInterval(tick);
      controller?.abort();
    };
  }, []);

  const stale = lastUpdated !== null && (error || now - lastUpdated > STALE_MS);
  const priority = rows?.filter((row) => row.lane === "priority").length ?? 0;
  const regular = rows?.filter((row) => row.lane === "normal").length ?? 0;

  return <>
    <header className="topbar">
      <a className="brand" href="/dashboard/" aria-label="Qure! beranda">qure<span>!</span></a>
      <span className="topbar-label">Ruang perawat</span>
      <span className="readonly">Hanya lihat</span>
    </header>
    <main>
      <div className="heading">
        <div><p className="eyebrow">PELAYANAN PASIEN</p><h1>Antrean pasien</h1>
          <p className="intro">Pantau urutan dan kebutuhan penilaian pasien.</p></div>
        <div className={`sync ${stale || error ? "sync-warning" : ""}`} role="status">
          <span className="status-dot" />
          <div><strong>{stale ? "Data belum diperbarui" : error ? "Koneksi terputus" : lastUpdated ? "Pembaruan otomatis" : "Menghubungkan…"}</strong>
            <small>{lastUpdated ? `Terakhir ${clock(lastUpdated)} WIB · setiap 4 detik` : "Mengambil data antrean"}</small></div>
        </div>
      </div>

      <section className="summary" aria-label="Ringkasan antrean">
        <div><span>Dalam antrean</span><strong>{rows ? rows.length : "—"}<small>pasien</small></strong></div>
        <div className="priority-summary"><span>Jalur prioritas</span><strong>{rows ? priority : "—"}<small>perlu ditinjau</small></strong></div>
        <div><span>Jalur reguler</span><strong>{rows ? regular : "—"}<small>pasien</small></strong></div>
      </section>

      {(stale || error) && <div className="notice warning" role="alert">
        <strong>{stale ? "Data lama sedang ditampilkan." : "Antrean belum dapat dimuat."}</strong>{" "}
        Pembaruan akan dicoba kembali secara otomatis. Pastikan kondisi pasien secara langsung.
      </div>}

      <section className="board" aria-labelledby="board-title">
        <div className="board-heading"><h2 id="board-title">Daftar antrean</h2><span>Nomor tiket tetap · posisi dapat berubah</span></div>
        {rows === null ? <div className="empty" role="status"><span className="empty-icon">…</span>
          <h3>{error ? "Menunggu koneksi" : "Memuat antrean…"}</h3><p>{error ? "Data pasien belum tersedia. Mencoba kembali otomatis." : "Data terbaru akan muncul di sini."}</p></div>
          : rows.length === 0 ? <div className="empty" role="status"><span className="empty-icon">✓</span><h3>Belum ada pasien dalam antrean</h3><p>Pasien yang masuk antrean akan tampil secara otomatis.</p></div>
          : <div className="table-scroll"><table>
            <thead><tr><th>Tiket / tanggal</th><th>Pasien</th><th>Jalur / triase</th><th>Posisi di jalur</th><th>Sudah menunggu</th><th>Estimasi giliran</th><th>Alergi</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={row.sessionId} className={row.tier === "P1" ? "urgent-row" : ""}>
              <td><strong className="ticket">{ticketLabel(row.ticketNumber)}</strong><small>{row.ticketDate}</small></td>
              <td className="patient"><strong>{row.patientName?.trim() || "Belum diisi"}</strong>{row.tier === "P1" && <small className="urgent-label">P1 · Penilaian segera</small>}</td>
              <td><span className={`lane lane-${row.lane}`}>{lanes[row.lane]}</span><small>Triase {row.tier ?? "belum ditetapkan"}</small></td>
              <td><span className="position">#{row.position}</span></td>
              <td>{Math.floor(row.waitedMinutes)} menit</td>
              <td>{row.tier === "P1" || row.tier === "P2" ? <strong className="urgent-label">Perlu penilaian segera</strong>
                : row.etaMinutes === null ? <span className="muted">Belum tersedia</span> : <><strong>~{Math.round(row.etaMinutes)} menit</strong><small>Perkiraan, dapat berubah</small></>}</td>
              <td>{row.hasAllergies ? <span className="allergy">⚠ Alergi tercatat<small>Verifikasi sebelum tindakan</small></span> : <span className="muted">Belum ada alergi tercatat</span>}</td>
            </tr>)}</tbody>
          </table></div>}
      </section>
      <p className="footnote">Prioritas mengikuti hasil triase terkini. Kondisi gawat darurat perlu penilaian segera; jangan menunggu estimasi giliran.</p>
    </main>
    <footer><span>Qure! · Antrean & triase</span><span>Waktu Indonesia Barat (WIB)</span></footer>
  </>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
