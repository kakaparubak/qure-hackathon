import { describe, expect, it } from "vitest";
import { WAIT_LONG_MINUTES } from "./config";
import {
  familyLabel,
  formatAgo,
  formatClock,
  formatEta,
  isLongWait,
  laneLabel,
  roleLabel,
} from "./format";

describe("formatEta", () => {
  it("P1 selalu 'Segera', apa pun nilai ETA dari server", () => {
    expect(formatEta("P1", 0)).toBe("Segera");
    expect(formatEta("P1", null)).toBe("Segera");
    expect(formatEta("P1", 12)).toBe("Segera");
  });

  it("tier lain tanpa ETA menampilkan 'ETA belum tersedia'", () => {
    expect(formatEta("P3", null)).toBe("ETA belum tersedia");
  });

  it("tier lain dengan ETA menampilkan menitnya", () => {
    expect(formatEta("P3", 45)).toBe("ETA 45 mnt");
    expect(formatEta("P2", 5)).toBe("ETA 5 mnt");
  });
});

describe("isLongWait", () => {
  it("false tepat di bawah ambang, true tepat di ambang", () => {
    expect(isLongWait(WAIT_LONG_MINUTES - 1)).toBe(false);
    expect(isLongWait(WAIT_LONG_MINUTES)).toBe(true);
    expect(isLongWait(WAIT_LONG_MINUTES + 30)).toBe(true);
  });

  it("0 menit tidak pernah dianggap lama", () => {
    expect(isLongWait(0)).toBe(false);
  });
});

describe("label yang belum dipetakan", () => {
  it("lane yang tidak dikenal mengembalikan null (disembunyikan, bukan ditampilkan mentah)", () => {
    expect(laneLabel("nilai-tidak-dikenal")).toBeNull();
  });

  it("family kosong atau tidak dikenal mengembalikan null", () => {
    expect(familyLabel(undefined)).toBeNull();
    expect(familyLabel("nilai-tidak-dikenal")).toBeNull();
  });

  it("role yang tidak dikenal tampil sebagai 'Pesan'", () => {
    expect(roleLabel("nilai-tidak-dikenal")).toBe("Pesan");
  });

  it("role pasien dan asisten terpetakan", () => {
    expect(roleLabel("patient")).toBe("Pasien");
    expect(roleLabel("assistant")).toBe("Asisten");
  });
});

describe("formatAgo", () => {
  const from = new Date(0);

  it("di bawah 5 detik: 'baru saja'", () => {
    expect(formatAgo(from, 0)).toBe("baru saja");
    expect(formatAgo(from, 4_000)).toBe("baru saja");
  });

  it("detik", () => {
    expect(formatAgo(from, 5_000)).toBe("5 dtk lalu");
    expect(formatAgo(from, 59_000)).toBe("59 dtk lalu");
  });

  it("menit", () => {
    expect(formatAgo(from, 60_000)).toBe("1 mnt lalu");
    expect(formatAgo(from, 59 * 60_000)).toBe("59 mnt lalu");
  });

  it("jam", () => {
    expect(formatAgo(from, 3_600_000)).toBe("1 jam lalu");
    expect(formatAgo(from, 7_200_000)).toBe("2 jam lalu");
  });

  it("waktu di masa depan tidak jadi angka negatif", () => {
    expect(formatAgo(new Date(10_000), 0)).toBe("baru saja");
  });
});

describe("formatClock", () => {
  it("tanggal tidak valid menjadi tanda hubung", () => {
    expect(formatClock("bukan tanggal")).toBe("—");
  });

  it("tanggal valid menghasilkan jam, bukan tanda hubung", () => {
    expect(formatClock("2026-10-14T10:00:00.000Z")).not.toBe("—");
  });
});