import { useState } from "react";
import { encodeLink, type PaymentLink } from "../../../src/agents/party";
import { Action, Empty, Field } from "../ui";
import { money, toUnits } from "../model";
import type { Session } from "../session";

export const linkUrl = (l: PaymentLink) => `${location.origin}/pay/${encodeLink(l)}`;

export function Links({ s }: { s: Session }) {
  const party = s.party;
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [release, setRelease] = useState<PaymentLink["release"]>("payer-confirms");
  const [attester, setAttester] = useState("");
  const [windowDays, setWindowDays] = useState(0);
  const [made, setMade] = useState<PaymentLink | null>(null);
  const units = toUnits(amount);
  const others = s.people.filter((x) => x.did !== party.did);
  const links = [...party.links.values()].reverse();
  const valid = title.trim() && units && units > 0n && (release === "payer-confirms" || attester);

  return (
    <>
      <h1>Payment links</h1>
      <p className="lede">A link anyone can open to pay you. Their money goes into escrow, and comes to you when the work is confirmed.</p>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!valid) return;
          const l = await party.createLink({ title, units: units!, release, attester: release === "attester-confirms" ? attester : undefined, disputeWindowDays: windowDays });
          setMade(l);
          setTitle("");
          setAmount("");
        }}
      >
        <Field label="What it's for">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Fix the kitchen sink, Unit 4B" maxLength={140} required />
        </Field>
        <Field label="Price (USDC)" hint={units ? `The customer also pays the processor's fee: ${money(party.feeFor(units))} USDC.` : undefined}>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="120.00" required />
        </Field>
        <fieldset className="choice">
          <legend>Who confirms the work is done?</legend>
          <label>
            <input type="radio" name="release" checked={release === "payer-confirms"} onChange={() => setRelease("payer-confirms")} />
            <span>
              <strong>The customer</strong>, when they're happy with it
            </span>
          </label>
          <label>
            <input type="radio" name="release" checked={release === "attester-confirms"} onChange={() => setRelease("attester-confirms")} />
            <span>
              <strong>Someone else</strong>, like a building manager or an inspector
            </span>
          </label>
          {release === "attester-confirms" && (
            <Field label="Confirmed by" hint={others.length ? undefined : "Nobody else has an account on this network yet."}>
              <select value={attester} onChange={(e) => setAttester(e.target.value)} required>
                <option value="">Choose someone</option>
                {others.map((o) => (
                  <option key={o.did} value={o.did}>
                    {o.name}
                    {o.verified ? ` (verified: ${o.verified})` : ""}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </fieldset>
        <Field label="Dispute window" hint="After the work is confirmed, the customer has this long to raise a problem before the money is released.">
          <select value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value))}>
            <option value={0}>None: release on confirmation</option>
            <option value={1}>1 day</option>
            <option value={3}>3 days</option>
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
          </select>
        </Field>
        <button className="btn btn-primary" disabled={!valid}>
          Create payment link
        </button>
      </form>

      {made && (
        <div className="made" role="status">
          <p>
            <strong>Your link is ready.</strong> Send it to your customer.
          </p>
          <CopyLink l={made} />
        </div>
      )}

      <section className="section">
        <h2>Your links</h2>
        {links.length === 0 ? (
          <Empty title="No links yet." />
        ) : (
          <ul className="rows">
            {links.map(({ link, archived }) => {
              const paid = party.list().filter((p) => p.link === link.id);
              return (
                <li key={link.id} className={`row static ${archived ? "archived" : ""}`}>
                  <span className="row-main">
                    <strong>{link.title}</strong>
                    <span className="row-sub">
                      {link.release === "payer-confirms" ? "Customer confirms" : `${link.attesterName ?? party.nameOf(link.attester!)} confirms`}
                      {link.disputeWindowDays ? `, ${link.disputeWindowDays}-day window` : ""}. {paid.length} payment{paid.length === 1 ? "" : "s"}.
                      {archived ? " Archived." : ""}
                    </span>
                  </span>
                  <span className="row-amount">{money(link.units)}</span>
                  {!archived && (
                    <span className="row-actions">
                      <CopyLink l={link} compact />
                      <Action onRun={async () => party.archiveLink(link.id)}>Archive</Action>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}

function CopyLink({ l, compact }: { l: PaymentLink; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const url = linkUrl(l);
  return (
    <span className="copylink">
      {!compact && <input readOnly value={url} onFocus={(e) => e.target.select()} aria-label="Payment link" />}
      <button
        type="button"
        className="btn btn-plain"
        onClick={async () => {
          await navigator.clipboard?.writeText(url).catch(() => {});
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "Copied" : "Copy link"}
      </button>
      <a className="btn btn-plain" href={url} target="_blank" rel="noreferrer">
        Open
      </a>
    </span>
  );
}
