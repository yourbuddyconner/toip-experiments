import { useState, type MouseEvent, type ReactNode } from "react";
import type { PaymentState } from "../../src/agents/base";
import { navigate, statusOf, type Status } from "./model";

export function A(props: { to: string; children: ReactNode; className?: string }) {
  return (
    <a
      href={props.to}
      className={props.className}
      onClick={(e: MouseEvent) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(props.to);
      }}
    >
      {props.children}
    </a>
  );
}

export function Chip({ status }: { status: Status }) {
  return <span className={`chip chip-${status.tone}`}>{status.label}</span>;
}

export const PaymentChip = ({ p }: { p: PaymentState }) => <Chip status={statusOf(p)} />;

type SealState = "signed" | "open";

/** Who has signed this payment's outcome, as far as this party knows. Any two of the three move the money. */
export function sealsFor(p: PaymentState): { payer: SealState; payee: SealState; arbiter: SealState } {
  const mine = p.signed.length > 0;
  let payer = p.role === "payer" && mine;
  let payee = (p.role === "payee" && mine) || (p.role === "payer" && !!p.pending);
  const arbiter = !!p.ruling;
  if (p.settled) {
    if (!p.ruling) payer = payee = true;
    else if (!payer && !payee) {
      if (p.role === "payer") payee = true;
      else payer = true;
    }
  }
  const s = (b: boolean): SealState => (b ? "signed" : "open");
  return { payer: s(payer), payee: s(payee), arbiter: s(arbiter) };
}

export function Seals({ p, names }: { p: PaymentState; names: { payer: string; payee: string; arbiter: string } }) {
  const s = sealsFor(p);
  const count = Object.values(s).filter((x) => x === "signed").length;
  const items: [keyof typeof s, string][] = [
    ["payer", "Payer"],
    ["payee", "Payee"],
    ["arbiter", "Arbiter"],
  ];
  return (
    <figure className="seals" aria-label={`${count} of 3 signatures; any 2 release the money`}>
      <div className="seal-row">
        {items.map(([k, label]) => (
          <div key={k} className={`seal seal-${s[k]}`}>
            <svg viewBox="0 0 64 64" aria-hidden="true">
              <circle cx="32" cy="32" r="28" />
              {s[k] === "signed" && <path d="M20 33 l8 8 l16 -18" />}
            </svg>
            <span className="seal-role">{label}</span>
            <span className="seal-name">{names[k]}</span>
          </div>
        ))}
      </div>
      <figcaption>
        {p.settled ? "Two signatures released the money." : count === 0 ? "Any two of these three signatures release the money. Nobody else can move it." : `${count} of 2 needed signatures so far.`}
      </figcaption>
    </figure>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children}
    </div>
  );
}

export function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      {props.children}
      {props.hint && <span className="field-hint">{props.hint}</span>}
    </label>
  );
}

/** A button that runs an async action, shows that it's working, and reports a failure next to itself. */
export function Action(props: { onRun: () => Promise<unknown>; children: ReactNode; kind?: "primary" | "plain" | "danger"; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="action">
      <button
        type="button"
        className={`btn btn-${props.kind ?? "plain"}`}
        disabled={busy || props.disabled}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await props.onRun();
          } catch (e) {
            setError(String((e as Error)?.message ?? e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Working…" : props.children}
      </button>
      {error && <span className="error" role="alert">{error}</span>}
    </span>
  );
}
