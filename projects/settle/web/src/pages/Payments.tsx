import { useState } from "react";
import { STATE } from "../../../src/chain/escrow";
import type { PaymentState } from "../../../src/agents/base";
import { A, Action, Empty, Field, PaymentChip, Seals } from "../ui";
import { day, explorer, money, short, when } from "../model";
import type { Session } from "../session";
import { PaymentRows } from "./Home";

const FILTERS: [string, string, (x: PaymentState) => boolean][] = [
  ["all", "All", () => true],
  ["in", "Getting paid", (x) => x.role === "payee"],
  ["out", "Paying", (x) => x.role === "payer"],
  ["confirm", "Confirming", (x) => x.role === "attester"],
];

export function Payments({ s }: { s: Session }) {
  const [f, setF] = useState("all");
  return (
    <>
      <h1>Payments</h1>
      <div className="tabs" role="tablist">
        {FILTERS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={f === k} className={f === k ? "tab active" : "tab"} onClick={() => setF(k)}>
            {label}
          </button>
        ))}
      </div>
      <PaymentRows s={s} filter={FILTERS.find((x) => x[0] === f)![2]} />
    </>
  );
}

/** What happens next, in a sentence, from this party's side. */
function nextStep(s: Session, p: PaymentState): string {
  const party = s.party;
  const t = p.terms;
  if (!t) return p.role === "payee" ? "Waiting for the customer to agree terms." : "Agreeing terms with the payee.";
  const attester = t.conditions.attester === party.did ? "you" : party.nameOf(t.conditions.attester);
  if (p.chain?.state === STATE.reclaimed) return "The payer took the money back after the deadline. The processor kept its fee.";
  if (p.settled) {
    const paid = p.settled.payeeUnits;
    if (paid === "0") return "The full price went back to the payer.";
    if (paid !== t.amount.units) return `The arbiter split it: ${money(paid)} to the payee, ${money(BigInt(t.amount.units) - BigInt(paid))} back to the payer.`;
    return p.role === "payee" ? "You've been paid in full." : `${party.nameOf(t.payee.did)} was paid in full.`;
  }
  if (p.cancelled) return "You cancelled this payment before any money was locked.";
  if (!p.escrow) return "Opening the escrow…";
  if (p.disputes.length && !p.ruling) return `Settle Arbitration is looking at the dispute. Until it rules, the payer can't take the money back.`;
  if (p.ruling) return "The arbiter ruled. Its decision is released as soon as one party signs it too.";
  const done = p.attestations.some((a) => a.claim === "complete");
  const windowDays = t.conditions.disputeWindowSeconds / 86400;
  if (p.role === "attester") return done ? "You confirmed the work. The money moves once the payer and payee sign." : `${party.nameOf(t.payer.did)} asked you to confirm the work is done before ${party.nameOf(t.payee.did)} is paid.`;
  if (!done) return `The money is locked in escrow. It's released when ${attester} confirm${attester === "you" ? "" : "s"} the work is done.`;
  if (windowDays > 0 && p.pending) return `Confirmed. The payer's device signs once the ${windowDays}-day dispute window has passed with no dispute.`;
  return "Confirmed. The release is being signed and submitted.";
}

export function PaymentDetail({ s, id }: { s: Session; id: string }) {
  const party = s.party;
  const p = party.payments.get(id);
  const [reason, setReason] = useState("");
  const [showDispute, setShowDispute] = useState(false);
  if (!p) return <Empty title="This payment isn't in this account." />;
  const t = p.terms;
  const me = party.did;
  const open = !!p.escrow && !p.settled && p.chain?.state !== STATE.reclaimed;
  const iAttest = t?.conditions.attester === me && !p.attestations.some((a) => a.issuer === me);
  const canDispute = open && (p.role === "payer" || p.role === "payee") && !p.ruling;
  const canReclaim = open && p.role === "payer" && p.chain && s.now > p.chain.refundAfter;
  const owed = p.chain && ((p.role === "payee" && p.chain.payeeOwed !== "0") || (p.role === "payer" && p.chain.payerOwed !== "0"));
  const balance = p.balance && p.balance !== "0" && (p.role === "payee" || p.escrow || p.cancelled) && !open;
  const names = t
    ? { payer: party.nameOf(t.payer.did), payee: party.nameOf(t.payee.did), arbiter: party.nameOf(t.arbiter.did) }
    : { payer: p.role === "payer" ? party.name : party.nameOf(p.counterparty ?? ""), payee: p.role === "payee" ? party.name : party.nameOf(p.counterparty ?? ""), arbiter: "Settle Arbitration" };

  return (
    <article className="detail">
      <p className="crumbs">
        <A to="/payments">Payments</A>
      </p>
      <header className="detail-head">
        <div>
          <h1>{p.purpose}</h1>
          <p className="detail-who">
            {p.role === "payee" ? `From ${names.payer}` : p.role === "payer" ? `To ${names.payee}` : `${names.payer} paying ${names.payee}`}
          </p>
        </div>
        <div className="detail-amount">
          <span className="amount">{money(p.units)}</span> <span className="unit">USDC</span>
          <PaymentChip p={p} />
        </div>
      </header>

      <Seals p={p} names={names} />
      <p className="next">{nextStep(s, p)}</p>
      {p.settled && (p.settled.transaction ? explorer(s.config, "tx", p.settled.transaction) : p.escrow && explorer(s.config, "address", p.escrow)) && (
        <p className="onchain">
          Settled on Solana.{" "}
          <a href={(p.settled.transaction ? explorer(s.config, "tx", p.settled.transaction) : explorer(s.config, "address", p.escrow!))!} target="_blank" rel="noreferrer">
            See the settlement on Solana Explorer
          </a>
        </p>
      )}

      <div className="actions">
        {iAttest && open && (
          <>
            <Action kind="primary" onRun={() => party.attest(p.id, "complete")}>
              Confirm the work is done
            </Action>
            {p.role === "attester" && <Action onRun={() => party.attest(p.id, "not-complete")}>It isn't done</Action>}
          </>
        )}
        {open && p.role === "payee" && !p.disputes.length && p.attestations.some((a) => a.claim === "complete") && (
          <Action onRun={() => party.requestRelease(p.id)}>Ask for payment again</Action>
        )}
        {open && p.role === "payee" && (
          <Action kind="danger" onRun={() => party.refund(p.id)}>
            Refund in full
          </Action>
        )}
        {canDispute && !showDispute && (
          <button type="button" className="btn btn-plain" onClick={() => setShowDispute(true)}>
            Report a problem
          </button>
        )}
        {canReclaim && (
          <Action kind="primary" onRun={() => party.reclaim(p.id)}>
            Take my money back
          </Action>
        )}
        {owed && <Action kind="primary" onRun={() => party.claim(p.id)}>Collect what's owed</Action>}
        {balance && <Action onRun={() => party.collectToWallet()}>Move {money(p.balance)} to wallet</Action>}
        {p.role === "payer" && !p.escrow && !p.cancelled && (
          <Action onRun={async () => party.cancel(p.id)}>Cancel</Action>
        )}
      </div>

      {showDispute && (
        <form
          className="dispute"
          onSubmit={async (e) => {
            e.preventDefault();
            await party.dispute(p.id, reason.trim());
            setShowDispute(false);
          }}
        >
          <Field label="What's wrong?" hint="Settle Arbitration reads this along with the signed record of the payment. Opening a dispute stops the payer from reclaiming until it rules.">
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={1000} required />
          </Field>
          <div className="actions">
            <button className="btn btn-danger" disabled={!reason.trim()}>
              Open dispute
            </button>
            <button type="button" className="btn btn-plain" onClick={() => setShowDispute(false)}>
              Never mind
            </button>
          </div>
        </form>
      )}

      <div className="detail-cols">
        <section>
          <h2>Activity</h2>
          <ol className="timeline">
            {[...(p.timeline ?? [])].reverse().map((e, i) => (
              <li key={i}>
                <time>{when(e.at)}</time>
                <span>{e.text}</span>
              </li>
            ))}
          </ol>
        </section>
        {t && (
          <section>
            <h2>Terms</h2>
            <dl className="facts">
              <dt>Price</dt>
              <dd>{money(t.amount.units)} USDC</dd>
              <dt>Processor fee</dt>
              <dd>{money(t.fee.units)} USDC, paid by the payer, whatever the outcome</dd>
              <dt>Released when</dt>
              <dd>{t.conditions.attester === me ? "you confirm" : `${party.nameOf(t.conditions.attester)} confirms`} the work is done</dd>
              <dt>Dispute window</dt>
              <dd>{t.conditions.disputeWindowSeconds === 0 ? "None: released on confirmation" : `${t.conditions.disputeWindowSeconds / 86400} days after confirmation`}</dd>
              <dt>Payer can reclaim</dt>
              <dd>after {day(p.chain?.refundAfter ?? t.refundAfter)} if nothing has happened</dd>
              <dt>Arbiter</dt>
              <dd>{names.arbiter}</dd>
              {p.escrow && (
                <>
                  <dt>Escrow</dt>
                  <dd className="mono" title={p.escrow}>
                    {explorer(s.config, "address", p.escrow) ? (
                      <a href={explorer(s.config, "address", p.escrow)!} target="_blank" rel="noreferrer">
                        {short(p.escrow)}
                      </a>
                    ) : (
                      short(p.escrow)
                    )}
                  </dd>
                </>
              )}
            </dl>
          </section>
        )}
      </div>
    </article>
  );
}
