import type { QueueLane, TriageTier } from "./types";
import { WAIT_LONG_MINUTES } from "./config";

export const isLongWait = (waitedMinutes: number) => waitedMinutes >= WAIT_LONG_MINUTES;

// TODO: isi setelah backend memberi daftar nilai QueueLane yang lengkap.
// Selama nilainya belum ada di sini, lane disembunyikan (tier sudah menyampaikan prioritas).
const LANE_LABELS: Record<string, string> = {
  priority: 'Prioritas',normal: 'Antrean biasa',green: 'Panggilan balik',
};

export function laneLabel(lane: QueueLane): string | null {
  return LANE_LABELS[lane] ?? null;
}

// TODO: konfirmasi ke backend apa yang dikirim untuk kasus darurat (0, null, atau lainnya).
// Untuk P1 kita selalu tampilkan "Segera", apa pun nilainya.
export function formatEta(tier: TriageTier, etaMinutes: number | null): string {
  if (tier === "P1") return "Segera";
  if (etaMinutes === null) return "ETA belum tersedia";
  return `ETA ${etaMinutes} mnt`;
}

export function formatAgo(from: Date, now: number): string {
  const s = Math.max(0, Math.round((now - from.getTime()) / 1000));
  if (s < 5) return "baru saja";
  if (s < 60) return `${s} dtk lalu`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} mnt lalu`;
  return `${Math.floor(m / 60)} jam lalu`;
}

// TODO: isi setelah backend memberi daftar nilai `family` (jenis kasus eskalasi).
// Selama belum ada di sini, jenis kasus tidak ditampilkan di alert.
const FAMILY_LABELS: Record<string, string> = {};

export function familyLabel(family: string | undefined): string | null {
  return family ? (FAMILY_LABELS[family] ?? null) : null;
}

export function formatClock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
}

// TODO: konfirmasi nilai `role` dari backend. Nilai yang tidak dikenal tampil sebagai "Pesan".
const ROLE_LABELS: Record<string, string> = {
  nurse: "Petugas",
  bot: "Asisten",
  system: "Sistem",
  patient: "Pasien",
  user: "Pasien",
  assistant: "Asisten",
};

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? "Pesan";
}
