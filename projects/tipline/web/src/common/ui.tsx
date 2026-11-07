import { useEffect, useId, useState, type ReactNode } from "react";

export function useTick(fn: () => void, ms: number, deps: unknown[] = []) {
  useEffect(() => {
    const t = setInterval(fn, ms);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** A value people copy by hand or with a button: a DID, a membership code, a tip code. */
export function Copyable({ value, label, className = "", display }: { value: string; label: string; className?: string; display?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={`copyable ${className}`}>
      <code aria-label={label} data-value={value}>
        {display ?? value}
      </code>
      <button
        type="button"
        className="quiet"
        onClick={async () => {
          await navigator.clipboard?.writeText(value).catch(() => {});
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "Copied" : `Copy ${label.toLowerCase()}`}
      </button>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

export function Notice({ kind = "info", children, title }: { kind?: "info" | "good" | "bad" | "warn"; title?: string; children: ReactNode }) {
  return (
    <div className={`notice ${kind}`} role={kind === "bad" ? "alert" : "status"}>
      {title && <strong>{title}</strong>}
      <div>{children}</div>
    </div>
  );
}

/** Runs an async action, showing its error and a busy state. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}
