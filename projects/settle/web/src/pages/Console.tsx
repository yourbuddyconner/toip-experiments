import { useCallback, useEffect, useState } from "react";
import type { LogEntry, LogHead } from "../../../src/protocol/log";
import { Empty, Field } from "../ui";
import { day, money, short, toUnits, when } from "../model";
import { identityFromSeed } from "@toip-tools/trust-core";
import type { PlatformConfig } from "../../../src/client/client";
import { accounts, api } from "../session";
import { Splash, Wordmark } from "../App";
import { UnlockAccount } from "./Accounts";
import type { Unlocked } from "../vault";
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

interface OperatorStatus {
  operator: string | null;
  setupNeeded: boolean;
  operators?: string[];
}

/** The operator view, behind sign-in: an operator signs a challenge with their account's key. */
export function Console() {
  const [status, setStatus] = useState<OperatorStatus | null>(null);
  const [config, setConfig] = useState<PlatformConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const check = useCallback(async () => {
    try {
      const [st, c] = await Promise.all([api.get<OperatorStatus>("/api/operator"), api.config()]);
      setStatus(st);
      setConfig(c);
      setError(null);
    } catch (e) {
      setError(String((e as Error).message));
    }
  }, []);
  useEffect(() => void check(), [check]);
  if (error) return <Splash text={`Can't reach the platform: ${error}`} />;
  if (!status || !config) return <Splash text="Checking who you are…" />;
  if (!status.operator) return <SignIn status={status} onSignedIn={check} />;
  return (
    <OperatorConsole
      config={config}
      me={status.operator}
      onSignOut={async () => {
        await api.operatorSignOut();
        await check();
      }}
    />
  );
}

function SignIn({ status, onSignedIn }: { status: OperatorStatus; onSignedIn: () => Promise<void> }) {
  const setupCode = new URLSearchParams(location.search).get("setup") ?? undefined;
  const [error, setError] = useState<string>();
  const list = accounts();
  const signIn = async (u: Unlocked) => {
    setError(undefined);
    try {
      await api.operatorSignIn(identityFromSeed(u.seed), status.setupNeeded ? setupCode : undefined);
      if (setupCode) history.replaceState(null, "", "/console");
      await onSignedIn();
    } catch (e) {
      setError(String((e as Error).message));
    }
  };
  return (
    <main className="welcome">
      <Wordmark />
      <h1>Operator view</h1>
      {status.setupNeeded && !setupCode ? (
        <p className="lede">
          This platform has no operator yet. When it started, it printed a link to become the first one (<code>/console?setup=…</code>). Open that link on this machine.
        </p>
      ) : status.setupNeeded ? (
        <p className="lede">This platform has no operator yet. Sign in with one of your accounts to become its first operator; you can add others afterwards.</p>
      ) : (
        <p className="lede">Operators sign in with their Settle account: the account's key signs a one-time challenge. Choose your account.</p>
      )}
      {(!status.setupNeeded || setupCode) &&
        (list.length ? (
          <section className="account-list">
            <h2>Accounts in this browser</h2>
            <ul>
              {list.map((a) => (
                <li key={a.id}>
                  <UnlockAccount account={a} onOpen={(u) => void signIn(u)} />
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <p>
            There are no Settle accounts in this browser. <a href="/">Make one</a>, then come back here.
          </p>
        ))}
      {error && <p className="error">{error}</p>}
    </main>
  );
}

/** What the platform's operators see: the processor's books and log, the arbiter's cases, the operators, and the network clock. */
function OperatorConsole({ config, me, onSignOut }: { config: PlatformConfig; me: string; onSignOut: () => Promise<void> }) {
  const [tab, setTab] = useState<"arbitration" | "processor" | "operators">("arbitration");
  const [proc, setProc] = useState<ProcessorView | null>(null);
  const [arb, setArb] = useState<{ cases: Case[]; now: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const [p, a] = await Promise.all([api.get<ProcessorView>("/api/processor"), api.get<{ cases: Case[]; now: number }>("/api/arbiter")]);
      if (!p || !a) return;
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
        <span className="chip chip-network">{config.cluster === "local" ? "Local network" : `Solana ${config.cluster}`}</span>
        {config.devClock ? <DevClock now={arb?.now ?? 0} onMoved={() => void load()} /> : null}
        <span className="console-me">
          Signed in as {config.names[me] ?? short(me)}{" "}
          <button type="button" className="linkish small" onClick={() => void onSignOut()}>
            Sign out
          </button>
        </span>
      </header>
      {error && <p className="error">Can't reach the platform: {error}</p>}
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "arbitration"} className={tab === "arbitration" ? "tab active" : "tab"} onClick={() => setTab("arbitration")}>
          Arbitration{disputed.some((c) => !c.ruling) ? ` (${disputed.filter((c) => !c.ruling).length} open)` : ""}
        </button>
        <button role="tab" aria-selected={tab === "processor"} className={tab === "processor" ? "tab active" : "tab"} onClick={() => setTab("processor")}>
          Processor
        </button>
        <button role="tab" aria-selected={tab === "operators"} className={tab === "operators" ? "tab active" : "tab"} onClick={() => setTab("operators")}>
          Operators
        </button>
      </div>
      {tab === "arbitration" ? <Arbitration cases={disputed} all={arb?.cases.length ?? 0} reload={load} /> : tab === "processor" ? <Processor v={proc} /> : <OperatorList me={me} />}
    </div>
  );
}

function OperatorList({ me }: { me: string }) {
  const [list, setList] = useState<string[]>([]);
  const [people, setPeople] = useState<Record<string, string>>({});
  const [did, setDid] = useState("");
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    const [st, dir] = await Promise.all([api.get<OperatorStatus>("/api/operator"), api.people()]);
    setList(st.operators ?? []);
    setPeople(Object.fromEntries(dir.map((p) => [p.did, p.name])));
  }, []);
  useEffect(() => void load(), [load]);
  const act = async (path: string, d: string) => {
    setError(undefined);
    try {
      await api.post(path, { did: d });
      setDid("");
      await load();
    } catch (e) {
      setError(String((e as Error).message));
    }
  };
  return (
    <section className="section">
      <p className="lede">Operators can see every case and the processor's books, and rule on disputes as Settle Arbitration. Each signs in with their own account.</p>
      <ul className="operators">
        {list.map((d) => (
          <li key={d}>
            <span>{people[d] ?? "Unnamed account"}</span> <span className="mono small breakable">{d}</span>{" "}
            {d === me ? (
              <span className="hint small">you</span>
            ) : (
              <button type="button" className="linkish small" onClick={() => void act("/api/operator/remove", d)}>
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void act("/api/operator/add", did.trim());
        }}
      >
        <Field label="Add an operator" hint="Their account's identifier, from their Profile page (did:key:…).">
          <input value={did} onChange={(e) => setDid(e.target.value)} className="mono" spellCheck={false} />
        </Field>
        <button className="btn" disabled={!did.trim().startsWith("did:")}>
          Add operator
        </button>
        {error && <p className="error">{error}</p>}
      </form>
    </section>
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
