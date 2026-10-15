import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useP1Alerts } from "./useP1Alerts";
import type { QueueRow, TriageTier } from "./types";

const row = (sessionId: string, tier: TriageTier): QueueRow => ({
  sessionId,
  patientName: sessionId,
  tier,
  lane: "x",
  position: 1,
  etaMinutes: null,
  waitedMinutes: 0,
  hasAllergies: false,
});

function setup(initial: QueueRow[] | undefined) {
  return renderHook(({ rows }) => useP1Alerts(rows), {
    initialProps: { rows: initial },
  });
}

describe("useP1Alerts", () => {
  it("tidak ada alert sebelum data antrean dimuat", () => {
    const { result } = setup(undefined);
    expect(result.current.alerts).toEqual([]);
  });

  it("P1 yang sudah ada saat data pertama dimuat tidak memicu alert", () => {
    const { result } = setup([row("a", "P1"), row("b", "P3")]);
    expect(result.current.alerts).toEqual([]);
  });

  it("data pertama yang datang setelah 'undefined' tetap jadi dasar, bukan alert", () => {
    const { result, rerender } = setup(undefined);
    rerender({ rows: [row("a", "P1")] });
    expect(result.current.alerts).toEqual([]);
  });

  it("pasien P1 baru memicu alert", () => {
    const { result, rerender } = setup([row("a", "P3")]);
    rerender({ rows: [row("a", "P3"), row("b", "P1")] });
    expect(result.current.alerts.map((a) => a.sessionId)).toEqual(["b"]);
  });

  it("pasien yang naik dari P3 ke P1 memicu alert", () => {
    const { result, rerender } = setup([row("a", "P3")]);
    rerender({ rows: [row("a", "P1")] });
    expect(result.current.alerts.map((a) => a.sessionId)).toEqual(["a"]);
  });

  it("pasien P3 baru tidak memicu alert", () => {
    const { result, rerender } = setup([row("a", "P3")]);
    rerender({ rows: [row("a", "P3"), row("b", "P3")] });
    expect(result.current.alerts).toEqual([]);
  });

  it("pembaruan antrean yang sama tidak menggandakan alert", () => {
    const { result, rerender } = setup([row("a", "P3")]);
    rerender({ rows: [row("a", "P1")] });
    rerender({ rows: [row("a", "P1")] });
    rerender({ rows: [row("a", "P1")] });
    expect(result.current.alerts).toHaveLength(1);
  });

  it("'Mengerti' menghapus alert dan tidak muncul lagi untuk pasien yang sama", () => {
    const { result, rerender } = setup([row("a", "P3")]);
    rerender({ rows: [row("a", "P1")] });
    act(() => result.current.dismiss("a"));
    expect(result.current.alerts).toEqual([]);

    rerender({ rows: [row("a", "P1")] });
    expect(result.current.alerts).toEqual([]);
  });

  it("alert hilang sendiri kalau pasiennya sudah dilayani (tidak ada di antrean)", () => {
    const { result, rerender } = setup([row("a", "P3")]);
    rerender({ rows: [row("a", "P1")] });
    expect(result.current.alerts).toHaveLength(1);

    rerender({ rows: [] });
    expect(result.current.alerts).toEqual([]);
  });

  it("dua alert aktif bisa dikonfirmasi satu per satu", () => {
    const { result, rerender } = setup([row("a", "P3"), row("b", "P3")]);
    rerender({ rows: [row("a", "P1"), row("b", "P1")] });
    expect(result.current.alerts).toHaveLength(2);

    act(() => result.current.dismiss("a"));
    expect(result.current.alerts.map((x) => x.sessionId)).toEqual(["b"]);
  });
});