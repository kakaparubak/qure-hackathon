import { useEffect, useState, type FormEvent, type ReactNode } from "react";

type AuthStatus = "checking" | "signed_out" | "signed_in";

async function refreshAuth(): Promise<AuthStatus> {
  try {
    const response = await fetch("/api/auth/status", { cache: "no-store" });
    if (!response.ok) return "signed_out";
    const data = await response.json() as { authenticated?: boolean };
    return data.authenticated ? "signed_in" : "signed_out";
  } catch { return "signed_out"; }
}

function LoginScreen({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!response.ok) throw new Error(response.status === 429 ? "Terlalu banyak percobaan. Coba lagi nanti." : "Nama pengguna atau kata sandi salah.");
      setPassword("");
      onLogin();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Tidak dapat masuk. Periksa koneksi Anda.");
    } finally { setBusy(false); }
  }

  return <main className="grid min-h-screen place-items-center p-4">
    <form onSubmit={submit} className="w-full max-w-sm space-y-5 rounded-2xl border border-line bg-white p-6 shadow-sm">
      <div><h1 className="text-2xl font-bold">Masuk ke Qure</h1><p className="mt-1 text-sm text-muted">Dashboard petugas puskesmas</p></div>
      <label className="block space-y-1 text-sm font-medium">Nama pengguna<input autoComplete="username" required value={username} onChange={event => setUsername(event.target.value)} className="w-full rounded-lg border border-line px-3 py-2 font-normal" /></label>
      <label className="block space-y-1 text-sm font-medium">Kata sandi<input type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} className="w-full rounded-lg border border-line px-3 py-2 font-normal" /></label>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <button disabled={busy} className="w-full rounded-lg bg-ink px-4 py-2 font-semibold text-white disabled:opacity-60">{busy ? "Memeriksa…" : "Masuk"}</button>
    </form>
  </main>;
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("checking");
  useEffect(() => {
    void refreshAuth().then(setStatus);
    const logout = () => {
      void fetch("/api/auth/logout", { method: "POST" }).finally(() => setStatus("signed_out"));
    };
    window.addEventListener("qure:logout", logout);
    return () => window.removeEventListener("qure:logout", logout);
  }, []);

  if (status === "checking") return <main className="grid min-h-screen place-items-center text-muted" role="status">Memeriksa sesi…</main>;
  if (status === "signed_out") return <LoginScreen onLogin={() => setStatus("signed_in")} />;
  return <>{children}</>;
}
