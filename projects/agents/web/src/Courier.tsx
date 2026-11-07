import { useState } from "react";
import type { CourierOfferView, CourierState } from "../../src/app/types";
import { post, shortDid, time, useAction, usePoll } from "./api";

export function Courier() {
  const { data, error, refresh } = usePoll<CourierState>("/api/courier");
  if (!data) return <main className="loading">{error ? `Can't reach your device: ${error}` : "Connecting…"}</main>;
  return (
    <>
      <header className="masthead courier-head">
        <div>
          <h1>Dana Ruiz, courier</h1>
          <p className="sub">Your device checks every agent's mandate before it invoices them, and again before it agrees terms.</p>
        </div>
        <dl className="masthead-facts">
          <div>
            <dt>Earned</dt>
            <dd className="num">{data.wallet}</dd>
          </div>
          <div>
            <dt>Identifier</dt>
            <dd className="mono" title={data.did}>
              {shortDid(data.did)}
            </dd>
          </div>
        </dl>
      </header>
      <main className="courier">
        <section aria-labelledby="offers-h" className="panel">
          <h2 id="offers-h">Job offers</h2>
          <div aria-live="polite">
            {data.offers.length === 0 ? <p className="empty">No offers yet. Agents that find you in the directory send them here.</p> : data.offers.map((o) => <Offer key={o.job} o={o} onDone={refresh} />)}
          </div>
        </section>
        {data.refusals.length > 0 && (
          <section aria-labelledby="refused-h" className="panel">
            <h2 id="refused-h">Payments your device refused</h2>
            <ul className="strips">
              {data.refusals.map((r, i) => (
                <li key={i} className="strip" data-state="refused">
                  <h3>
                    {r.fromName}: {r.title}
                  </h3>
                  <ul className="reasons">
                    {r.reasons.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                  <time className="mono small">{time(r.at)}</time>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </>
  );
}

function Offer({ o, onDone }: { o: CourierOfferView; onDone: () => void }) {
  const act = useAction(onDone);
  const [price, setPrice] = useState("45");
  const [note, setNote] = useState("Same day. I'm nearby.");
  const state = o.settled ? "cleared" : o.paid ? "cleared" : o.verified ? "held" : "refused";
  return (
    <article className="strip offer" data-state={state} aria-labelledby={`offer-${o.job}`}>
      <div className="strip-head">
        <h3 id={`offer-${o.job}`}>{o.title}</h3>
        <span className={`badge ${o.verified ? "ok" : "warn"}`}>{o.verified ? "Mandate verified" : "Not verified"}</span>
      </div>
      <dl className="facts">
        <div>
          <dt>From</dt>
          <dd>{o.fromName}</dd>
        </div>
        <div>
          <dt>Pays up to</dt>
          <dd className="num">{o.maxPrice}</dd>
        </div>
        <div>
          <dt>Category</dt>
          <dd className="mono">{o.category}</dd>
        </div>
        <div>
          <dt>Confirmed by</dt>
          <dd>{o.confirmedBy}</dd>
        </div>
      </dl>
      <figure className="untrusted">
        <figcaption>The job, as the agent describes it</figcaption>
        <blockquote>{o.description}</blockquote>
      </figure>
      {o.chain.length > 0 && (
        <>
          <h4>Who stands behind it</h4>
          <ol className="chain">
            {o.chain.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ol>
        </>
      )}
      <ul className="reasons">
        {o.sentences.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>

      {!o.quoted && o.verified && (
        <form
          className="quote"
          onSubmit={(e) => {
            e.preventDefault();
            void act.run("quote", () => post("/api/courier/quote", { job: o.job, price, note }));
          }}
        >
          <div>
            <label htmlFor={`price-${o.job}`}>Your price (USDC)</label>
            <input id={`price-${o.job}`} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
          </div>
          <div className="grow">
            <label htmlFor={`note-${o.job}`}>Note</label>
            <input id={`note-${o.job}`} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <button className="primary" type="submit" disabled={act.busy !== null}>
            Send quote
          </button>
        </form>
      )}
      {o.quoted && !o.paid && <p className="status">You quoted <span className="num">{o.quoted}</span>. Waiting for the agent to pay into escrow.</p>}
      {o.paid && (
        <div className="paid">
          <p className="status">
            Paid into escrow: <span className="num">{o.paid}</span>. It's released to you when {o.confirmedBy} confirms the job.
          </p>
          {o.behind && <p className="behind">{o.behind}</p>}
          {!o.delivered && (
            <button className="primary" disabled={act.busy !== null} onClick={() => act.run("deliver", () => post("/api/courier/deliver", { job: o.job, note: "Picked up the parcel; it's at your door." }))}>
              Mark delivered
            </button>
          )}
          {o.delivered && !o.settled && <p className="status">Delivered: “{o.delivered}”. Waiting for {o.confirmedBy} to confirm.</p>}
          {o.settled && <p className="status done">You were paid <span className="num">{o.settled}</span>.</p>}
        </div>
      )}
      {act.error && (
        <p className="error" role="alert">
          {act.error}
        </p>
      )}
    </article>
  );
}
