/** App-wide state: the services, the signed-in account, and a version that bumps when anything changes. */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { Unlocked } from "@toip-tools/web-vault";
import { Session, loadServices, vault, type Services } from "./services";

interface AppState {
  services: Services | null;
  error: string | null;
  session: Session | null;
  /** Bumps on any change worth re-reading for: a post, a join, a clock skip. */
  version: number;
  bump(): void;
  signIn(u: Unlocked): Promise<void>;
  signOut(): void;
}

const Ctx = createContext<AppState | null>(null);
const ACTIVE = "agora.active";

export function AppProvider({ children }: { children: ReactNode }) {
  const [services, setServices] = useState<Services | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    loadServices().then(setServices, (e) => setError(String(e?.message ?? e)));
  }, []);

  // Follow the host's dev clock.
  useEffect(() => {
    if (!services) return;
    const t = setInterval(() => void services.syncClock().then(bump, () => {}), 15_000);
    return () => clearInterval(t);
  }, [services, bump]);

  // A tab remembers which account it used; after a reload the account is listed, locked.
  const signIn = useCallback(
    async (u: Unlocked) => {
      const svc = services ?? (await loadServices());
      session?.close();
      const s = await Session.open(u, svc);
      sessionStorage.setItem(ACTIVE, u.account.id);
      setSession(s);
      bump();
    },
    [services, session, bump],
  );
  const signOut = useCallback(() => {
    session?.close();
    vault.lockAll();
    sessionStorage.removeItem(ACTIVE);
    setSession(null);
    bump();
  }, [session, bump]);

  return <Ctx.Provider value={{ services, error, session, version, bump, signIn, signOut }}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside AppProvider");
  return v;
}

/** Runs `load` whenever `deps` or the app version change. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const { version } = useApp();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    load().then(
      (d) => live && (setData(d), setError(null), setLoading(false)),
      (e) => live && (setError(String(e?.message ?? e)), setLoading(false)),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version, n]);
  return { data, error, loading, reload: () => setN((x) => x + 1) };
}
