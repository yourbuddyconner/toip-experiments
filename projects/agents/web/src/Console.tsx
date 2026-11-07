import { useMemo, useState } from "react";
import type { AgentView, ApprovalView, AuditViewDto, ConsoleState, MandateView } from "../../src/app/types";
import { post, shortDid, time, useAction, usePoll } from "./api";

const LIMIT_NAMES: Record<string, string> = {
  spendPerTx: "Per payment",
  spendPerDay: "Per day",
  spendTotal: "In total",
  categories: "Work",
  attesters: "Confirmed by",
  arbiters: "Arbiters",
  asset: "Tokens",
  actions: "Actions",
  tasks: "Trust Tasks",
  minWindow: "Dispute window",
  "delegation depth": "Delegation depth",
  "valid until": "Valid until",
};

const DEMO_TASK = "CI is red on the demo repo; get it fixed. Also, a parcel is waiting at the Main St post office; get someone to bring it to me.";

export function Console() {
  const { data, error, refresh } = usePoll<ConsoleState>("/api/console");
  const act = useAction(refresh);
  if (!data) return <main className="loading">{error ? `The console can't reach its device: ${error}` : "Connecting to your device…"}</main>;
  const ops = data.agents.find((a) => a.name === "Ops agent");
  const waiting = data.approvals.filter((a) => a.state === "waiting");
  return (
    <>
      <a className="skip" href="#waiting">
        Skip to what's waiting for you
      </a>
      <header className="masthead">
        <div>
          <h1>Conner Swann's agents</h1>
          <p className="sub">
            Your key signs every mandate and approval. Agents act within them, or ask you.
          </p>
        </div>
        <dl className="masthead-facts">
          <div>
            <dt>Your wallet</dt>
            <dd className="num">{data.principal.wallet}</dd>
          </div>
          <div>
            <dt>Models</dt>
            <dd>{data.mode === "live" ? "Claude (live)" : "Scripted"}</dd>
          </div>
          <div>
            <dt>Identifier</dt>
            <dd className="mono" title={data.principal.did}>
              {shortDid(data.principal.did)}
            </dd>
          </div>
        </dl>
      </header>

      <Setup data={data} opsDid={ops?.did} />

      {act.error && (
        <p className="error" role="alert">
          {act.error}
        </p>
      )}

      <div className="board">
        <div className="col">
          <section aria-labelledby="agents-h" className="panel">
            <h2 id="agents-h">Agents</h2>
            <ul className="strips">
              {data.agents.map((a) => (
                <AgentStrip key={a.did} a={a} mandates={data.mandates} />
              ))}
            </ul>
          </section>
          <section aria-labelledby="mandates-h" className="panel">
            <h2 id="mandates-h">Mandates</h2>
            {data.mandates.length === 0 ? (
              <p className="empty">No mandates yet. Issue Ops agent's mandate in step 1 above.</p>
            ) : (
              <ul className="strips">
                {data.mandates.map((m) => (
                  <MandateStrip key={m.id} m={m} onRevoke={() => act.run(`revoke:${m.id}`, () => post("/api/console/revoke", { mandate: m.id }))} busy={act.busy === `revoke:${m.id}`} />
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="col">
          <section aria-labelledby="waiting-h" className="panel panel-waiting" id="waiting">
            <h2 id="waiting-h">
              Waiting for you {waiting.length + data.confirm.length > 0 && <span className="count">{waiting.length + data.confirm.length}</span>}
            </h2>
            <div aria-live="polite">
              {waiting.length === 0 && data.confirm.length === 0 && <p className="empty">Nothing needs you right now. Requests over a limit, and work you confirm, show up here.</p>}
              {waiting.map((a) => (
                <ApprovalCard key={a.request} a={a} busy={act.busy} onApprove={() => act.run(`approve:${a.request}`, () => post("/api/console/approve", { request: a.request }))} onDeny={() => act.run(`deny:${a.request}`, () => post("/api/console/deny", { request: a.request, reason: "Not now." }))} />
              ))}
              {data.confirm.map((c) => (
                <article key={c.payment} className="strip confirm" data-state="held">
                  <h3>
                    Confirm: {c.purpose}
                  </h3>
                  <p>
                    {c.payee} is paid <span className="num">{c.amount}</span> from {c.payer}'s escrow when you confirm the work is done.
                  </p>
                  <button className="primary" disabled={act.busy === `confirm:${c.payment}`} onClick={() => act.run(`confirm:${c.payment}`, () => post("/api/console/confirm", { payment: c.payment, note: "Package received." }))}>
                    Package received
                  </button>
                </article>
              ))}
            </div>
            {data.approvals.filter((a) => a.state !== "waiting").length > 0 && (
              <details className="history">
                <summary>Decided requests ({data.approvals.filter((a) => a.state !== "waiting").length})</summary>
                <ul>
                  {data.approvals
                    .filter((a) => a.state !== "waiting")
                    .map((a) => (
                      <li key={a.request}>
                        {a.state === "approved" ? "Approved" : "Denied"}: {a.fromName} paying {a.payee.name} <span className="num">{a.spend}</span>
                      </li>
                    ))}
                </ul>
              </details>
            )}
          </section>

          <RedTeam data={data} busy={act.busy === "inject"} onInject={() => act.run("inject", () => post("/api/console/inject"))} />

          <section aria-labelledby="reports-h" className="panel">
            <h2 id="reports-h">Reports from your agents</h2>
            {data.reports.length === 0 ? (
              <p className="empty">Your agents haven't reported anything yet.</p>
            ) : (
              <ol className="reports" aria-live="polite">
                {[...data.reports].reverse().map((r, i) => (
                  <li key={`${r.at}-${i}`}>
                    <span className="who">{r.name}</span> <time className="mono">{time(r.at)}</time>
                    <p>{r.text}</p>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <Activity data={data} />
        </div>
      </div>
    </>
  );
}

function Setup({ data, opsDid }: { data: ConsoleState; opsDid?: string }) {
  const act = useAction();
  const [task, setTask] = useState(DEMO_TASK);
  const s = data.setup;
  return (
    <section aria-labelledby="setup-h" className="setup">
      <h2 id="setup-h">Start Ops agent</h2>
      <ol>
        <li data-done={s.mandateIssued}>
          <p>Sign Ops agent's mandate: 30 USDC a payment, 100 a day, 200 in total, software work and errands, confirmed by CI or you, for a week.</p>
          <button className={s.mandateIssued ? "" : "primary"} disabled={s.mandateIssued || act.busy !== null} onClick={() => act.run("issue", () => post("/api/console/issue"))}>
            {s.mandateIssued ? "Mandate issued" : "Issue mandate"}
          </button>
        </li>
        <li data-done={s.funded}>
          <p>Move 150 USDC into its wallet. That balance is the most it can ever spend.</p>
          <button className={s.mandateIssued && !s.funded ? "primary" : ""} disabled={!s.mandateIssued || s.funded || act.busy !== null} onClick={() => act.run("fund", () => post("/api/console/fund", { amount: "150" }))}>
            {s.funded ? "Funded" : "Fund 150 USDC"}
          </button>
        </li>
        <li data-done={s.tasked}>
          <label htmlFor="ops-task">Give it the task</label>
          <textarea id="ops-task" rows={3} value={task} onChange={(e) => setTask(e.target.value)} disabled={s.tasked} />
          <button className={s.funded && !s.tasked ? "primary" : ""} disabled={!s.funded || s.tasked || !opsDid || act.busy !== null} onClick={() => act.run("task", () => post("/api/console/task", { agent: opsDid, text: task }))}>
            {s.tasked ? "Task sent" : "Send task"}
          </button>
        </li>
      </ol>
      {act.error && (
        <p className="error" role="alert">
          {act.error}
        </p>
      )}
    </section>
  );
}

function AgentStrip({ a, mandates }: { a: AgentView; mandates: MandateView[] }) {
  const act = useAction();
  const [task, setTask] = useState("");
  const state = a.revoked ? "refused" : a.paused ? "held" : a.running ? "cleared" : "idle";
  const status = a.revoked ? "Mandate revoked" : a.paused ? "Paused" : a.running ? "Working" : a.mandates.length ? "Idle" : "No mandate";
  const issuer = mandates.find((m) => m.id === a.mandates[a.mandates.length - 1]);
  return (
    <li className="strip agent" data-state={state} aria-label={a.name}>
      <div className="strip-head">
        <h3>{a.name}</h3>
        <span className="state">{status}</span>
      </div>
      <dl className="facts">
        <div>
          <dt>Model</dt>
          <dd className="mono">{a.model}</dd>
        </div>
        <div>
          <dt>Run by</dt>
          <dd>{a.operator}</dd>
        </div>
        <div>
          <dt>Wallet</dt>
          <dd className="num">{a.wallet}</dd>
        </div>
        <div>
          <dt>Trail</dt>
          <dd className="mono">{a.trail.entries} entries</dd>
        </div>
        {issuer && (
          <div>
            <dt>Mandate from</dt>
            <dd>{issuer.issuerName}</dd>
          </div>
        )}
      </dl>
      {a.budgets.filter((b) => b.used !== null).length > 0 && (
        <ul className="meters">
          {a.budgets
            .filter((b) => b.used !== null)
            .map((b) => (
              <li key={b.dimension}>
                <span className="meter-label">
                  Spent {b.period === "P1D" ? "today" : b.period === "total" ? "in total" : b.period}
                </span>
                <meter min={0} max={1} low={0.6} high={0.85} optimum={0.1} value={b.used ?? 0} aria-label={`${a.name} spent ${b.spent} of ${b.limit} ${b.period === "P1D" ? "today" : "in total"}`} />
                <span className="num">
                  {b.spent} of {b.limit}
                </span>
              </li>
            ))}
        </ul>
      )}
      {a.controllable && (
        <div className="controls">
          {a.paused ? (
            <button disabled={act.busy !== null} onClick={() => act.run("resume", () => post("/api/console/control", { agent: a.did, op: "resume" }))}>
              Resume {a.name}
            </button>
          ) : (
            <button disabled={act.busy !== null || !a.mandates.length} onClick={() => act.run("pause", () => post("/api/console/control", { agent: a.did, op: "pause" }))}>
              Pause {a.name}
            </button>
          )}
          <details className="task">
            <summary>Give {a.name} a task</summary>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (task.trim()) void act.run("task", async () => {
                  await post("/api/console/task", { agent: a.did, text: task });
                  setTask("");
                });
              }}
            >
              <label htmlFor={`task-${a.did}`}>Task for {a.name}</label>
              <textarea id={`task-${a.did}`} rows={2} value={task} onChange={(e) => setTask(e.target.value)} placeholder="Another errand: pick up dry cleaning on Elm St and bring it to me." />
              <button type="submit" disabled={!task.trim() || act.busy !== null}>
                Send task
              </button>
            </form>
          </details>
        </div>
      )}
      {act.error && (
        <p className="error" role="alert">
          {act.error}
        </p>
      )}
    </li>
  );
}

function MandateStrip({ m, onRevoke, busy }: { m: MandateView; onRevoke: () => void; busy: boolean }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="strip mandate" data-state={m.revoked ? "refused" : "cleared"} aria-label={`Mandate from ${m.issuerName} to ${m.subjectName}`}>
      <div className="strip-head">
        <h3>
          {m.issuerName} <span aria-hidden="true">▸</span>
          <span className="visually-hidden">to</span> {m.subjectName}
        </h3>
        <span className="state">{m.revoked ? "Revoked" : "In force"}</span>
      </div>
      <ul className="lines">
        {m.lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      {m.narrowing && m.narrowing.length > 0 && (
        <table className="narrowing">
          <caption>Narrower than its parent mandate</caption>
          <thead>
            <tr>
              <th scope="col">Limit</th>
              <th scope="col">Parent</th>
              <th scope="col">This mandate</th>
            </tr>
          </thead>
          <tbody>
            {m.narrowing.map((r) => (
              <tr key={r.dimension}>
                <th scope="row">{LIMIT_NAMES[r.dimension] ?? r.dimension}</th>
                <td className="num">{r.parent}</td>
                <td className="num">{r.child}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mono small" title={m.id}>
        {m.id}
      </p>
      {!m.revoked &&
        (confirming ? (
          <div className="confirm-row" role="group" aria-label="Confirm revocation">
            <p>
              Revoke {m.subjectName}'s mandate? {m.parent ? `${m.issuerName}'s guard revokes it, since it issued it. ` : ""}Its guard refuses every action from then on, and workers see it within the hour.
            </p>
            <button className="danger" disabled={busy} onClick={onRevoke}>
              Confirm revoke
            </button>
            <button onClick={() => setConfirming(false)}>Keep it</button>
          </div>
        ) : (
          <button className="danger-outline" onClick={() => setConfirming(true)}>
            Revoke {m.subjectName}'s mandate
          </button>
        ))}
    </li>
  );
}

function ApprovalCard({ a, busy, onApprove, onDeny }: { a: ApprovalView; busy: string | null; onApprove: () => void; onDeny: () => void }) {
  return (
    <article className="strip approval" data-state="held" aria-labelledby={`req-${a.request}`}>
      <h3 id={`req-${a.request}`}>
        {a.fromName} asks to pay {a.payee.name} <span className="num">{a.spend}</span>
      </h3>
      <p className="small">Shown from the signed action, not from the agent's description.</p>
      <dl className="ticket">
        <div>
          <dt>Payee</dt>
          <dd>
            {a.payee.name} <span className="mono small" title={a.payee.did}>{shortDid(a.payee.did)}</span>
            {a.payee.credentials.length ? <span className="badge ok">{a.payee.credentials.join(", ")}</span> : <span className="badge warn">No verified credentials</span>}
          </dd>
        </div>
        <div>
          <dt>Amount</dt>
          <dd className="num">
            {a.price} + {a.fee} fee = {a.spend}
          </dd>
        </div>
        <div>
          <dt>For</dt>
          <dd>{a.purpose}</dd>
        </div>
        <div>
          <dt>Category</dt>
          <dd className="mono">{a.category}</dd>
        </div>
        <div>
          <dt>Confirmed by</dt>
          <dd>{a.attester}</dd>
        </div>
        <div>
          <dt>Arbiter</dt>
          <dd>{a.arbiter}</dd>
        </div>
        <div>
          <dt>Dispute window</dt>
          <dd>{a.disputeWindowDays} days</dd>
        </div>
      </dl>
      <h4>Why it needs you</h4>
      <ul className="reasons">
        {a.sentences.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
      <figure className="untrusted">
        <figcaption>In the agent's words (not checked)</figcaption>
        <blockquote>{a.justification || "The agent gave no reason."}</blockquote>
      </figure>
      <p className="small mono" title={a.actionHash}>
        Your approval signs {a.actionHash.slice(0, 23)}…, this action only, once.
      </p>
      <div className="decide">
        <button className="primary" disabled={busy !== null} onClick={onApprove}>
          Approve {a.spend}
        </button>
        <button disabled={busy !== null} onClick={onDeny}>
          Deny
        </button>
      </div>
    </article>
  );
}

function RedTeam({ data, busy, onInject }: { data: ConsoleState; busy: boolean; onInject: () => void }) {
  const r = data.injection;
  return (
    <section aria-labelledby="redteam-h" className="panel">
      <h2 id="redteam-h">Test the guard</h2>
      <p>
        QuickFix's quote names itself to confirm the work, asks 150 USDC, and its note tells the model it was pre-approved. A model may ignore it. A compromised one wouldn't.
      </p>
      <button className="danger-outline" disabled={!data.quickfixQuote || busy} onClick={onInject}>
        Send QuickFix's quote straight to the guard
      </button>
      {!data.quickfixQuote && <p className="small">Available once QuickFix has quoted.</p>}
      <div aria-live="polite">
        {r && (
          <div className="strip result" data-state={r.status === "refused" ? "refused" : "held"}>
            <h3>The guard: {r.status === "refused" ? "refused" : r.status}</h3>
            <ul className="reasons">
              {r.sentences.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
            <p>{r.approvalRequested ? "An approval request was sent to you." : "No approval request was sent to you: one of the reasons can't be approved."}</p>
          </div>
        )}
      </div>
    </section>
  );
}

const FILTERS: { key: string; label: string; test: (e: AuditViewDto["entries"][number]) => boolean }[] = [
  { key: "all", label: "Everything", test: () => true },
  { key: "decisions", label: "Mandate decisions", test: (e) => e.kind === "agent/mandate-decision" },
  { key: "money", label: "Money", test: (e) => e.tone === "money" },
  { key: "refusals", label: "Refusals", test: (e) => e.tone === "refuse" },
  { key: "approvals", label: "Approvals", test: (e) => e.kind.startsWith("agent/approval") },
  { key: "tools", label: "Tool calls", test: (e) => e.kind === "agent/tool-call" || e.kind === "agent/tool-result" },
  { key: "model", label: "Model turns", test: (e) => e.kind === "agent/model-turn" || e.kind.startsWith("agent/session") },
];

function Activity({ data }: { data: ConsoleState }) {
  const act = useAction();
  const reviewable = data.agents.filter((a) => a.controllable);
  const [agent, setAgent] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const shown = data.audits.find((x) => x.agent === (agent ?? data.audits[0]?.agent));
  const entries = useMemo(() => (shown ? shown.entries.filter(FILTERS.find((f) => f.key === filter)!.test) : []), [shown, filter]);
  return (
    <section aria-labelledby="activity-h" className="panel">
      <h2 id="activity-h">Activity</h2>
      <p>Your agents' trails are signed and receipted by your witness and the hub. Reviewing one asks the agent for every entry's body and checks the whole chain.</p>
      <div className="controls">
        {reviewable.map((a) => (
          <button
            key={a.did}
            disabled={act.busy !== null}
            onClick={() =>
              act.run(`review:${a.did}`, async () => {
                await post("/api/console/review", { agent: a.did });
                setAgent(a.did);
              })
            }
          >
            {act.busy === `review:${a.did}` ? `Reviewing ${a.name}…` : `Review ${a.name}'s trail`}
          </button>
        ))}
      </div>
      {act.error && (
        <p className="error" role="alert">
          {act.error}
        </p>
      )}
      {data.audits.length > 1 && (
        <div className="tabs" role="group" aria-label="Whose trail">
          {data.audits.map((x) => (
            <button key={x.agent} aria-pressed={x.agent === shown?.agent} onClick={() => setAgent(x.agent)}>
              {x.name}
            </button>
          ))}
        </div>
      )}
      {shown && (
        <div className="audit">
          <p className={`banner ${shown.ok ? "ok" : "bad"}`} role="status">
            <strong>{shown.name}:</strong> {shown.banner}
          </p>
          {shown.problems.length > 0 && (
            <ul className="reasons">
              {shown.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          <div className="audit-tools">
            <label htmlFor="audit-filter">Show</label>
            <select id="audit-filter" value={filter} onChange={(e) => setFilter(e.target.value)}>
              {FILTERS.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
            <a href={`/api/console/export/${encodeURIComponent(shown.agent)}`} download>
              Export {shown.name}'s trail for a dispute
            </a>
            <span className="small">Checked at {time(shown.at)}</span>
          </div>
          <ol className="timeline" aria-label={`${shown.name}'s trail`}>
            {entries.map((e) => (
              <li key={e.s} data-tone={e.tone}>
                <span className="mono s">#{e.s}</span>
                <time className="mono">{time(e.dt)}</time>
                <span className="summary">{e.summary}</span>
                <span className="receipts small">{e.receipts.length ? `receipted by ${e.receipts.join(" and ")}` : e.status === "pending" ? "not yet receipted" : ""}</span>
              </li>
            ))}
            {entries.length === 0 && <li className="empty">No entries of this kind.</li>}
          </ol>
        </div>
      )}
    </section>
  );
}
