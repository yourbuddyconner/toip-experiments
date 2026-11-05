import { useState } from "react";
import type { WireRecord } from "@zk-toip/trust-core";
import type { World } from "../todo/world";

const TYPE_PREFIX = "https://zk-toip.example/spec/";

/** Long strings (signatures, sealed bytes) are cut so the decrypted view stays readable on a projector. */
function trimmed(value: unknown): unknown {
  if (typeof value === "string") return value.length > 64 ? `${value.slice(0, 60)}…` : value;
  if (Array.isArray(value)) return value.map(trimmed);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trimmed(v)]));
  return value;
}

export function WirePanel({ world }: { world: World }) {
  const [open, setOpen] = useState<number | null>(null);
  const records = [...world.bus.records()].reverse();
  const selected = records.find((r) => r.seq === open);

  return (
    <section className="wire" aria-label="The network">
      <header>
        <h2>On the network</h2>
        <p>What anyone watching sees: who sent each message to whom, when, how big, and its bytes, which are ciphertext. Select a message to see what its recipient decrypted.</p>
      </header>
      <div className="wire-body">
        <ol className="records">
          {records.slice(0, 40).map((r) => (
            <li key={r.seq}>
              <button className={r.seq === open ? "selected" : ""} onClick={() => setOpen(r.seq === open ? null : r.seq)} aria-pressed={r.seq === open}>
                <span className="who">
                  {world.nameOf(r.from)} to {world.nameOf(r.to)}
                </span>
                <span className="size">{r.bytes} bytes</span>
                <code className="bytes">{r.head}</code>
                {r.undelivered && <span className="flag">not delivered</span>}
                {r.refused && <span className="flag">refused</span>}
              </button>
            </li>
          ))}
          {records.length === 0 && <li className="empty">No messages yet.</li>}
        </ol>
        <Decrypted world={world} record={selected} />
      </div>
    </section>
  );
}

function Decrypted({ world, record }: { world: World; record: WireRecord | undefined }) {
  if (!record) return <div className="decrypted empty">Select a message.</div>;
  if (!record.opened) {
    return <div className="decrypted empty">{record.undelivered ? "This message never arrived, so nobody has opened it." : "Its recipient couldn't open it."}</div>;
  }
  const doc = record.opened.document;
  const kind = doc.type.startsWith(TYPE_PREFIX) ? doc.type.slice(TYPE_PREFIX.length) : doc.type;
  return (
    <div className="decrypted">
      <p className="only">Only {world.nameOf(record.opened.by)} can read this.</p>
      <p className="kind">{kind}</p>
      <pre>{JSON.stringify(trimmed(doc.payload), null, 2)}</pre>
    </div>
  );
}
