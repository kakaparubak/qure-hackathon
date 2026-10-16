import { useState } from "react";
import { QueueBoard } from "./components/QueueBoard";
import { SessionDetailView } from "./components/SessionDetailView";
import { ConnectionStatus } from "./components/ConnectionStatus";
import { P1Alerts } from "./components/P1Alerts";
import { SoundToggle } from "./components/SoundToggle";
import { DevPanel } from "./components/DevPanel";
import { useQueueEvents } from "./useQueueEvents";
import { useQueue } from "./useQueue";
import { useP1Alerts } from "./useP1Alerts";
import { useAlertSound } from "./useAlertSound";
import { useSelectedSession } from "./useSelectedSession";
import { useNow } from "./useNow";
import { USE_MOCK } from "./api";
import { AuthGate } from "./AuthGate";

export default function App() {
  return <AuthGate><QueueDashboard /></AuthGate>;
}

function QueueDashboard() {
  const { status, lastEventAt, families } = useQueueEvents();
  const { data, dataUpdatedAt } = useQueue(status !== "live");
  const { alerts, dismiss } = useP1Alerts(data);
  const sound = useAlertSound(alerts.length);
  const { id: openId, open, close } = useSelectedSession();
  const [restoreId, setRestoreId] = useState<string | null>(null);
  const now = useNow();

  const handleOpen = (id: string) => {
    setRestoreId(id);
    open(id);
  };

  // Waktu pembaruan terakhir = yang terbaru antara event SSE dan data antrean yang berhasil diambil/ditulis.
  const times = [lastEventAt?.getTime() ?? 0, dataUpdatedAt].filter((t) => t > 0);
  const lastUpdatedAt = times.length ? new Date(Math.max(...times)) : null;

  return (
    <main className="mx-auto max-w-3xl p-4 sm:p-6">
      {/* Alert P1 dan galat "Layani" berbagi satu wadah lengket supaya tidak saling menimpa. */}
      <div className="sticky top-0 z-10 mb-4 space-y-2 empty:hidden">
        <P1Alerts alerts={alerts} rows={data} families={families} onDismiss={dismiss} />
      </div>
      <header className="mb-4 space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-2xl font-bold">Antrean pasien</h1>
          <div className="flex items-center gap-3"><p className="text-base font-semibold tabular-nums">{data ? `${data.length} pasien` : "—"}</p><button onClick={() => window.dispatchEvent(new Event("qure:logout"))} className="rounded-lg border border-line bg-white px-3 py-1.5 text-sm font-medium">Keluar</button></div>
        </div>
        <ConnectionStatus status={status} lastUpdatedAt={lastUpdatedAt} now={now} />
        <SoundToggle enabled={sound.enabled} onEnable={sound.enable} onDisable={sound.disable} />
        {data && data.filter(row => row.tier === 'P1').length >= 3 && (
          <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-950">
            Antrean sedang padat: {data.filter(row => row.tier === 'P1').length} kasus P1 aktif. Kasus prioritas didahulukan; pasien yang memenuhi syarat dapat memilih panggilan balik.
          </p>
        )}
      </header>

      {openId ? (
        <SessionDetailView
          key={openId}
          sessionId={openId}
          queueRow={data?.find((r) => r.sessionId === openId)}
          queueLoaded={data !== undefined}
          now={now}
          onBack={close}
        />
      ) : (
        <QueueBoard
          polling={status !== "live"}
          onOpen={handleOpen}
          restoreFocusId={restoreId}
        />
      )}
      {USE_MOCK && <DevPanel />}
    </main>
  );
}
