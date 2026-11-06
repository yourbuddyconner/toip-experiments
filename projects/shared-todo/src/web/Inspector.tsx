import { useState } from "react";
import type { Device, InspectorEntry } from "../todo/device";

type Tab = "activity" | "identity" | "relay" | "refused";

const short = (did: string) => (did.startsWith("did:key:") ? `${did.slice(8, 16)}…${did.slice(-4)}` : did);
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Trims signatures and sealed bytes so a decrypted message stays readable. */
function trimmed(value: unknown): unknown {
  if (typeof value === "string") return value.length > 72 ? `${value.slice(0, 68)}…` : value;
  if (Array.isArray(value)) return value.length > 12 ? [...value.slice(0, 12).map(trimmed), `…${value.length - 12} more`] : value.map(trimmed);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trimmed(v)]));
  return value;
}

export function Inspector({ device, listDid }: { device: Device; listDid: string | null }) {
  const [tab, setTab] = useState<Tab>("activity");
  const [open, setOpen] = useState<number | null>(null);
  const log = [...device.inspector()].map((e, i) => ({ e, i })).reverse();
  const v = listDid ? device.view(listDid) : undefined;

  return (
    <aside className="inspector" aria-label="What's happening on this device">
      <header>
        <h2>What's happening</h2>
        <p>Only what this device sent, received and decided.</p>
      </header>
      <div className="tabs" role="tablist">
        {(
          [
            ["activity", "Activity"],
            ["identity", "Identity"],
            ["relay", "What the relay sees"],
            ["refused", "Refused"],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "activity" && (
        <ol className="log">
          {log.map(({ e, i }) => (
            <li key={i} className={e.kind}>
              {e.kind === "traffic" ? (
                <>
                  <button className="row" onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}>
                    <span className="dir">{e.direction === "out" ? "Sent" : "Received"}</span> {e.type} {e.direction === "out" ? "to" : "from"} {e.peerName}
                    <span className="meta">
                      {time(e.at)} · {e.bytes} bytes{e.delivery ? ` · ${e.delivery}` : ""}
                    </span>
                  </button>
                  {open === i && (
                    <pre>{JSON.stringify(trimmed(e.payload), null, 2)}</pre>
                  )}
                </>
              ) : (
                <p className={e.result.startsWith("accepted") ? "ok" : "bad"}>
                  {e.summary} from {e.authorName}: {e.result}
                  <span className="meta">{time(e.at)}</span>
                </p>
              )}
            </li>
          ))}
          {log.length === 0 && <li className="empty">Nothing yet.</li>}
        </ol>
      )}

      {tab === "identity" && (
        <dl className="identity">
          <dt>This device</dt>
          <dd>
            {device.name}
            <code>{device.did}</code>
          </dd>
          <dt>Relay</dt>
          <dd>
            <code>{device.relayUrl}</code>
          </dd>
          {v && (
            <>
              <dt>{v.name}</dt>
              <dd>
                The list's own key: <code>{v.did}</code>
              </dd>
              <dt>Your membership</dt>
              <dd>{v.membership ? <pre>{JSON.stringify(trimmed(v.membership), null, 2)}</pre> : "None yet."}</dd>
              <dt>Roster</dt>
              <dd>
                Version {v.rosterVersion}, signed by the list's key. {v.members.length} people, {v.members.filter((m) => m.removed).length} removed.
              </dd>
            </>
          )}
        </dl>
      )}

      {tab === "relay" && (
        <>
          <p className="note">The relay passes on sealed messages. For each one it learns only this much:</p>
          <table className="relay-view">
            <thead>
              <tr>
                <th>From</th>
                <th>To</th>
                <th>When</th>
                <th>Size</th>
              </tr>
            </thead>
            <tbody>
              {log
                .filter((x): x is { e: Extract<InspectorEntry, { kind: "traffic" }>; i: number } => x.e.kind === "traffic")
                .map(({ e, i }) => (
                  <tr key={i}>
                    <td>{e.direction === "out" ? short(device.did) : short(e.peer)}</td>
                    <td>{e.direction === "out" ? short(e.peer) : short(device.did)}</td>
                    <td>{time(e.at)}</td>
                    <td>{e.bytes} B</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </>
      )}

      {tab === "refused" && (
        <ul className="refused-list">
          {device
            .lists()
            .flatMap((l) => device.view(l.did)?.refused.map((r) => ({ ...r, list: l.name })) ?? [])
            .reverse()
            .map((r, n) => (
              <li key={n}>
                <strong>{r.list}</strong>: {r.summary} from {r.authorName}
                {r.viaName ? ` (passed on by ${r.viaName})` : ""}: {r.reason}
              </li>
            ))}
        </ul>
      )}
    </aside>
  );
}
