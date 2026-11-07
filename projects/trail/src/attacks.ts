/**
 * The demo's attacks (design §15, steps 4 to 8): tampering with a saved bundle, forking the log,
 * a rogue witness, a stolen key used before and after recovery.
 */
import {
  buildTen,
  Controller,
  decode,
  fromStream,
  makeBody,
  MemoryStore,
  toStream,
  type Body,
  type Bundle,
  type LogStore,
  type Signer,
  type SignedMessage,
} from "@zk-toip/eventlog";
import { utf8 } from "@zk-toip/trust-core";
import type { Clock } from "@zk-toip/trust-core";

// ------------------------------------------------------------------ tamper (step 4)

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

function entryOf(stream: string, s: number): SignedMessage {
  const m = fromStream(stream).messages.find((x) => x.t === "ten" && x.s === s);
  if (!m) throw new Error(`no entry ${s}`);
  return m;
}

/** The same body with one field changed, and its SAID recomputed (same salt). */
function reSaid(body: Body, change: Record<string, unknown>): Body {
  const { d: _d, u, ...fields } = body;
  void _d;
  const salt = decode(String(u)).raw;
  return makeBody({ ...fields, ...change }, () => salt).body;
}

function replaceEntry(stream: string, s: number, forged: SignedMessage): string {
  const msgs = fromStream(stream).messages.map((m) => (m.t === "ten" && m.s === s ? forged : m));
  return toStream(msgs);
}

/**
 * Four ways to change the amount of entry `s` in a saved bundle, each deeper than the last.
 * `resign` is the controller's own key, for the last layer (a controller rewriting its own history).
 */
export async function tamperLayers(bundle: Bundle, s: number, change: Record<string, unknown>, resign: Signer): Promise<{ layer: number; what: string; bundle: Bundle }[]> {
  const t0 = bundle.trails[0];
  const entry = entryOf(t0.stream, s);
  const body = t0.bodies!.find((b) => b.d === entry.body.a)!;
  const out: { layer: number; what: string; bundle: Bundle }[] = [];

  // 1. edit the body only
  const b1 = clone(bundle);
  const body1 = b1.trails[0].bodies!.find((b) => b.d === body.d)!;
  Object.assign(body1, change);
  out.push({ layer: 1, what: "edit the body's amount", bundle: b1 });

  // 2. recompute the body's SAID, and put it in the header's `a`
  const body2 = reSaid(body, change);
  const b2 = clone(bundle);
  b2.trails[0].bodies = b2.trails[0].bodies!.map((b) => (b.d === body.d ? body2 : b));
  b2.trails[0].stream = t0.stream.replace(entry.raw, entry.raw.replace(String(entry.body.a), body2.d));
  out.push({ layer: 2, what: "re-hash the body and write its new digest into the header", bundle: b2 });

  // 3. recompute the header's SAID too; the old signature stays
  const { raw, body: header } = buildTen({
    trailId: entry.logId,
    s: entry.s,
    prior: String(entry.body.p),
    dt: String(entry.body.dt),
    kind: String(entry.body.k),
    bodySaid: body2.d,
    refs: entry.body.x as never,
  });
  const forged: SignedMessage = { t: "ten", raw, body: header, logId: entry.logId, s: entry.s, d: String(header.d), keyRefSig: entry.keyRefSig };
  const b3 = clone(b2);
  b3.trails[0].stream = replaceEntry(t0.stream, s, forged);
  out.push({ layer: 3, what: "re-hash the header as well, keeping the old signature", bundle: b3 });

  // 4. re-sign with the controller's real key
  const sig = (await resign.sign(utf8(raw))) as Uint8Array;
  const index = entry.keyRefSig!.sigs[0].index;
  const resigned: SignedMessage = { ...forged, keyRefSig: { ...entry.keyRefSig!, sigs: [{ code: "A", index, ondex: index, sig }] } };
  const b4 = clone(b2);
  b4.trails[0].stream = replaceEntry(t0.stream, s, resigned);
  out.push({ layer: 4, what: "re-sign the new header with Scout's own key", bundle: b4 });
  return out;
}

// ------------------------------------------------------------------ forks (steps 5, 6, 8)

/** Copies a KEL (up to `kelTo`) and a trail (up to `trailTo`), with receipts, into a new store. */
export async function copyLogs(from: LogStore, aid: string, trailId: string, opts: { trailTo: number; kelTo?: number }): Promise<MemoryStore> {
  const copy = new MemoryStore();
  const kel = (await from.all(aid)).filter((m) => opts.kelTo === undefined || m.s <= opts.kelTo);
  for (const m of [...kel, ...(await from.range(trailId, 0, opts.trailTo))]) {
    await copy.put({ ...m, cutBy: undefined, superseded: undefined });
    for (const r of await from.receipts(m.logId, m.s, m.d)) await copy.addReceipt(m.logId, m.s, m.d, r);
  }
  return copy;
}

/**
 * A controller that writes another version of the trail from entry `trailTo + 1`, with the given keys.
 * This is a controller forking its own log (or a thief with a copy of its key).
 */
export async function forkAt(from: LogStore, aid: string, trailId: string, hot: Signer[], clock: Clock, opts: { trailTo: number; kelTo?: number }): Promise<Controller> {
  const copy = await copyLogs(from, aid, trailId, opts);
  return Controller.load(aid, { hot, store: copy, clock });
}

/** The stream a controller hands someone directly: its KEL and a trail, with every receipt it holds. */
export async function handedStream(store: LogStore, aid: string, trailId: string): Promise<string> {
  let out = "";
  for (const id of [aid, trailId]) {
    for (const m of await store.range(id)) {
      out += m.raw + m.attachments;
      for (const r of await store.receipts(m.logId, m.s, m.d)) out += r.raw + r.attachments;
    }
  }
  return out;
}
