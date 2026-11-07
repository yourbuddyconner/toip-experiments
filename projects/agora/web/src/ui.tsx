/** Shared pieces: the nym seal, notices, proving progress, and the dev clock. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ProveProgress } from "@toip-tools/anon-membership";
import { nymLook } from "../../src/protocol/names";
import { useApp } from "./state";

/**
 * A pseudonym's seal: a roundel drawn from the nym's hash. Four wedges in two hues, a ring, and a
 * centre. The same nym always draws the same seal; different nyms almost always differ.
 */
export function NymSeal({ nym, size = 40 }: { nym: string; size?: number }) {
  const look = nymLook(nym);
  const a = `hsl(${look.hue} 62% 46%)`;
  const b = `hsl(${look.hue2} 70% 72%)`;
  const wedges = [0, 1, 2, 3].map((i) => {
    const on = (look.pattern >> i) & 1;
    const start = (i * Math.PI) / 2 - Math.PI / 2;
    const end = start + Math.PI / 2;
    const r = 15;
    const [x1, y1, x2, y2] = [20 + r * Math.cos(start), 20 + r * Math.sin(start), 20 + r * Math.cos(end), 20 + r * Math.sin(end)];
    return <path key={i} d={`M20 20 L${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`} fill={on ? a : b} />;
  });
  return (
    <svg className="seal" width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r="19" fill="var(--surface)" stroke={a} strokeWidth="2" />
      {wedges}
      <circle cx="20" cy="20" r="5.5" fill="var(--ink)" />
    </svg>
  );
}

export function NymTag({ nym, you }: { nym: string; you?: boolean }) {
  if (!nym) return null;
  return (
    <span className="nymtag" title={nym}>
      <NymSeal nym={nym} size={24} />
      <span className="nymname">{nymLook(nym).name}</span>
      {you && <span className="you">you</span>}
    </span>
  );
}

export function Notice({ tone = "info", title, children }: { tone?: "info" | "ok" | "warn" | "error"; title?: string; children?: ReactNode }) {
  return (
    <div className={`notice notice-${tone}`} role={tone === "error" || tone === "warn" ? "alert" : "status"}>
      {title && <strong className="notice-title">{title}</strong>}
      {children && <div>{children}</div>}
    </div>
  );
}

export function when(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + " UTC";
}

export function day(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export type ProvingState =
  | { phase: "idle" }
  | { phase: "running"; stage: ProveProgress["stage"] | "loading"; started: number; label: string }
  | { phase: "done"; ms: number; label: string }
  | { phase: "error"; message: string };

/** Runs a proof and reports its progress honestly: the library's stages and the elapsed time, no fake percentages. */
export function useProving() {
  const [state, setState] = useState<ProvingState>({ phase: "idle" });
  const run = async <T,>(label: string, fn: (onProgress: (p: ProveProgress) => void) => Promise<T>): Promise<T | undefined> => {
    const started = performance.now();
    setState({ phase: "running", stage: "loading", started, label });
    try {
      const out = await fn((p) => setState({ phase: "running", stage: p.stage, started, label }));
      setState({ phase: "done", ms: performance.now() - started, label });
      return out;
    } catch (e) {
      setState({ phase: "error", message: String((e as Error)?.message ?? e) });
      return undefined;
    }
  };
  return { state, run, reset: () => setState({ phase: "idle" }) };
}

const STAGE_WORDS: Record<string, string> = {
  loading: "Checking your membership and the group's latest root",
  witness: "Working out the proof's inputs on this device",
  proving: "Proving, on this device. Nothing is sent until it's done.",
  done: "Finishing",
};

export function ProvingStatus({ state }: { state: ProvingState }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (state.phase !== "running") return;
    const t = setInterval(() => tick((x) => x + 1), 100);
    return () => clearInterval(t);
  }, [state.phase]);
  if (state.phase === "idle") return null;
  if (state.phase === "error") return <Notice tone="error" title="That didn't work">{state.message}</Notice>;
  if (state.phase === "done") return <p className="proving-done" role="status">{state.label}: ready in {(state.ms / 1000).toFixed(1)} s.</p>;
  const secs = ((performance.now() - state.started) / 1000).toFixed(1);
  const steps = ["loading", "witness", "proving"];
  const at = Math.max(0, steps.indexOf(state.stage));
  return (
    <div className="proving" role="status" aria-live="polite">
      <div className="proving-head">
        <strong>{state.label}</strong>
        <span className="proving-time">{secs} s</span>
      </div>
      <ol className="proving-steps" aria-label="Steps">
        {steps.map((s, i) => (
          <li key={s} className={i < at ? "done" : i === at ? "now" : ""}>
            {STAGE_WORDS[s]}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The dev clock: shows the host's day and skips ahead, as Settle's does. */
export function DevClock() {
  const { services, bump, version } = useApp();
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  useEffect(() => () => void (live.current = false), []);
  if (!services) return null;
  const skip = async (seconds: number) => {
    setBusy(true);
    try {
      await services.host.advance(seconds);
      await services.syncClock();
    } finally {
      if (live.current) setBusy(false);
      bump();
    }
  };
  return (
    <div className="devclock" data-version={version}>
      <span>
        Dev clock: <strong data-testid="today">{day(services.clock.now())}</strong>
      </span>
      <span className="devclock-buttons" role="group" aria-label="Skip ahead">
        Skip ahead
        {[
          ["1 hour", 3600],
          ["1 day", 86400],
          ["8 days", 8 * 86400],
        ].map(([label, s]) => (
          <button key={label} type="button" className="btn btn-small btn-quiet" disabled={busy} onClick={() => void skip(Number(s))}>
            {label}
          </button>
        ))}
      </span>
    </div>
  );
}
