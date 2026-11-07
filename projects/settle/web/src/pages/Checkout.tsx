import { useEffect, useState } from "react";
import { SystemClock, verifyCredential } from "@toip-tools/trust-core";
import { decodeLink, verifyLink, type PaymentLink } from "../../../src/agents/party";
import { facilitatorFee } from "../../../src/protocol/documents";
import { A, Action } from "../ui";
import { money, useSession } from "../model";
import { api, type Session } from "../session";
import { Splash, Welcome, Wordmark, type AccountSession } from "../App";
import { Unlock } from "./Accounts";

const clock = new SystemClock();

/** The hosted checkout: what anyone sees when they open a payment link. */
export function Checkout({ token, acct }: { token: string; acct: AccountSession }) {
  const [link, setLink] = useState<PaymentLink | null | "invalid">(null);
  const [verified, setVerified] = useState<string | null>(null);

  useEffect(() => {
    const l = decodeLink(token);
    if (!l) return setLink("invalid");
    void (async () => {
      if (!(await verifyLink(l, clock))) return setLink("invalid");
      setLink(l);
      const config = await api.config();
      for (const c of l.credentials ?? []) {
        if (c.issuer === config.verifier && c.type.includes("VerifiedBusiness") && c.credentialSubject?.id === l.issuer && (await verifyCredential(c, clock)).ok) {
          setVerified(String(c.credentialSubject.name));
        }
      }
    })();
  }, [token]);

  if (link === null) return <Splash text="Checking the payment link…" />;
  if (link === "invalid")
    return (
      <main className="checkout">
        <Wordmark />
        <h1>This payment link doesn't check out.</h1>
        <p>Its signature doesn't match what it says, so it may have been changed. Ask whoever sent it for a new one.</p>
      </main>
    );
  return (
    <main className="checkout">
      <header className="co-merchant">
        <span className="co-merchant-name">{link.name}</span>
        {verified ? <span className="badge">Verified: {verified}</span> : <span className="badge badge-quiet">Not verified</span>}
      </header>
      <h1 className="co-title">{link.title}</h1>
      <p className="co-price">
        <span className="amount">{money(link.units)}</span> <span className="unit">USDC</span>
      </p>
      <Protection link={link} />
      {acct.state === "opening" ? (
        <p>Opening your account…</p>
      ) : acct.state === "unlock" && acct.account ? (
        <div className="co-account">
          <Unlock account={acct.account} onOpen={acct.choose} onOther={() => (sessionStorage.removeItem("settle.active"), location.reload())} />
        </div>
      ) : !acct.session ? (
        <div className="co-account">
          <Welcome locked={acct.state === "locked"} onOpen={acct.choose} title="Who's paying?" placeholder="Dana Whitfield" />
        </div>
      ) : (
        <Pay s={acct.session} link={link} onLeave={acct.leave} />
      )}
      <footer className="co-foot">
        <Wordmark /> holds this payment in an escrow on Solana. No one controls it alone: two of payer, payee and arbiter have to sign.
      </footer>
    </main>
  );
}

function Protection({ link }: { link: PaymentLink }) {
  const who = link.release === "payer-confirms" ? "you confirm" : `${link.attesterName ?? "the named person"} confirms`;
  return (
    <ol className="co-how">
      <li>Your money goes into an escrow, not to {link.name}. Nobody can take it out alone, not even Settle.</li>
      <li>
        It's released when {who} the work is done{link.disputeWindowDays ? `, after a ${link.disputeWindowDays}-day window to raise a problem` : ""}.
      </li>
      <li>If something's wrong, report a problem and Settle Arbitration decides. If nothing happens at all, you can take your money back after {link.disputeWindowDays + 30} days.</li>
    </ol>
  );
}

const STEPS: [string, string][] = [
  ["contacting", "Asking for an invoice"],
  ["funding", "Agreeing terms and setting your money aside"],
  ["proposed", "Opening the escrow"],
  ["opened", "Locked in escrow"],
];

function Pay({ s, link, onLeave }: { s: Session; link: PaymentLink; onLeave: () => void }) {
  useSession(s);
  const party = s.party;
  const [checkoutId, setCheckoutId] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const fee = facilitatorFee(BigInt(link.units), s.config.processor.fee.bps, BigInt(s.config.processor.fee.minUnits));
  const total = BigInt(link.units) + fee;
  const c = checkoutId ? party.checkouts.get(checkoutId) : undefined;
  const earlier = [...party.checkouts.values()].filter((x) => x.link.id === link.id && x.status === "opened");

  useEffect(() => {
    if (c?.status !== "contacting") return setSlow(false);
    const t = setTimeout(() => setSlow(true), 6000);
    return () => clearTimeout(t);
  }, [c?.status]);

  if (link.issuer === party.did)
    return (
      <p className="notice">
        This is your own payment link. Open it in another tab with a different account to pay it. <A to="/links">Back to your links</A>
      </p>
    );

  if (c) {
    const at = STEPS.findIndex(([k]) => k === c.status);
    return (
      <section className="co-progress" aria-live="polite">
        <ol>
          {STEPS.map(([k, label], i) => (
            <li key={k} className={c.status === "failed" ? "" : i < at || c.status === "opened" ? "done" : i === at ? "now" : ""}>
              {label}
            </li>
          ))}
        </ol>
        {c.status === "failed" && <p className="error">The payment stopped: {c.error}</p>}
        {slow && c.status === "contacting" && (
          <p className="hint">{link.name} isn't online right now. Your request is waiting for them on the relay, and this page carries on when they're back.</p>
        )}
        {c.status === "opened" && c.paymentId && (
          <div className="made">
            <p>
              <strong>Paid into escrow.</strong> {link.release === "payer-confirms" ? "When the work is done, confirm it and the money goes to " + link.name + "." : `${link.attesterName ?? "The named person"} confirms the work.`}
            </p>
            <A to={`/payments/${c.paymentId}`} className="btn btn-primary">
              See the payment
            </A>
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="co-pay">
      <dl className="co-sum">
        <dt>Price</dt>
        <dd>{money(link.units)}</dd>
        <dt>Processor fee</dt>
        <dd>{money(fee)}</dd>
        <dt className="total">Total</dt>
        <dd className="total">{money(total)} USDC</dd>
      </dl>
      <p className="co-as">
        Paying as <strong>{party.name}</strong>, with {money(s.wallet)} USDC in your wallet.{" "}
        <button type="button" className="linkish" onClick={onLeave}>
          Not you?
        </button>
      </p>
      {earlier.length > 0 && <p className="notice">You've already paid this link. Paying again starts a second payment.</p>}
      {s.wallet < total ? (
        <Action kind="primary" onRun={() => api.addFunds(party, 500_000_000n).then(() => s.refresh())}>
          Add 500 test USDC to pay
        </Action>
      ) : (
        <Action kind="primary" onRun={async () => setCheckoutId((await party.checkout(link)).id)}>
          Pay {money(total)} USDC
        </Action>
      )}
    </section>
  );
}
