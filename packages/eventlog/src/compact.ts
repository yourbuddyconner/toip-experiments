/**
 * Compact binary form (trail design §7.8), as deterministic CBOR. Lossless: the receiver rebuilds the exact JSON and checks the SAID.
 * Signatures are always over the JSON, so there is one signing form.
 *
 * - toCompact / fromCompact: one self-contained message with its attachments.
 * - toCompactLog / fromCompactLog: a whole log, leaving out what its position gives (i, s, p and the SAID), with receipts.
 */
import { decode as cborDecode, encode as cborEncode } from "cborg";
import { decode, DUAL_CODES, encode } from "./cesr.js";
import { isDigestSeal, isEventSeal } from "./kel.js";
import { buildMessage, FIELDS, hexNumber } from "./said.js";
import { ISO_MS } from "./trail.js";
import type { Couple, IndexedSig, IndexedSigCode, KeyRefSig, MessageType, Qb64, SignedMessage } from "./types.js";

const TYPES: MessageType[] = ["icp", "rot", "ixn", "rct", "tin", "ten", "tcl", "trc"];
const PRIM_CODES = ["D", "B", "E", "I", "1AAJ", "1AAI", "0A", "0B", "0I"];
const SIG_CODES: IndexedSigCode[] = ["A", "B", "2A", "2B", "E", "F", "2E", "2F"];
const HEX_FIELDS = new Set(["s", "kt", "nt", "bt"]);
const PRIM_FIELDS = new Set(["d", "i", "p", "ci"]);
const PRIM_LISTS = new Set(["n", "b", "br", "ba"]);
const SEAL_LISTS = new Set(["a", "x"]);

function prim(q: Qb64): Uint8Array | string {
  const { code, raw } = decode(q);
  const i = PRIM_CODES.indexOf(code);
  if (i < 0) return q;
  const out = new Uint8Array(raw.length + 1);
  out[0] = i;
  out.set(raw, 1);
  return out;
}

function unprim(v: unknown): Qb64 {
  if (typeof v === "string") return v;
  if (!(v instanceof Uint8Array) || v.length < 1) throw new Error("bad primitive");
  const code = PRIM_CODES[v[0]];
  if (!code) throw new Error("bad primitive code");
  return encode(code, v.slice(1));
}

function anchor(a: unknown): unknown {
  if (isDigestSeal(a)) return prim(a.d);
  if (isEventSeal(a)) return [prim(a.i), hexNumber(a.s)!, prim(a.d)];
  return JSON.stringify(a);
}

function unanchor(v: unknown): unknown {
  if (v instanceof Uint8Array) return { d: unprim(v) };
  if (Array.isArray(v)) return { i: unprim(v[0]), s: Number(v[1]).toString(16), d: unprim(v[2]) };
  if (typeof v === "string") return JSON.parse(v);
  throw new Error("bad anchor");
}

function time(dt: string): number | string {
  if (ISO_MS.test(dt)) {
    const ms = Date.parse(dt);
    if (!Number.isNaN(ms) && new Date(ms).toISOString() === dt) return ms;
  }
  return dt;
}

function untime(v: unknown): string {
  return typeof v === "number" ? new Date(v).toISOString() : String(v);
}

function field(name: string, value: unknown, t: MessageType): unknown {
  if (HEX_FIELDS.has(name)) return hexNumber(value)!;
  if (PRIM_FIELDS.has(name)) return prim(String(value));
  if (name === "k" && t === "ten") return value;
  if (name === "k" || PRIM_LISTS.has(name)) return (value as Qb64[]).map(prim);
  if (name === "a" && t === "ten") return value === "" ? null : prim(String(value));
  if (SEAL_LISTS.has(name)) return (value as unknown[]).map(anchor);
  if (name === "dt") return time(String(value));
  return value; // c (traits), m
}

function unfield(name: string, v: unknown, t: MessageType): unknown {
  if (HEX_FIELDS.has(name)) {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new Error(`bad ${name}`);
    return v.toString(16);
  }
  if (PRIM_FIELDS.has(name)) return unprim(v);
  if (name === "k" && t === "ten") return String(v);
  if (name === "k" || PRIM_LISTS.has(name)) return (v as unknown[]).map(unprim);
  if (name === "a" && t === "ten") return v === null ? "" : unprim(v);
  if (SEAL_LISTS.has(name)) return (v as unknown[]).map(unanchor);
  if (name === "dt") return untime(v);
  if (name === "c") return (v as unknown[]).map(String);
  return String(v);
}

function sig(s: IndexedSig): unknown[] {
  const out: unknown[] = [SIG_CODES.indexOf(s.code), s.index];
  if (s.code.length === 2 && DUAL_CODES.has(s.code)) out.push(s.ondex ?? s.index);
  out.push(s.sig);
  if (s.wrap) out.push([s.wrap.authenticatorData, s.wrap.clientDataJSON]);
  return out;
}

function unsig(v: unknown): IndexedSig {
  const a = v as unknown[];
  const code = SIG_CODES[a[0] as number];
  if (!code) throw new Error("bad signature code");
  const index = a[1] as number;
  let i = 2;
  const out: IndexedSig = { code, index, sig: new Uint8Array() };
  if (code.length === 2 && DUAL_CODES.has(code)) out.ondex = a[i++] as number;
  else if (DUAL_CODES.has(code)) out.ondex = index;
  out.sig = a[i++] as Uint8Array;
  if (!(out.sig instanceof Uint8Array) || out.sig.length !== 64) throw new Error("bad signature");
  const w = a[i] as Uint8Array[] | undefined;
  if (w) out.wrap = { authenticatorData: w[0], clientDataJSON: w[1] };
  return out;
}

function attachments(m: SignedMessage): unknown[] {
  const att: unknown[] = [
    m.controllerSigs?.length ? m.controllerSigs.map(sig) : null,
    m.witnessSigs?.length ? m.witnessSigs.map(sig) : null,
    m.keyRefSig ? [prim(m.keyRefSig.aid), m.keyRefSig.estSn, prim(m.keyRefSig.estSaid), m.keyRefSig.sigs.map(sig)] : null,
    m.couples?.length ? m.couples.map((c) => [prim(c.signer), c.sig]) : null,
  ];
  while (att.length && att[att.length - 1] === null) att.pop();
  return att;
}

function unattach(m: SignedMessage, att: unknown[]): void {
  const [c, w, k, cp] = att as (unknown[] | null | undefined)[];
  if (c) m.controllerSigs = c.map(unsig);
  if (w) m.witnessSigs = w.map(unsig);
  if (k) m.keyRefSig = { aid: unprim(k[0]), estSn: k[1] as number, estSaid: unprim(k[2]), sigs: (k[3] as unknown[]).map(unsig) } satisfies KeyRefSig;
  if (cp) m.couples = cp.map((x) => ({ signer: unprim((x as unknown[])[0]), sig: (x as unknown[])[1] as Uint8Array }) satisfies Couple);
}

function rebuild(t: MessageType, fields: Record<string, unknown>, expectD?: Qb64): SignedMessage {
  const { raw, body } = buildMessage(t, fields);
  const d = String(body.d);
  if (expectD !== undefined && d !== expectD) throw new Error("saidMismatch: the rebuilt message's SAID does not match");
  return { t, raw, body, logId: String(body.i), s: parseInt(String(body.s), 16), d };
}

const SAID_OWN = new Set<MessageType>(["icp", "rot", "ixn", "tin", "ten", "tcl"]);

export function toCompact(msg: SignedMessage): Uint8Array {
  const names = FIELDS[msg.t].slice(2);
  const values = names.map((n) => field(n, msg.body[n], msg.t));
  return cborEncode([TYPES.indexOf(msg.t), values, attachments(msg)]);
}

/** Rebuilds the exact JSON and checks the SAID. Throws on bad input. */
export function fromCompact(bytes: Uint8Array): SignedMessage {
  const [ti, values, att] = cborDecode(bytes, { strict: true }) as [number, unknown[], unknown[]];
  const t = TYPES[ti];
  if (!t || !Array.isArray(values)) throw new Error("not a compact message");
  const names = FIELDS[t].slice(2);
  if (values.length !== names.length) throw new Error("wrong field count");
  const fields: Record<string, unknown> = {};
  names.forEach((n, i) => (fields[n] = unfield(n, values[i], t)));
  const m = rebuild(t, fields, SAID_OWN.has(t) ? String(fields.d) : undefined);
  if (!SAID_OWN.has(t)) {
    // receipts name another message's SAID; rebuild with the given d
    if (m.d !== fields.d) throw new Error("bad receipt");
  }
  unattach(m, att ?? []);
  return m;
}

// ---- whole logs

const DERIVED = new Set(["d", "i", "s", "p"]);

/**
 * A whole log in compact form: its trunk messages in order, with their witness signatures,
 * and for trails each entry's receipts as [witness, dt, signature]. Fields given by position are left out.
 */
export function toCompactLog(messages: SignedMessage[], receipts: SignedMessage[] = []): Uint8Array {
  if (!messages.length) throw new Error("empty log");
  const logId = messages[0].logId;
  const entries = messages.map((m, idx) => {
    if (m.s !== idx || m.logId !== logId) throw new Error("toCompactLog takes a trunk: s 0, 1, 2… of one log");
    const names = FIELDS[m.t].slice(2).filter((n) => !DERIVED.has(n));
    const rs = receipts
      .filter((r) => r.t === "trc" && r.s === m.s && r.d === m.d)
      .flatMap((r) => (r.couples ?? []).map((c) => [prim(c.signer), time(String(r.body.dt)), c.sig]));
    const e: unknown[] = [TYPES.indexOf(m.t), names.map((n) => field(n, m.body[n], m.t)), attachments(m)];
    if (rs.length) e.push(rs);
    return e;
  });
  return cborEncode([1, prim(logId), entries]);
}

export function fromCompactLog(bytes: Uint8Array): { messages: SignedMessage[]; receipts: SignedMessage[] } {
  const [version, id, entries] = cborDecode(bytes, { strict: true }) as [number, unknown, unknown[][]];
  if (version !== 1 || !Array.isArray(entries)) throw new Error("not a compact log");
  const logId = unprim(id);
  const messages: SignedMessage[] = [];
  const receipts: SignedMessage[] = [];
  entries.forEach((e, s) => {
    const t = TYPES[e[0] as number];
    if (!t) throw new Error("bad type");
    const names = FIELDS[t].slice(2).filter((n) => !DERIVED.has(n));
    const values = e[1] as unknown[];
    if (values.length !== names.length) throw new Error("wrong field count");
    const fields: Record<string, unknown> = { s: s.toString(16) };
    if (t !== "icp" && t !== "tin") {
      fields.i = logId;
      if (t !== "rct" && t !== "trc") fields.p = messages[s - 1]?.d;
    }
    names.forEach((n, i) => (fields[n] = unfield(n, values[i], t)));
    const m = rebuild(t, fields);
    if ((t === "icp" || t === "tin") && m.d !== logId) throw new Error("saidMismatch: the inception's SAID is not the log id");
    unattach(m, (e[2] as unknown[]) ?? []);
    messages.push(m);
    for (const r of (e[3] as unknown[][] | undefined) ?? []) {
      const dt = untime(r[1]);
      const { raw, body } = buildMessage("trc", { d: m.d, i: logId, s: s.toString(16), dt });
      receipts.push({ t: "trc", raw, body, logId, s, d: m.d, couples: [{ signer: unprim(r[0]), sig: r[2] as Uint8Array }] });
    }
  });
  return { messages, receipts };
}
