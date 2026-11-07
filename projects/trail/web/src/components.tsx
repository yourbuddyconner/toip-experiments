import { useState, type ReactNode } from "react";
import type { Check, EntryView, IdentifierView, KelEventView, KeyStateView, ProblemView, TrailView } from "../../src/view";

/** The verdict, as a rubber stamp. */
export function Stamp({ tone, children, big }: { tone: "valid" | "pending" | "cut" | "bad" | "warn" | "quiet"; children: ReactNode; big?: boolean }) {
  return <span className={`stamp stamp-${tone}${big ? " stamp-big" : ""}`}>{children}</span>;
}

export function entryTone(e: EntryView): "valid" | "pending" | "cut" | "bad" {
  if (e.status === "valid") return e.duplicity ? "bad" : "valid";
  if (e.status === "pending") return "pending";
  if (e.status === "cut") return "cut";
  return "bad";
}

/** A digest or AID, shortened, with the whole value on hover and for screen readers. */
export function Hash({ value, n = 10 }: { value: string; n?: number }) {
  if (!value) return <span className="hash">none</span>;
  const s = value.length > n + 4 ? `${value.slice(0, n)}…` : value;
  return (
    <code className="hash" title={value} aria-label={value}>
      {s}
    </code>
  );
}

export const time = (iso?: string) => (iso ? iso.slice(11, 23) : "");

const EPOCHS = 6;
export const epochClass = (estSn: number, states: { estSn: number }[]) => {
  const i = states.findIndex((s) => s.estSn === estSn);
  return i < 0 ? "epoch-none" : `epoch-${i % EPOCHS}`;
};

const MARK: Record<Check["result"], string> = { pass: "✓", fail: "✗", warn: "!", info: "i" };
const WORD: Record<Check["result"], string> = { pass: "passes", fail: "fails", warn: "warning", info: "note" };

export function Checks({ checks }: { checks: Check[] }) {
  return (
    <ul className="checks">
      {checks.map((c, i) => (
        <li key={i} className={`check check-${c.result}`}>
          <span className="check-mark" aria-label={WORD[c.result]}>
            {MARK[c.result]}
          </span>
          <span className="check-label">{c.label}</span>
          <span className="check-detail">{c.detail}</span>
        </li>
      ))}
    </ul>
  );
}

export function Problems({ problems, empty }: { problems: ProblemView[]; empty?: string }) {
  if (!problems.length) return empty ? <p className="quiet">{empty}</p> : null;
  return (
    <ul className="problems">
      {problems.map((p, i) => (
        <li key={i}>
          <code className="code">{p.code}</code>
          {p.s !== undefined ? <span className="at"> at entry {p.s}</span> : null}
          <span className="problem-message">: {p.message}.</span>
          <span className="problem-why"> {p.explanation}</span>
        </li>
      ))}
    </ul>
  );
}

/** Key states over time: one segment per establishment event. */
export function KeyTimeline({ states }: { states: KeyStateView[] }) {
  return (
    <ol className="timeline" aria-label="Key states over time">
      {states.map((st, i) => (
        <li key={st.estSn} className={`epoch ${epochClass(st.estSn, states)}${st.current ? " epoch-current" : ""}`}>
          <h4>
            Key state {st.estSn}
            <span className="epoch-span">{st.current ? `from KEL ${st.estSn}, current` : `KEL ${st.estSn} to ${st.retiredAt}`}</span>
          </h4>
          <dl>
            <dt>Keys</dt>
            <dd>
              {st.keys.map((k) => (
                <span key={k.id} className="key" title={k.id}>
                  {k.name}
                </span>
              ))}
              <span className="thr">signs with {st.kt}</span>
            </dd>
            <dt>Next</dt>
            <dd>
              {st.next.length} digest{st.next.length === 1 ? "" : "s"}, {st.nt} to rotate
            </dd>
            <dt>Witnesses</dt>
            <dd>
              {st.witnesses.map((w) => w.name).join(", ") || "none"}
              <span className="thr">{st.bt} must receipt</span>
            </dd>
          </dl>
          {i < states.length - 1 ? <span className="sr-only">then</span> : null}
        </li>
      ))}
    </ol>
  );
}

export function KelTable({ events, states }: { events: KelEventView[]; states: KeyStateView[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <table className="ledger kel">
      <caption className="sr-only">Key event log</caption>
      <thead>
        <tr>
          <th scope="col">KEL</th>
          <th scope="col">Event</th>
          <th scope="col">Verdict</th>
          <th scope="col">What it does</th>
          <th scope="col">Witness receipts</th>
        </tr>
      </thead>
      <tbody>
        {events.map((e) => {
          const est = [...states].reverse().find((s) => s.estSn <= e.s);
          const sup = e.status === "superseded";
          return (
            <tr key={e.d} className={`${est ? epochClass(est.estSn, states) : ""}${sup ? " struck" : ""}`}>
              <td className="num">{e.s}</td>
              <td>
                <button type="button" className="linkish" aria-expanded={open === e.d} onClick={() => setOpen(open === e.d ? null : e.d)}>
                  {e.t}
                </button>{" "}
                <Hash value={e.d} n={8} />
                {open === e.d ? <pre className="raw">{e.raw}</pre> : null}
              </td>
              <td>
                <Stamp tone={sup ? "cut" : e.status === "valid" ? "valid" : e.status === "pending" ? "pending" : "bad"}>
                  {sup ? "superseded" : e.status === "valid" ? `valid ${e.receipts.length}/${est?.witnesses.length ?? e.receipts.length}` : e.status}
                </Stamp>
              </td>
              <td className="notes">
                <span className="notes-text">{e.notes.length ? e.notes.join("; ") : e.t === "icp" ? "inception" : "no seals"}</span>
                {sup ? <span className="why"> Superseded by the recovery rotation at the same place (KERI rule A0).</span> : null}
              </td>
              <td className="receipts">
                {e.receipts.map((r) => (
                  <span key={r.id} className="receipt" title={r.dt ? `${r.name} at ${r.dt}` : r.name}>
                    {r.name.replace("Witness ", "W")}
                    {r.dt ? <small> {time(r.dt)}</small> : null}
                  </span>
                ))}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** A trail's entries, in order, coloured by epoch. Each row opens its entry sheet. */
export function Ledger({ trail, states, selected, onSelect }: { trail: TrailView; states: KeyStateView[]; selected?: string; onSelect: (e: EntryView) => void }) {
  return (
    <table className="ledger trail">
      <caption className="sr-only">Trail {trail.purpose}</caption>
      <thead>
        <tr>
          <th scope="col">Entry</th>
          <th scope="col">Verdict</th>
          <th scope="col">Kind</th>
          <th scope="col">Claimed / first witnessed</th>
          <th scope="col">Anchored</th>
        </tr>
      </thead>
      <tbody>
        {trail.entries.map((e, i) => {
          const id = `${e.s}:${e.d || i}`;
          const struck = e.status === "cut" || e.status === "rejected";
          return (
            <tr key={id} className={`${epochClass(e.epoch, states)}${struck ? " struck" : ""}${selected === id ? " selected" : ""}${e.flags.length ? " flagged" : ""}`}>
              <td className="num">{e.s}</td>
              <td>
                <Stamp tone={entryTone(e)}>{e.status === "valid" && e.duplicity ? "duplicity" : e.chip}</Stamp>
                {e.status === "valid" && e.duplicity ? <span className="sub">{e.chip}</span> : null}
              </td>
              <td>
                <button type="button" className="linkish entry-open" aria-pressed={selected === id} onClick={() => onSelect(e)} aria-label={`Entry ${e.s}, ${e.kind}, ${e.status}`}>
                  {e.kind}
                </button>
                {e.flags.length ? <span className="flag" title={e.flags.join(" ")}> policy</span> : null}
                {e.endorsements.length ? <span className="endorse" title={e.endorsements.map((x) => x.name).join(", ")}> endorsed</span> : null}
              </td>
              <td className="times">
                {time(e.dt)}
                {e.earliestReceipt ? <span className="sub"> / {time(e.earliestReceipt)}</span> : null}
              </td>
              <td className="num">{e.status === "cut" ? `cut by KEL ${e.cutBy}` : e.anchoredBy !== undefined ? `KEL ${e.anchoredBy}` : ""}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function EntrySheet({ entry, onClose }: { entry: EntryView; onClose: () => void }) {
  return (
    <aside className="sheet" aria-labelledby="sheet-title">
      <header>
        <h3 id="sheet-title" tabIndex={-1}>
          Entry {entry.s}: {entry.kind}
        </h3>
        <button type="button" className="close" onClick={onClose} aria-label="Close the entry">
          ×
        </button>
      </header>
      <p className="verdict">
        <Stamp tone={entryTone(entry)} big>
          {entry.status === "valid" && entry.duplicity ? "duplicity" : entry.chip}
        </Stamp>
        <span>{entry.explanation}</span>
      </p>
      <h4>Checks</h4>
      <Checks checks={entry.checks} />
      {entry.receipts.length ? (
        <>
          <h4>Witness receipts</h4>
          <ul className="plain">
            {entry.receipts.map((r) => (
              <li key={r.id}>
                {r.name} signed it at {r.dt}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <h4>Header</h4>
      <pre className="raw">{pretty(entry.raw)}</pre>
      {entry.body ? (
        <>
          <h4>Body, as disclosed</h4>
          <pre className="raw">{JSON.stringify(entry.body.json, null, 2)}</pre>
        </>
      ) : null}
    </aside>
  );
}

function pretty(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** The KEL, key states, and trails of one identifier, with an entry sheet. */
export function IdentifierBody({ view }: { view: IdentifierView }) {
  const [sel, setSel] = useState<{ id: string; entry: EntryView } | null>(null);
  return (
    <>
      <section aria-labelledby="ks">
        <h3 id="ks">Key state over time</h3>
        <KeyTimeline states={view.states} />
      </section>
      <section aria-labelledby="kel">
        <h3 id="kel">Key event log</h3>
        <div className="scroll">
          <KelTable events={view.kel} states={view.states} />
        </div>
      </section>
      {view.trails.map((t) => (
        <section key={t.id} aria-labelledby={`t-${t.id}`} className="trail-section">
          <h3 id={`t-${t.id}`}>
            Trail {t.purpose} <Hash value={t.id} n={8} />
          </h3>
          <p className="quiet">
            {t.entries.filter((e) => e.status === "valid").length} valid, {t.entries.filter((e) => e.status === "cut").length} cut, {t.evidence.length} duplicity finding{t.evidence.length === 1 ? "" : "s"}. Head: entry {t.head?.s ?? "none"}.
            Pick an entry to see every check.
          </p>
          <div className={`ledger-wrap${sel ? " with-sheet" : ""}`}>
            <div className="scroll">
            <Ledger
              trail={t}
              states={view.states}
              selected={sel?.id}
              onSelect={(e) => {
                const id = `${e.s}:${e.d || t.entries.indexOf(e)}`;
                setSel(sel?.id === id ? null : { id, entry: e });
                requestAnimationFrame(() => document.getElementById("sheet-title")?.focus());
              }}
            />
            </div>
            {sel && t.entries.some((e) => `${e.s}:${e.d || t.entries.indexOf(e)}` === sel.id) ? <EntrySheet entry={sel.entry} onClose={() => setSel(null)} /> : null}
          </div>
          {t.problems.length ? (
            <details className="problems-box">
              <summary>
                {t.problems.length} problem{t.problems.length === 1 ? "" : "s"} found in this trail
              </summary>
              <Problems problems={t.problems} />
            </details>
          ) : null}
        </section>
      ))}
    </>
  );
}
