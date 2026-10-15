import { describe, expect, it } from "vitest";
import { liveWaited } from "./waitClock";
import type { QueueRow } from "./types";

const MIN = 60_000;
const T0 = 1_000_000;

// Setiap tes memakai sessionId sendiri karena waitClock menyimpan status di tingkat modul.
const row = (sessionId: string, waitedMinutes: number): QueueRow => ({
  sessionId,
  patientName: "Tes",
  tier: "P3",
  lane: "standard",
  position: 1,
  etaMinutes: null,
  waitedMinutes,
  hasAllergies: false,
});

describe("liveWaited", () => {
  it("panggilan pertama mengembalikan angka dari server", () => {
    expect(liveWaited(row("w-1", 5), T0)).toBe(5);
  });

  it("menambah menit yang sudah lewat sejak angka diterima", () => {
    liveWaited(row("w-2", 5), T0);
    expect(liveWaited(row("w-2", 5), T0 + 3 * MIN)).toBe(8);
  });

  it("membulatkan ke bawah: 59 detik belum menambah, 61 detik menambah satu", () => {
    liveWaited(row("w-3", 0), T0);
    expect(liveWaited(row("w-3", 0), T0 + 59_000)).toBe(0);
    expect(liveWaited(row("w-3", 0), T0 + 61_000)).toBe(1);
  });

  it("angka server yang sama tidak mengulang hitungan dari nol", () => {
    liveWaited(row("w-4", 5), T0);
    liveWaited(row("w-4", 5), T0 + 2 * MIN);
    // Server mengirim ulang angka lama (mis. pembaruan karena pasien lain dilayani).
    expect(liveWaited(row("w-4", 5), T0 + 3 * MIN)).toBe(8);
  });

  it("angka baru dari server menjadi titik awal hitungan berikutnya", () => {
    liveWaited(row("w-5", 5), T0);
    expect(liveWaited(row("w-5", 10), T0 + 4 * MIN)).toBe(10);
    expect(liveWaited(row("w-5", 10), T0 + 5 * MIN)).toBe(11);
  });

  it("tiap pasien dihitung sendiri-sendiri", () => {
    liveWaited(row("w-6a", 1), T0);
    liveWaited(row("w-6b", 20), T0 + 2 * MIN);
    expect(liveWaited(row("w-6a", 1), T0 + 5 * MIN)).toBe(6);
    expect(liveWaited(row("w-6b", 20), T0 + 5 * MIN)).toBe(23);
  });
});