import { useQuery } from "@tanstack/react-query";
import { getQueue } from "./api";

// Satu sumber untuk App (header) dan QueueBoard. Query key sama, jadi datanya dipakai bersama.
export function useQueue(polling: boolean) {
  return useQuery({
    queryKey: ["queue"],
    queryFn: getQueue,
    // Saat SSE tidak live, ambil ulang tiap 10 detik sebagai cadangan.
    refetchInterval: polling ? 10_000 : false,
  });
}