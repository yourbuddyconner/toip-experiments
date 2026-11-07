// Acme Chemicals' People Operations console: the roster, the membership group and its daily signed
// lists, and, because Acme operates the relay in this demo, what the relay records. Acme is the
// adversary in Tipline's threat model; this console shows everything it can see.
import { useEffect, useState } from "react";
import type { GroupRoot } from "@toip-tools/anon-membership";
import type { MemberView } from "../../../src/agents/issuer";
import type { MirrorStatus } from "../../../src/agents/mirror";
import { getJson, longDate, postJson, shortDid, shortHex } from "../common/net";
import { Field, Notice, useAction, useTick } from "../common/ui";

interface AcmeState {
  org: string;
  label: string;
  did: string;
  group: string;
  today: string;
  members: MemberView[];
  log: GroupRoot[];
  mirror: MirrorStatus;
  cheating: { target: string; name?: string; epoch: string } | null;
  relay: string;
}

interface RelayView {
  url: string;
  messages: { id: number; from: string; to: string; bytes: number; at: number; delivery: string; fromName: string | null; toName: string | null }[];
  queued: { to: string; toName: string | null; n: number }[];
}

type Tab = "people" | "lists" | "relay" | "search";

export function App() {
  const [s, setS] = useState<AcmeState | null>(null);
  const [tab, setTab] = useState<Tab>(() => (location.hash.slice(1) as Tab) || "people");
  const [err, setErr] = useState<string | null>(null);
  const load = () => getJson<AcmeState>("/api/acme").then(setS, (e) => setErr(e.message));
  useEffect(() => void load(), []);
  useTick(() => void load(), 2500);
  const go = (t: Tab) => {
    setTab(t);
    history.replaceState(null, "", `#${t}`);
  };
  if (err && !s) return <p className="error">{err}</p>;
  if (!s) return <p className="loading">Loading…</p>;
  const enrolled = s.members.filter((m) => m.index !== undefined && m.status === "active").length;
  const tabs: [Tab, string][] = [
    ["people", "Employees"],
    ["lists", "Member lists"],
    ["relay", "Relay"],
    ["search", "What we know"],
  ];
  return (
    <div className="acme">
      <header className="acme-bar">
        <div className="logo" aria-hidden="true">
          <span />
        </div>
        <div>
          <p className="org">{s.org}</p>
          <p className="dept">People Operations</p>
        </div>
        <DevClock today={s.today} onMoved={load} />
      </header>
      <nav className="tabs" aria-label="Sections">
        {tabs.map(([t, name]) => (
          <button key={t} className={tab === t ? "tab current" : "tab"} aria-current={tab === t ? "page" : undefined} onClick={() => go(t)}>
            {name}
          </button>
        ))}
      </nav>
      <main id="main" className="acme-main">
        {tab === "people" && <People s={s} enrolled={enrolled} onChange={load} />}
        {tab === "lists" && <Lists s={s} onChange={load} />}
        {tab === "relay" && <Relay />}
        {tab === "search" && <Search s={s} />}
      </main>
    </div>
  );
}

function DevClock({ today, onMoved }: { today: string; onMoved: () => void }) {
  const a = useAction();
  return (
    <div className="devclock">
      <span>
        Demo clock: <strong>{longDate(today)}</strong>
      </span>
      <button className="secondary" disabled={a.busy} onClick={() => a.run(async () => { await postJson("/api/clock/advance", { days: 1 }); onMoved(); })}>
        Skip ahead a day
      </button>
      {a.error && <span className="error">{a.error}</span>}
    </div>
  );
}

function People({ s, enrolled, onChange }: { s: AcmeState; enrolled: number; onChange: () => void }) {
  const [name, setName] = useState("");
  const [did, setDid] = useState("");
  const [showSeeded, setShowSeeded] = useState(false);
  const add = useAction();
  const rm = useAction();
  const people = s.members.filter((m) => showSeeded || !m.seeded);
  return (
    <>
      <section className="card">
        <h1>Employees</h1>
        <p className="stat">
          <strong>{enrolled}</strong> of {s.members.filter((m) => m.status === "active").length} employees are enrolled in the {s.label} group.
        </p>
        <p className="muted">
          An employee enrolls from their own wallet. The wallet sends us a commitment: we see which employee it belongs to, but never the secret behind it. That pairing is all the
          membership system ever tells us about anyone.
        </p>
      </section>
      <section className="card">
        <h2>Add an employee</h2>
        <p className="muted">Ask the employee for the ID their wallet shows.</p>
        <div className="add-row">
          <Field label="Name">{(id) => <input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label="Wallet ID">{(id) => <input id={id} value={did} onChange={(e) => setDid(e.target.value)} placeholder="did:key:z6Mk…" />}</Field>
          <button
            disabled={add.busy || !name.trim() || !did.trim()}
            onClick={() =>
              add.run(async () => {
                await postJson("/api/acme/employees", { name, did });
                setName("");
                setDid("");
                onChange();
              })
            }
          >
            Add employee
          </button>
        </div>
        {add.error && <p className="error">{add.error}</p>}
      </section>
      <section className="card">
        <div className="card-head">
          <h2>Roster</h2>
          <label className="check">
            <input type="checkbox" checked={showSeeded} onChange={(e) => setShowSeeded(e.target.checked)} />
            <span>Show the {s.members.filter((m) => m.seeded).length} employees added by the demo's seeding script</span>
          </label>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Wallet ID</th>
                <th>Leaf</th>
                <th>Commitment</th>
                <th>Status</th>
                <th>
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {people.map((m) => (
                <tr key={m.did} data-name={m.name}>
                  <td>{m.name}</td>
                  <td>
                    <code title={m.did}>{shortDid(m.did)}</code>
                  </td>
                  <td>{m.index ?? "–"}</td>
                  <td>{m.commitment ? <code title={m.commitment}>{shortHex(m.commitment)}</code> : <span className="muted">not enrolled</span>}</td>
                  <td>{m.status === "left" ? <span className="pill left">Left</span> : m.index !== undefined ? <span className="pill in">Enrolled</span> : <span className="pill">Invited</span>}</td>
                  <td>
                    {m.status === "active" && !m.seeded && (
                      <button className="quiet" disabled={rm.busy} onClick={() => rm.run(async () => { await postJson("/api/acme/remove", { did: m.did }); onChange(); })}>
                        Remove {m.name}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function Lists({ s, onChange }: { s: AcmeState; onChange: () => void }) {
  const pub = useAction();
  const cheat = useAction();
  const head = s.log.at(-1);
  const publishedToday = head?.epoch === s.today;
  const [open, setOpen] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const real = s.members.filter((m) => !m.seeded && m.index !== undefined);
  return (
    <>
      <section className="card">
        <h1>Member lists</h1>
        <p className="muted">
          Once a day we sign the group's Merkle root: one list per day, each pointing to the one before. Anyone can fetch the list and the members' commitments, so an employee can count
          how many people they hide among.
        </p>
        <div className="row">
          <button disabled={pub.busy || publishedToday} onClick={() => pub.run(async () => { await postJson("/api/acme/publish", {}); onChange(); })}>
            {publishedToday ? "Today's list is published" : "Publish today's list"}
          </button>
          <span className="muted small">After the first, a list is published each day on its own.</span>
        </div>
        {pub.error && <p className="error">{pub.error}</p>}
        <p className="small muted">
          The Ledger's mirror: {s.mirror.ok ? `holds the list of ${s.mirror.head?.epoch}` : s.mirror.reason}
          {s.mirror.tampered ? ". It is serving our second list." : "."}
        </p>
      </section>
      <section className="card">
        <h2>Signed lists</h2>
        {s.log.length === 0 ? (
          <p className="muted">Nothing published yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Number</th>
                  <th>Members</th>
                  <th>Root</th>
                  <th>Snapshot hash</th>
                  <th>
                    <span className="visually-hidden">Document</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {s.log
                  .slice()
                  .reverse()
                  .map((r) => (
                    <tr key={r.id} data-epoch={r.epoch}>
                      <td>{longDate(r.epoch)}</td>
                      <td>{r.seq}</td>
                      <td>{r.size}</td>
                      <td>
                        <code>{shortHex(r.root)}</code>
                      </td>
                      <td>
                        <code>{shortHex(r.snapshotHash)}</code>
                      </td>
                      <td>
                        <button className="quiet" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
                          {open === r.id ? "Hide document" : "Show signed document"}
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
        {open && <pre data-testid="root-doc">{JSON.stringify(s.log.find((r) => r.id === open), null, 2)}</pre>}
      </section>
      <section className="card cheat">
        <h2>Single someone out</h2>
        <p className="muted">
          The attack the design guards against: sign a second list for today holding only one employee and 59 made-up members, and get The Ledger's web host to serve it. If the
          employee then tips, the proof would point to them.
        </p>
        {s.cheating ? (
          <Notice kind="warn" title={`The Ledger's mirror is serving a second list for ${longDate(s.cheating.epoch)}`}>
            <p>Built around {s.cheating.name ?? shortDid(s.cheating.target)}.</p>
            <button className="danger" disabled={cheat.busy} onClick={() => cheat.run(async () => { await postJson("/api/acme/cheat/stop", {}); onChange(); })}>
              Stop
            </button>
          </Notice>
        ) : (
          <div className="add-row">
            <Field label="Employee">
              {(id) => (
                <select id={id} value={target} onChange={(e) => setTarget(e.target.value)}>
                  <option value="">Choose…</option>
                  {real.map((m) => (
                    <option key={m.did} value={m.did}>
                      {m.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <button className="danger" disabled={!target || !head || cheat.busy} onClick={() => cheat.run(async () => { await postJson("/api/acme/cheat", { did: target }); onChange(); })}>
              Sign a second list and put it on the mirror
            </button>
          </div>
        )}
        {cheat.error && <p className="error">{cheat.error}</p>}
      </section>
    </>
  );
}

function Relay() {
  const [r, setR] = useState<RelayView | null>(null);
  const load = () => void getJson<RelayView>("/api/relay").then(setR, () => {});
  useEffect(load, []);
  useTick(load, 2000);
  if (!r) return <p className="loading">Loading…</p>;
  const name = (did: string, n: string | null) => (n ? <span title={did}>{n}</span> : <code title={did}>{shortDid(did)}</code>);
  return (
    <section className="card">
      <h1>Relay</h1>
      <p className="muted">
        Acme runs the TSP relay at <code>{r.url}</code>. This is everything it records about each message: who sent it to whom, when, and how big it was. The contents are sealed.
        Senders we can't name are keys we've never seen.
      </p>
      <div className="table-wrap">
        <table data-testid="relay-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>From</th>
              <th>To</th>
              <th>Size</th>
              <th>Delivered</th>
            </tr>
          </thead>
          <tbody>
            {r.messages
              .slice()
              .reverse()
              .map((m) => (
                <tr key={m.id} data-from={m.from} data-to={m.to} data-bytes={m.bytes}>
                  <td>{new Date(m.at).toISOString().slice(11, 19)}</td>
                  <td>{name(m.from, m.fromName)}</td>
                  <td>{name(m.to, m.toName)}</td>
                  <td className="num">{m.bytes.toLocaleString("en-US")} bytes</td>
                  <td>{m.delivery === "live" ? "at once" : "queued"}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Search({ s }: { s: AcmeState }) {
  const [q, setQ] = useState("");
  const [out, setOut] = useState<{ query: string; places: { where: string; found: boolean; detail: string }[] } | null>(null);
  const a = useAction();
  return (
    <section className="card">
      <h1>What we know</h1>
      <p className="muted">
        Search everything Acme holds: the roster and group, the signed lists, the relay's records and its database of queued messages. Try an employee's wallet ID, their commitment,
        or a nullifier a reporter shows you.
      </p>
      <div className="add-row">
        <Field label="Search for">{(id) => <input id={id} value={q} onChange={(e) => setQ(e.target.value)} />}</Field>
        <button disabled={!q.trim() || a.busy} onClick={() => a.run(async () => setOut(await postJson("/api/acme/search", { q })))}>
          Search
        </button>
      </div>
      {a.error && <p className="error">{a.error}</p>}
      {out && (
        <table className="results" data-testid="search-results">
          <tbody>
            {out.places.map((p) => (
              <tr key={p.where} data-found={p.found}>
                <th scope="row">{p.where}</th>
                <td className={p.found ? "found" : "none"}>{p.found ? `Found: ${p.detail}` : "Not found"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="small muted">
        Group <code>{shortDid(s.group)}</code>
      </p>
    </section>
  );
}
