import { useCallback, useEffect, useState } from "react";
import type { LogEntry, LogHead } from "../../../src/protocol/log";
import { Empty, Field } from "../ui";
import { day, money, short, toUnits, when } from "../model";
import { api } from "../session";
import { Wordmark } from "../App";
import { DevClock } from "./DevClock";

interface ProcessorView {
  did: string;
  fee: { bps: number; minUnits: string };
  feeAccount: string;
  feeBalance: string;
  feePayer: string;
  feePayerLamports: string;
  escrows: number;
  log: { entries: LogEntry[]; head: LogHead };
  check: { ok: boolean; problem?: string };
  events: { at: string; text: string }[];
}
interface Case {
  id: string;
  purpose: string;
  payer: { name: string };
  payee: { name: string };
  attester: { name: string };
  units: string;
  fee: string;
  disputeWindowDays: number;
  attestations: { by: string; claim: string; note?: string; at: string }[];
  disputes: { by: string; role: string; reason: string; at: string }[];
  ruling: { payeeUnits: string; reasons: string } | null;
  state: string;
  payeePaid: string | null;
  refundAfter: number | null;
}

/** What the platform's operators see: the processor's books and log, the arbiter's cases, and the network clock. */
export function Console() {
  const [tab, setTab] = useState<"arbitration" | "processor">("arbitration");
  const [proc, setProc] = useState<ProcessorView | null>(null);
  const [arb, setArb] = useState<{ cases: Case[]; now: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const [p, a] = await Promise.all([api.get<ProcessorView>("/api/processor"), api.get<{ cases: Case[]; now: number }>("/api/arbiter")]);
      setProc(p);
      setArb(a);
      setError(null);
    } catch (e) {
      setError(String((e as Error).message));
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [load]);

  const disputed = arb?.cases.filter((c) => c.disputes.length) ?? [];
  return (
    <div className="console">
      <header className="console-head">
        <Wordmark />
        <span className="console-title">Operator view</span>
        <DevClock now={arb?.now ?? 0} onMoved={() => void load()} />
      </header>
      {error && <p className="error">Can't reach the platform: {error}</p>}
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "arbitration"} className={tab === "arbitration" ? "tab active" : "tab"} onClick={() => setTab("arbitration")}>
          Arbitration{disputed.some((c) => !c.ruling) ? ` (${disputed.filter((c) => !c.ruling).length} open)` : ""}
        </button>
        <button role="tab" aria-selected={tab === "processor"} className={tab === "processor" ? "tab active" : "tab"} onClick={() => setTab("processor")}>
          Processor
        </button>
      </div>
      {tab === "arbitration" ? <Arbitration cases={disputed} all={arb?.cases.length ?? 0} reload={load} /> : <Processor v={proc} />}
    </div>
  );
}

function Arbitration({ cases, all, reload }: { cases: Case[]; all: number; reload: () => Promise<void> }) {
  if (!cases.length)
    return (
      <Empty title="No disputes.">
        <p className="hint">Settle Arbitration is named in {all} payment{all === 1 ? "" : "s"}. A case shows up here when the payer or the payee reports a problem.</p>
      </Empty>
    );
  return (
    <ul className="cases">
      {cases.map((c) => (
        <CaseView key={c.id} c={c} reload={reload} />
      ))}
    </ul>
  );
}

function CaseView({ c, reload }: { c: Case; reload: () => Promise<void> }) {
  const [amount, setAmount] = useState(money(c.units).replace(/,/g, ""));
  const [reasons, setReasons] = useState("");
  const units = toUnits(amount);
  const ok = units !== null && units <= BigInt(c.units) && reasons.trim();
  return (
    <li className="case">
      <header>
        <h2>{c.purpose}</h2>
        <p className="row-sub">
          {c.payer.name} paid {c.payee.name} {money(c.units)} USDC. {c.attester.name} confirms the work
          {c.disputeWindowDays ? `, with a ${c.disputeWindowDays}-day window` : ""}.
        </p>
      </header>
      <ol className="timeline">
        {[
          ...c.attestations.map((a) => ({ at: a.at, text: `${a.by} attested the work is ${a.claim}${a.note ? `: "${a.note}"` : ""}` })),
          ...c.disputes.map((d) => ({ at: d.at, text: `${d.by} (${d.role}) disputed: "${d.reason}"` })),
        ]
          .sort((a, b) => a.at.localeCompare(b.at))
          .map((e, i) => (
            <li key={i}>
              <time>{when(e.at)}</time>
              <span>{e.text}</span>
            </li>
          ))}
      </ol>
      {c.ruling ? (
        <p className="next">
          Ruled {money(c.ruling.payeeUnits)} to {c.payee.name}: "{c.ruling.reasons}".{" "}
          {c.state === "resolved" ? `Carried out on-chain: ${money(c.payeePaid ?? "0")} paid.` : "Waiting for one party to sign it too."}
        </p>
      ) : c.state !== "funded" ? (
        <p className="next">This escrow already settled ({c.state}).</p>
      ) : (
        <form
          className="form rule"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!ok) return;
            await api.post("/api/arbiter/rule", { paymentId: c.id, payeeUnits: units!.toString(), reasons: reasons.trim() });
            await reload();
          }}
        >
          <p className="hint">The escrow is held until {c.refundAfter ? day(c.refundAfter) : "a ruling"}, so the payer can't reclaim it meanwhile.</p>
          <Field label={`To ${c.payee.name} (USDC)`} hint={units !== null && units <= BigInt(c.units) ? `${money(BigInt(c.units) - units)} goes back to ${c.payer.name}.` : `Up to ${money(c.units)}.`}>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Reasons" hint="Both parties see this. It's signed and goes into the evidence the outcome rests on.">
            <textarea value={reasons} onChange={(e) => setReasons(e.target.value)} rows={3} required />
          </Field>
          <button className="btn btn-primary" disabled={!ok}>
            Rule and sign
          </button>
        </form>
      )}
    </li>
  );
}

function Processor({ v }: { v: ProcessorView | null }) {
  if (!v) return <p>Loading…</p>;
  return (
    <>
      <dl className="facts wide">
        <dt>Fees earned</dt>
        <dd>
          <span className="amount small-amount">{money(v.feeBalance)}</span> USDC
        </dd>
        <dt>Fee schedule</dt>
        <dd>
          {v.fee.bps / 100}% of the price, at least {money(v.fee.minUnits)} USDC, paid by the payer on every outcome
        </dd>
        <dt>Escrows opened</dt>
        <dd>{v.escrows}</dd>
        <dt>Network fees</dt>
        <dd>
          {(Number(v.feePayerLamports) / 1e9).toFixed(4)} SOL left to pay them with, from <span className="mono">{short(v.feePayer)}</span>
        </dd>
      </dl>
      <section className="section">
        <h2>Transparency log</h2>
        <p className={v.check.ok ? "ok" : "error"}>
          {v.check.ok ? `The hash chain checks out, and the processor signed its head (${v.log.entries.length} entries).` : `The log doesn't check out: ${v.check.problem}`}
        </p>
        <p className="hint">Roles, amounts and document hashes only: no names, no DIDs, no dispute reasons. Anyone holding a payment's documents can check them against it.</p>
        {v.log.entries.length === 0 ? (
          <Empty title="Nothing logged yet." />
        ) : (
          <table className="log">
            <thead>
              <tr>
                <th>#</th>
                <th>What</th>
                <th>Detail</th>
                <th>Hash</th>
              </tr>
            </thead>
            <tbody>
              {[...v.log.entries].reverse().map((e) => (
                <tr key={e.seq}>
                  <td>{e.seq}</td>
                  <td>{e.kind}</td>
                  <td>{describe(e)}</td>
                  <td className="mono">{e.hash.slice(0, 12)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="section">
        <h2>What the processor did</h2>
        <ol className="timeline">
          {[...v.events].reverse().map((e, i) => (
            <li key={i}>
              <time>{when(e.at)}</time>
              <span>{e.text}</span>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

function describe(e: LogEntry): string {
  const d = e.detail as Record<string, unknown>;
  switch (e.kind) {
    case "opened":
      return `escrow ${short(String(d.escrow))} for ${money(String(d.units))}`;
    case "signature":
      return `${d.by} signed ${money(String(d.payeeUnits))} to the payee`;
    case "dispute":
      return `the ${d.by} disputed`;
    case "ruling":
      return `ruled ${money(String(d.payeeUnits))} to the payee`;
    case "hold":
      return `held until ${day(Number(d.until))}`;
    case "settled":
      return `settled: ${money(String(d.payeeUnits))} to the payee, signed by ${(d.signers as string[]).join(" and ")}`;
    default:
      return "";
  }
}
