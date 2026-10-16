import { useQuery } from "@tanstack/react-query";
import { getMessages, getSession, getTriage } from "./api";

const common = {
  // Tidak ada event SSE untuk pesan/triase baru, jadi ambil ulang berkala selama detail terbuka.
  refetchInterval: 2_000,
  refetchIntervalInBackground: true,
  // Data medis: jangan simpan lama di memori setelah detail ditutup.
  gcTime: 60_000,
};

export function useSessionDetail(id: string) {
  const session = useQuery({ queryKey: ["session", id], queryFn: () => getSession(id), ...common });
  const triage = useQuery({ queryKey: ["session", id, "triage"], queryFn: () => getTriage(id), ...common });
  const messages = useQuery({ queryKey: ["session", id, "messages"], queryFn: () => getMessages(id), ...common });
  return { session, triage, messages };
}
