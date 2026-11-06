import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { Role } from "../todo/checks";
import type { Device, ListView as View } from "../todo/device";
import { Dialog } from "./App";

export function ListView({ device, listDid, inviteBase }: { device: Device; listDid: string; inviteBase: string }) {
  const v = device.view(listDid);
  const [text, setText] = useState("");
  const [priv, setPriv] = useState(false);
  const [readers, setReaders] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [members, setMembers] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [showRefused, setShowRefused] = useState(false);
  if (!v) return null;

  const run = (p: Promise<unknown>) => {
    setError("");
    p.catch((e) => setError(friendly(String(e?.message ?? e))));
  };
  const others = v.members.filter((m) => !m.isMe && !m.removed);
  const canEdit = v.role === "admin" || v.role === "editor";

  if (v.pending) {
    return (
      <section className="list">
        <h1>{v.name}</h1>
        {v.pending.refused ? (
          <p className="banner warn">{v.pending.inviterName}'s device didn't let you in: {v.pending.refused}</p>
        ) : (
          <p className="banner">Waiting for {v.pending.inviterName}'s device to let you in. It will happen the next time their app is open; you can close this one meanwhile.</p>
        )}
        <button className="ghost" onClick={() => run(device.leave(listDid))}>
          Forget this list
        </button>
      </section>
    );
  }

  return (
    <section className="list">
      <header className="list-head">
        <h1>{v.name}</h1>
        <span className="role-tag">{v.removed ? "you were removed" : v.role}</span>
        <button className="ghost" onClick={() => setMembers(true)}>
          People ({v.members.filter((m) => !m.removed).length})
        </button>
      </header>

      {v.removed && <p className="banner warn">You were removed from this list. You still have your copy, but nobody will accept changes from you.</p>}

      {canEdit && !v.removed && (
        <form
          className="add"
          onSubmit={(e) => {
            e.preventDefault();
            const t = text.trim();
            if (!t) return;
            setText("");
            run(device.add(listDid, t, priv ? readers : undefined));
            setPriv(false);
            setReaders([]);
          }}
        >
          <input aria-label="New item" autoComplete="off" data-1p-ignore value={text} onChange={(e) => setText(e.target.value)} placeholder="Add an item" />
          <button type="submit" className="primary">
            Add
          </button>
          {others.length > 0 && (
            <label className="private-toggle">
              <input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} /> Private
            </label>
          )}
          {priv && (
            <fieldset className="readers">
              <legend>Who else can read it</legend>
              {others.map((m) => (
                <label key={m.did}>
                  <input
                    type="checkbox"
                    checked={readers.includes(m.did)}
                    onChange={(e) => setReaders((r) => (e.target.checked ? [...r, m.did] : r.filter((x) => x !== m.did)))}
                  />{" "}
                  {m.name}
                </label>
              ))}
            </fieldset>
          )}
        </form>
      )}
      {v.role === "viewer" && !v.removed && <p className="hint">You can see this list but not change it.</p>}
      {error && <p className="form-error">{error}</p>}

      <ul className="items">
        {v.items.map((i) => (
          <li key={i.id} className={`${i.checked ? "done" : ""} ${i.locked ? "locked" : ""}`}>
            <input
              type="checkbox"
              checked={i.checked}
              disabled={!canEdit || v.removed || i.locked}
              aria-label={i.locked ? "Private item" : `Done: ${i.text}`}
              onChange={(e) => run(device.setChecked(listDid, i.id, e.target.checked))}
            />
            {editing === i.id ? (
              <form
                className="edit"
                onSubmit={(e) => {
                  e.preventDefault();
                  const t = String(new FormData(e.currentTarget).get("t") ?? "").trim();
                  setEditing(null);
                  if (t && t !== i.text) run(device.edit(listDid, i.id, t));
                }}
              >
                <input name="t" defaultValue={i.text} autoFocus aria-label="Edit item" />
              </form>
            ) : (
              <span className="text" onDoubleClick={() => canEdit && !i.locked && setEditing(i.id)}>
                {i.locked ? <>Private item from {i.authorName}</> : i.text}
                {i.private && <small>{i.locked ? "You're not one of its readers" : `Private: ${i.readerNames?.join(", ")}`}</small>}
              </span>
            )}
            {canEdit && !v.removed && !i.locked && (
              <span className="row-actions">
                <button className="ghost" onClick={() => setEditing(i.id)}>
                  Edit
                </button>
                <button className="ghost" onClick={() => run(device.remove(listDid, i.id))}>
                  Delete
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {v.items.length === 0 && <p className="empty">{canEdit ? "Nothing here yet." : "Nothing on this list yet."}</p>}

      {v.refused.length > 0 && (
        <div className="refusals">
          <button className="link" onClick={() => setShowRefused((x) => !x)}>
            {v.refused.length} change{v.refused.length === 1 ? " was" : "s were"} refused on this device
          </button>
          {showRefused && (
            <ul>
              {[...v.refused].reverse().map((r, n) => (
                <li key={n}>
                  {r.verified ? (
                    <>
                      A change from {r.authorName}
                      {r.viaName ? `, passed on by ${r.viaName},` : ""} ({r.summary}) was refused: {friendly(r.reason)}.
                    </>
                  ) : (
                    <>
                      {r.fromName ?? "Someone"} sent a change claiming to be from {r.authorName}. It was refused: {friendly(r.reason)}.
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {members && <MembersSheet device={device} v={v} inviteBase={inviteBase} onClose={() => setMembers(false)} />}
    </section>
  );
}

function MembersSheet({ device, v, inviteBase, onClose }: { device: Device; v: View; inviteBase: string; onClose: () => void }) {
  const [role, setRole] = useState<Role>("editor");
  const [link, setLink] = useState("");
  const [qr, setQr] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!link) return;
    QRCode.toDataURL(link, { margin: 1, width: 220 })
      .then(setQr)
      .catch(() => setQr(""));
  }, [link]);

  return (
    <Dialog title={`People in ${v.name}`} onClose={onClose}>
      <ul className="people">
        {v.members.map((m) => (
          <li key={m.did} className={m.removed ? "removed" : ""}>
            <span>
              {m.name}
              {m.isMe ? " (you)" : ""}
            </span>
            <span className="muted">{m.removed ? "removed" : m.role}</span>
            {v.isAdmin && !m.isMe && !m.removed && (
              <button
                className="ghost"
                onClick={() =>
                  confirm(`Remove ${m.name} from ${v.name}? Their changes from now on will be refused. You can invite them again later.`) &&
                  device.removeMember(v.did, m.did).catch((e) => setError(String(e?.message ?? e)))
                }
              >
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      {v.isAdmin ? (
        <div className="invite">
          <h3>Invite someone</h3>
          <div className="invite-row">
            <select value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Role">
              <option value="editor">Can edit</option>
              <option value="viewer">Can only view</option>
            </select>
            <button
              className="primary"
              onClick={() => {
                try {
                  setLink(`${inviteBase}#invite=${device.invite(v.did, role)}`);
                } catch (e) {
                  setError(String((e as Error).message));
                }
              }}
            >
              Make an invitation
            </button>
          </div>
          {link && (
            <div className="invite-out">
              {qr && <img src={qr} alt="Invitation QR code" width={180} height={180} />}
              <div>
                <input readOnly value={link} aria-label="Invitation link" onFocus={(e) => e.currentTarget.select()} />
                <button onClick={() => navigator.clipboard?.writeText(link)}>Copy link</button>
                <p className="hint">Works once, for 7 days. Anyone who opens it first can use it, so send it only to the person you mean.</p>
              </div>
            </div>
          )}
        </div>
      ) : (
        !v.removed && (
          <button
            className="ghost danger"
            onClick={() =>
              confirm(`Leave ${v.name}? You'll need a new invitation to come back.`) && device.leave(v.did).then(onClose, (e) => setError(String(e?.message ?? e)))
            }
          >
            Leave this list
          </button>
        )
      )}
      {error && <p className="form-error">{error}</p>}
    </Dialog>
  );
}

/** Turns a check's reason into a sentence for people. */
export function friendly(reason: string): string {
  const roles: Record<string, string> = { viewer: "viewers", editor: "editors", admin: "admins" };
  const m = reason.match(/^(viewer|editor|admin) may not (\w+)$/);
  if (m) return `${roles[m[1]]} can't ${m[2] === "add" ? "add items" : m[2] === "delete" ? "delete that item" : `${m[2]} items`}`;
  const map: Record<string, string> = {
    "membership revoked": "they were removed from the list",
    "not a member": "they aren't a member of this list",
    "credential is for someone else": "they used someone else's membership",
    "operation: signature does not verify": "it was altered after it was signed",
    "not from its author": "it didn't come from the person who wrote it",
    "not a reader of this item": "they can't read that private item",
    "no such item": "the item it changes doesn't exist here",
    "from the future": "its time is too far ahead",
    "malformed operation": "it was malformed",
    "for a different list": "it was for a different list",
    "duplicate operation id": "it clashes with an earlier change",
    "not from a current member": "it was passed on by someone no longer in the list",
  };
  return map[reason] ?? reason;
}
