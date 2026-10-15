import type { QueueRow } from "./types";

const MINUTE = 60_000;

// Satu entri per pasien: angka menit dari server dan kapan angka itu pertama kali kita lihat.
// Status di tingkat modul, supaya daftar antrean dan halaman detail memakai angka yang sama.
const anchors = new Map<string, { base: number; seenAt: number }>();

/**
 * Menit menunggu yang terus berjalan, dihitung di klien.
 * Server hanya mengirim angka saat snapshot, jadi tanpa ini angkanya diam sampai ada pembaruan.
 *
 * - Panggilan pertama: pakai angka server, catat waktunya.
 * - Angka server sama dengan yang tercatat: tambahkan menit penuh yang sudah lewat.
 * - Angka server berbeda: itu pembaruan baru, jadikan titik awal hitungan yang baru.
 */
export function liveWaited(row: QueueRow, now: number): number {
  const known = anchors.get(row.sessionId);

  if (!known || known.base !== row.waitedMinutes) {
    anchors.set(row.sessionId, { base: row.waitedMinutes, seenAt: now });
    return row.waitedMinutes;
  }

  const elapsed = Math.max(0, Math.floor((now - known.seenAt) / MINUTE));
  return known.base + elapsed;
}