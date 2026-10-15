export function SoundToggle({
  enabled,
  onEnable,
  onDisable,
}: {
  enabled: boolean;
  onEnable: () => void;
  onDisable: () => void;
}) {
  return (
    <button
      onClick={enabled ? onDisable : onEnable}
      aria-pressed={enabled}
      className={`min-h-11 rounded border px-3 py-2 text-sm font-semibold ${
        enabled
          ? "border-line bg-white text-ink"
          : "border-amber-700 bg-amber-100 text-amber-950"
      }`}
    >
      {enabled ? "🔊 Bunyi alert aktif" : "🔇 Bunyi alert mati · Tekan untuk mengaktifkan"}
    </button>
  );
}