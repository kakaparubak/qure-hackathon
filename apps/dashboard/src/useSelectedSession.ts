import { useCallback, useEffect, useState } from "react";

const parse = () => {
  const m = /^#sesi=(.+)$/.exec(window.location.hash);
  return m ? decodeURIComponent(m[1]) : null;
};

// Pasien yang detailnya sedang dibuka, disimpan di alamat (#sesi=ID) supaya tombol Back browser berfungsi.
export function useSelectedSession() {
  const [id, setId] = useState<string | null>(parse);

  useEffect(() => {
    const sync = () => setId(parse());
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, []);

  const open = useCallback((sessionId: string) => {
    window.history.pushState({ detail: true }, "", `#sesi=${encodeURIComponent(sessionId)}`);
    setId(sessionId);
  }, []);

  const close = useCallback(() => {
    if (window.history.state?.detail) {
      window.history.back(); // memicu popstate, lalu id ikut dikosongkan
    } else {
      // Halaman dibuka langsung dari tautan detail: tidak ada riwayat untuk mundur.
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      setId(null);
    }
  }, []);

  return { id, open, close };
}