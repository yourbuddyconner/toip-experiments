import { useState } from "react";
import { isRevokedIn } from "@zk-toip/trust-core";
import type { Role } from "../todo/checks";
import type { MemberAgent } from "../todo/member";
import type { World } from "../todo/world";

export type PersonKey = "alice" | "bob" | "carol" | "mallory";
type Perform = (fn: () => Promise<unknown> | unknown) => Promise<void>;

const short = (did: string) => `${did.slice(8, 16)}…${did.slice(-4)}`;

export function PersonPane({ world, who, free, perform }: { world: World; who: PersonKey; free: boolean; perform: Perform }) {
  const me = world.people[who];
  const s = me.snapshot();
  const others = (Object.keys(world.people) as PersonKey[]).filter((k) => k !== who).map((k) => world.people[k]);
  const revoked = (m: { membership: { credentialStatus?: { statusListIndex: number } } }) =>
    s.status && m.membership.credentialStatus ? isRevokedIn(s.status, m.membership.credentialStatus.statusListIndex) : false;
  const iAmRevoked = s.membership ? revoked({ membership: s.membership }) : false;

  return (
    <section className="note" data-person={who} aria-label={`${me.name}'s phone`}>
      <header className="note-head">
        <h2>{me.name}</h2>
        <span className="role">{iAmRevoked ? "removed" : (s.role ?? "not a member")}</span>
        <span className={`online ${s.online ? "on" : "off"}`}>{s.online ? "online" : "offline"}</span>
      </header>
      <p className="did" title={me.did}>
        {short(me.did)}
      </p>

      <div className="list">
        <h3>{s.list?.name ?? "No list yet"}</h3>
        {s.list && s.items.length === 0 && <p className="empty">Nothing on the list.</p>}
        <ul>
          {s.items.map((i) => (
            <li key={i.id} className={`${i.checked ? "checked" : ""} ${i.locked ? "locked" : ""}`}>
              <span className="box" aria-hidden="true">
                {i.checked ? "✓" : ""}
              </span>
              <span className="text">
                {i.locked ? (
                  <>
                    🔒 Private item by {me.nameOf(i.author)}
                    <small>Readable by {i.readers?.map((r) => me.nameOf(r)).join(" and ")}</small>
                  </>
                ) : (
                  <>
                    {i.text}
                    {i.readers && <small>🔒 Private: {i.readers.map((r) => me.nameOf(r)).join(" and ")}</small>}
                  </>
                )}
              </span>
              {free && s.list && <ItemActions me={me} itemId={i.id} checked={i.checked} others={others} perform={perform} />}
            </li>
          ))}
        </ul>
      </div>

      {s.rejected.length > 0 && (
        <div className="refused">
          <h3>Refused on this phone</h3>
          <ul>
            {[...s.rejected].reverse().map((r) => (
              <li key={`${r.opId}-${r.at}`}>
                <span className="what">{r.summary}</span>
                <span className="why">
                  {r.reason}. From {me.nameOf(r.author)}
                  {r.via ? `, forwarded by ${me.nameOf(r.via)}` : ""}.
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {s.lastError && <p className="last-error">{s.lastError}</p>}

      {free && <FreePlay me={me} world={world} who={who} others={others} perform={perform} />}

      <details>
        <summary>Credentials I hold</summary>
        {s.membership ? (
          <dl>
            <dt>Membership</dt>
            <dd>
              {s.role} of {s.list?.name}, issued by the list's key {short(s.membership.issuer)}, revocation slot{" "}
              {s.membership.credentialStatus?.statusListIndex}
            </dd>
            {s.acknowledgement && (
              <>
                <dt>My acknowledgement</dt>
                <dd>Signed by me, sent to {me.nameOf(s.members.find((m) => m.role === "admin")?.did ?? "")}</dd>
              </>
            )}
          </dl>
        ) : (
          <p>None.</p>
        )}
      </details>
      <details>
        <summary>Who I know</summary>
        <ul className="members">
          {s.members.map((m) => (
            <li key={m.did}>
              {m.name}, {m.role}
              {revoked(m) ? ", removed" : ""}
              {m.acknowledged ? ", acknowledged" : ""}
            </li>
          ))}
          {s.members.length === 0 && <li>Nobody yet.</li>}
        </ul>
      </details>
    </section>
  );
}

function ItemActions({ me, itemId, checked, others, perform }: { me: MemberAgent; itemId: string; checked: boolean; others: MemberAgent[]; perform: Perform }) {
  const op = me.state.allOps().find((o) => o.itemId === itemId && o.kind === "add");
  return (
    <span className="item-actions">
      <button onClick={() => void perform(() => (checked ? me.uncheck(itemId) : me.check(itemId)))}>{checked ? "Uncheck" : "Check off"}</button>
      <button
        onClick={() => {
          const text = window.prompt("New text");
          if (text) void perform(() => me.edit(itemId, text));
        }}
      >
        Edit
      </button>
      <button onClick={() => void perform(() => me.remove(itemId))}>Delete</button>
      {op && (
        <select
          aria-label="Forward a tampered copy to"
          value=""
          onChange={(e) => {
            const to = e.target.value;
            if (to) void perform(() => me.forwardTampered(op.id, `${op.text ?? "item"} (tampered)`, to));
          }}
        >
          <option value="">Tamper and forward to…</option>
          {others.map((o) => (
            <option key={o.did} value={o.did}>
              {o.name}
            </option>
          ))}
        </select>
      )}
    </span>
  );
}

function FreePlay({ me, world, who, others, perform }: { me: MemberAgent; world: World; who: PersonKey; others: MemberAgent[]; perform: Perform }) {
  const [text, setText] = useState("");
  const [readers, setReaders] = useState<string[]>([]);
  const [priv, setPriv] = useState(false);
  const s = me.snapshot();
  const isAdmin = s.role === "admin";

  return (
    <div className="free">
      {s.list && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            const t = text.trim();
            setText("");
            void perform(() => me.add(t, priv ? readers : undefined));
          }}
        >
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add an item" aria-label={`${me.name}: add an item`} />
          <button type="submit">Add</button>
          <label>
            <input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} /> Private
          </label>
          {priv &&
            others
              .filter((o) => s.members.some((m) => m.did === o.did))
              .map((o) => (
                <label key={o.did}>
                  <input
                    type="checkbox"
                    checked={readers.includes(o.did)}
                    onChange={(e) => setReaders((r) => (e.target.checked ? [...r, o.did] : r.filter((x) => x !== o.did)))}
                  />{" "}
                  {o.name} can read
                </label>
              ))}
        </form>
      )}
      <div className="actions">
        <label>
          <input type="checkbox" checked={me.sendAnyway} onChange={(e) => void perform(() => (me.sendAnyway = e.target.checked))} /> Send changes even if refused here
        </label>
        <button onClick={() => void perform(() => me.setOnline(!me.online))}>{me.online ? "Go offline" : "Come back online"}</button>
        {who === "alice" && !s.list && <button onClick={() => void perform(() => me.createList("Maple St House"))}>Create the list</button>}
        {isAdmin &&
          others
            .filter((o) => !o.list)
            .map((o) => (
              <span key={o.did} className="invite">
                {(["editor", "viewer"] as Role[]).map((role) => (
                  <button key={role} onClick={() => void perform(() => o.scan(me.invite(role)))}>
                    {o.name} scans an {role} invitation
                  </button>
                ))}
              </span>
            ))}
        {isAdmin &&
          s.members
            .filter((m) => m.did !== me.did)
            .map((m) => (
              <button key={m.did} onClick={() => void perform(() => me.revoke(m.did))}>
                Remove {m.name}
              </button>
            ))}
        {s.list &&
          others
            .filter((o) => s.members.some((m) => m.did === o.did))
            .map((o) => (
              <button key={o.did} onClick={() => void perform(() => me.syncFrom(o.did))}>
                Catch up from {o.name}
              </button>
            ))}
        {who === "mallory" && world.people.bob.membership && world.people.alice.list && (
          <button
            onClick={() =>
              void perform(() =>
                me.sneakIn({
                  list: world.people.alice.list!.did,
                  targets: [world.people.alice.did, world.people.bob.did, world.people.carol.did],
                  membership: world.people.bob.membership!,
                  text: "Let Mallory in",
                }),
              )
            }
          >
            Add an item using Bob's credential
          </button>
        )}
      </div>
    </div>
  );
}
