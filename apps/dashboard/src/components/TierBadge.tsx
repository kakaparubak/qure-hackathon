import type { TriageTier } from "../types";

// Teks tier selalu tampil, warna hanya pendukung (aman untuk buta warna).
const styles: Record<TriageTier, string> = {
  P1: "bg-red-700 text-white",
  P2: "bg-orange-700 text-white",
  P3: "bg-yellow-300 text-yellow-950",
  P4: "bg-slate-200 text-slate-900",
};

export function TierBadge({ tier }: { tier: TriageTier }) {
  return (
    <span
      className={`inline-flex min-w-11 justify-center rounded px-2 py-1 text-sm font-bold ${styles[tier]}`}
    >
      {tier}
    </span>
  );
}
