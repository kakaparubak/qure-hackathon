import { useCallback, useEffect, useRef, useState } from "react";

const REPEAT_MS = 4000; // TODO: konfirmasi dengan perawat (terlalu sering = mengganggu)

// Tiga nada pendek: tinggi, rendah, tinggi.
function beep(ctx: AudioContext) {
  const t = ctx.currentTime;
  [880, 660, 880].forEach((freq, i) => {
    const start = t + i * 0.25;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.3, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.2);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.22);
  });
}

// activeCount = jumlah alert P1 yang belum dikonfirmasi.
export function useAlertSound(activeCount: number) {
  const ctxRef = useRef<AudioContext | null>(null);
  const prevCount = useRef(0);
  const [enabled, setEnabled] = useState(false);

  const play = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    if (ctx.state === "suspended") void ctx.resume();
    beep(ctx);
  }, []);

  // Harus dipanggil dari klik pengguna (aturan browser).
  const enable = useCallback(() => {
    if (!ctxRef.current) ctxRef.current = new AudioContext();
    void ctxRef.current.resume();
    setEnabled(true);
    beep(ctxRef.current); // nada uji, untuk mengecek volume
  }, []);

  const disable = useCallback(() => setEnabled(false), []);

  // Alert baru masuk: bunyi langsung.
  useEffect(() => {
    if (enabled && activeCount > prevCount.current) play();
    prevCount.current = activeCount;
  }, [activeCount, enabled, play]);

  // Selama masih ada alert aktif: ulangi berkala.
  const hasActive = activeCount > 0;
  useEffect(() => {
    if (!enabled || !hasActive) return;
    const id = setInterval(play, REPEAT_MS);
    return () => clearInterval(id);
  }, [enabled, hasActive, play]);

  return { enabled, enable, disable };
}