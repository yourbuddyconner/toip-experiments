import { useCallback, useEffect, useRef, useState } from "react";

export async function post<T = unknown>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const out = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(out.error ?? `${res.status} from ${path}`);
  return out;
}

/** Polls a GET endpoint about once a second. */
export function usePoll<T>(path: string, ms = 1000): { data: T | null; error: string | null; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const load = useCallback(async () => {
    try {
      const res = await fetch(path, { cache: "no-store" });
      if (!res.ok) throw new Error(`${res.status} from ${path}`);
      const v = (await res.json()) as T;
      if (alive.current) {
        setData(v);
        setError(null);
      }
    } catch (e) {
      if (alive.current) setError(String((e as Error).message));
    }
  }, [path]);
  useEffect(() => {
    alive.current = true;
    void load();
    const t = setInterval(() => void load(), ms);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [load, ms]);
  return { data, error, refresh: () => void load() };
}

/** A button's action: runs it once at a time, keeps the last error for showing inline. */
export function useAction(after?: () => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (key: string, fn: () => Promise<unknown>) => {
      setBusy(key);
      setError(null);
      try {
        await fn();
        after?.();
      } catch (e) {
        setError(String((e as Error).message));
      } finally {
        setBusy(null);
      }
    },
    [after],
  );
  return { busy, error, run };
}

export const shortDid = (did: string) => (did.length > 28 ? `${did.slice(0, 16)}…${did.slice(-6)}` : did);
export const time = (iso: string) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");
