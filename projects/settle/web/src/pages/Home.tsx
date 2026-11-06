import { STATE } from "../../../src/chain/escrow";
import { A, Action, Empty, PaymentChip } from "../ui";
import { money, needsYou, when } from "../model";
import { api, type Session } from "../session";

export function Home({ s }: { s: Session }) {
  const p = s.party;
  const list = p.list();
  const inEscrow = list.filter((x) => x.escrow && !x.settled && x.chain?.state !== STATE.reclaimed && x.role !== "attester");
  const incoming = inEscrow.filter((x) => x.role === "payee").reduce((n, x) => n + BigInt(x.terms!.amount.units), 0n);
  const outgoing = inEscrow.filter((x) => x.role === "payer").reduce((n, x) => n + BigInt(x.terms!.amount.units), 0n);
  const collectable = list.filter((x) => x.role !== "attester" && x.balance && x.balance !== "0" && (x.role === "payee" || x.escrow || x.cancelled)).reduce((n, x) => n + BigInt(x.balance!), 0n);
  const todo = list.map((x) => ({ x, what: needsYou(x, p.did) })).filter((t) => t.what);
  const fresh = list.length === 0;

  return (
    <>
      <header className="balance">
        <p className="balance-figure">
          <span className="amount">{money(s.wallet)}</span> <span className="unit">USDC</span>
        </p>
        <p className="balance-label">in your wallet</p>
        <dl className="balance-more">
          {incoming > 0n && (
            <div>
              <dt>Coming to you</dt>
              <dd>{money(incoming)} held in escrow</dd>
            </div>
          )}
          {outgoing > 0n && (
            <div>
              <dt>You've paid in</dt>
              <dd>{money(outgoing)} waiting for the work</dd>
            </div>
          )}
          {collectable > 0n && (
            <div>
              <dt>Ready to move</dt>
              <dd>
                {money(collectable)} <Action onRun={() => p.collectToWallet()}>Move to wallet</Action>
              </dd>
            </div>
          )}
        </dl>
      </header>

      {todo.length > 0 && (
        <section className="section">
          <h2>Needs you</h2>
          <ul className="rows">
            {todo.map(({ x, what }) => (
              <li key={x.id}>
                <A to={`/payments/${x.id}`} className="row">
                  <span className="row-main">
                    <strong>{what}</strong>
                    <span className="row-sub">
                      {x.purpose}, {p.nameOf(x.role === "payee" ? x.counterparty! : x.terms!.payee.did)}
                    </span>
                  </span>
                  <span className="row-amount">{money(x.units)}</span>
                </A>
              </li>
            ))}
          </ul>
        </section>
      )}

      {fresh ? (
        <section className="section start">
          <h2>Start here</h2>
          <ol className="steps">
            <li>
              <strong>Add test money.</strong> This network runs on a local Solana chain with test USDC.{" "}
              <Action kind="primary" onRun={() => api.addFunds(p, 500_000_000n).then(() => s.refresh())}>
                Add 500 test USDC
              </Action>
            </li>
            <li>
              <strong>Create a payment link</strong> for a job, and send it to your customer. <A to="/links">Create a payment link</A>
            </li>
            <li>
              <strong>Get paid when they confirm.</strong> Their money waits in escrow until they say the work is done.
            </li>
          </ol>
        </section>
      ) : (
        <section className="section">
          <h2>Recent payments</h2>
          <PaymentRows s={s} limit={6} />
          <p>
            <A to="/payments">All payments</A>
          </p>
        </section>
      )}
    </>
  );
}

export function PaymentRows({ s, limit, filter }: { s: Session; limit?: number; filter?: (x: ReturnType<Session["party"]["list"]>[number]) => boolean }) {
  const p = s.party;
  const list = p.list().filter(filter ?? (() => true)).slice(0, limit);
  if (!list.length) return <Empty title="No payments yet." />;
  return (
    <ul className="rows">
      {list.map((x) => {
        const other = x.role === "attester" ? `${p.nameOf(x.terms!.payer.did)} paying ${p.nameOf(x.terms!.payee.did)}` : p.nameOf(x.counterparty ?? "");
        const dir = x.role === "payee" ? "From" : x.role === "payer" ? "To" : "Confirming for";
        return (
          <li key={x.id}>
            <A to={`/payments/${x.id}`} className="row">
              <span className="row-main">
                <strong>{x.purpose}</strong>
                <span className="row-sub">
                  {dir} {other}, {when(x.createdAt)}
                </span>
              </span>
              <PaymentChip p={x} />
              <span className={`row-amount ${x.role === "payee" ? "in" : ""}`}>{money(x.units)}</span>
            </A>
          </li>
        );
      })}
    </ul>
  );
}
