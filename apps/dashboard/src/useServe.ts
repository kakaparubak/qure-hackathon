import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { serveSession } from "./api";
import type { QueueRow } from "./types";

export interface ServeFailure {
  sessionId: string;
  patientName: string | null;
  message: string;
}

export function useServe() {
  const qc = useQueryClient();
  const [failure, setFailure] = useState<ServeFailure | null>(null);

  const mutation = useMutation({
    mutationFn: (row: QueueRow) => serveSession(row.sessionId),

    // Hapus baris langsung, simpan salinan untuk dikembalikan kalau gagal.
    onMutate: async (row) => {
      setFailure(null);
      await qc.cancelQueries({ queryKey: ["queue"] });
      const previous = qc.getQueryData<QueueRow[]>(["queue"]);
      qc.setQueryData<QueueRow[]>(["queue"], (old) => old?.filter((r) => r.sessionId !== row.sessionId));
      return { previous };
    },

    onError: (err, row, ctx) => {
      if (ctx?.previous) qc.setQueryData<QueueRow[]>(["queue"], ctx.previous);
      setFailure({
        sessionId: row.sessionId,
        patientName: row.patientName,
        message: err instanceof Error ? err.message : "kesalahan tidak diketahui",
      });
    },

    // Berhasil atau gagal, ambil ulang kebenarannya dari server.
    onSettled: () => qc.invalidateQueries({ queryKey: ["queue"] }),
  });

  return {
    serve: (row: QueueRow) => mutation.mutate(row),
    failure,
    clearFailure: () => setFailure(null),
  };
}