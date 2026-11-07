/**
 * Version strings, fixed-order serialization, SAIDs, and JCS bodies.
 * Serialization matches Python's json.dumps(sad, separators=(",", ":"), ensure_ascii=False).
 */
import { canonicalJson, utf8 } from "@zk-toip/trust-core";
import { digest, encode, isQb64 } from "./cesr";
import type { Body, MessageType, Problem, Qb64 } from "./types";
import { problem } from "./types";

export type Protocol = "KERI" | "ZKTR";

const DUMMY = "#".repeat(44);

export const FIELDS: Record<MessageType, readonly string[]> = {
  icp: ["v", "t", "d", "i", "s", "kt", "k", "nt", "n", "bt", "b", "c", "a"],
  rot: ["v", "t", "d", "i", "s", "p", "kt", "k", "nt", "n", "bt", "br", "ba", "a"],
  ixn: ["v", "t", "d", "i", "s", "p", "a"],
  rct: ["v", "t", "d", "i", "s"],
  tin: ["v", "t", "d", "i", "s", "ci", "dt", "m"],
  ten: ["v", "t", "d", "i", "s", "p", "dt", "k", "a", "x"],
  tcl: ["v", "t", "d", "i", "s", "p", "dt"],
  trc: ["v", "t", "d", "i", "s", "dt"],
};

export const PROTOCOL: Record<MessageType, Protocol> = {
  icp: "KERI",
  rot: "KERI",
  ixn: "KERI",
  rct: "KERI",
  tin: "ZKTR",
  ten: "ZKTR",
  tcl: "ZKTR",
  trc: "ZKTR",
};

/** Which fields hold the message's own SAID. Receipts name another message's SAID. */
export const SAID_FIELDS: Record<MessageType, ("d" | "i")[]> = {
  icp: ["d", "i"],
  rot: ["d"],
  ixn: ["d"],
  rct: [],
  tin: ["d", "i"],
  ten: ["d"],
  tcl: ["d"],
  trc: [],
};

export function versionString(protocol: Protocol, size: number): string {
  if (size >= 0x1000000) throw new Error("message too big");
  return `${protocol}10JSON${size.toString(16).padStart(6, "0")}_`;
}

const byteLength = (s: string) => utf8(s).length;

/** Serializes fields in their insertion order. */
export function serialize(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

/** Fills the version string and SAID fields. `fields` must list every field in order. */
export function saidify<T extends Record<string, unknown>>(
  protocol: Protocol,
  fields: T,
  saidFields: ("d" | "i")[],
): { raw: string; body: T } {
  const body: Record<string, unknown> = { ...fields, v: versionString(protocol, 0) };
  for (const f of saidFields) body[f] = DUMMY;
  body.v = versionString(protocol, byteLength(serialize(body)));
  if (saidFields.length) {
    const said = digest(serialize(body));
    for (const f of saidFields) body[f] = said;
  }
  const raw = serialize(body);
  return { raw, body: body as T };
}

/** Builds a message of type `t` from its fields (without `v`, `t`, or SAID values). */
export function buildMessage(t: MessageType, fields: Record<string, unknown>): { raw: string; body: Record<string, unknown> } {
  const ordered: Record<string, unknown> = {};
  for (const f of FIELDS[t]) {
    if (f === "v") ordered.v = "";
    else if (f === "t") ordered.t = t;
    else if (SAID_FIELDS[t].includes(f as "d" | "i")) ordered[f] = "";
    else {
      if (!(f in fields)) throw new Error(`${t} needs field ${f}`);
      ordered[f] = fields[f];
    }
  }
  return saidify(PROTOCOL[t], ordered, SAID_FIELDS[t]);
}

const VERSION_1 = /^(KERI|ZKTR)10JSON([0-9a-f]{6})_$/;
const VERSION_ANY_1 = /^([A-Z]{4})([0-9a-f])([0-9a-f])([A-Z]{4})([0-9a-f]{6})_$/;
const VERSION_2 = /^[A-Z]{4}[A-Za-z0-9_-]{3}[A-Za-z0-9_-]{3}[A-Z]{4}[A-Za-z0-9_-]{4}\.$/;

export interface ParsedMessage {
  t: MessageType;
  protocol: Protocol;
  raw: string;
  body: Record<string, unknown>;
}

/** Reads the version string at the start of `head` (raw JSON text). */
export function readVersion(head: string): { ok: true; size: number; protocol: Protocol } | { ok: false; problem: Problem } {
  const m = /^\{"v":"([^"]{17,19})"/.exec(head);
  if (!m) return { ok: false, problem: problem("badVersion", "message does not start with a version string") };
  const vs = m[1];
  if (VERSION_1.test(vs)) {
    const r = VERSION_1.exec(vs)!;
    return { ok: true, size: parseInt(r[2], 16), protocol: r[1] as Protocol };
  }
  if (VERSION_ANY_1.test(vs) || VERSION_2.test(vs))
    return { ok: false, problem: problem("unsupported", `unsupported version string ${vs}`) };
  return { ok: false, problem: problem("badVersion", `bad version string ${vs}`) };
}

const HEX = /^(0|[1-9a-f][0-9a-f]*)$/;
const SUPPORTED_TYPES = new Set(Object.keys(FIELDS));

export function hexNumber(v: unknown): number | undefined {
  if (typeof v !== "string" || !HEX.test(v) || v.length > 13) return undefined;
  return parseInt(v, 16);
}

/**
 * Parses raw message text: version, size, type, exact field order, canonical form, and SAID.
 * Never throws.
 */
export function parseMessage(raw: string): { ok: true; msg: ParsedMessage } | { ok: false; problem: Problem } {
  const v = readVersion(raw);
  if (!v.ok) return v;
  if (byteLength(raw) !== v.size) return { ok: false, problem: problem("badVersion", `size ${byteLength(raw)} does not match version string ${v.size}`) };
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, problem: problem("badFields", "not JSON") };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, problem: problem("badFields", "not an object") };
  const t = body.t;
  const logId = typeof body.i === "string" ? body.i : undefined;
  const s = hexNumber(body.s);
  if (typeof t !== "string" || !SUPPORTED_TYPES.has(t)) return { ok: false, problem: problem("unsupported", `unsupported message type ${String(t)}`, logId, s) };
  const type = t as MessageType;
  if (PROTOCOL[type] !== v.protocol) return { ok: false, problem: problem("badVersion", `${type} with protocol ${v.protocol}`, logId, s) };
  const keys = Object.keys(body);
  const want = FIELDS[type];
  if (keys.length !== want.length || keys.some((k, i) => k !== want[i]))
    return { ok: false, problem: problem("badFields", `${type} fields must be ${want.join(",")}`, logId, s) };
  if (serialize(body) !== raw) return { ok: false, problem: problem("badFields", "raw bytes are not canonical", logId, s) };
  if (s === undefined) return { ok: false, problem: problem("badFields", "s must be lowercase hex", logId) };
  let saidFields = SAID_FIELDS[type];
  // a basic-prefix inception (i is a key, not a SAID) has only d dummied; it is parsed so it can be rejected as unsupported
  if (type === "icp" && typeof body.i === "string" && body.i.length > 0 && body.i[0] !== "E") saidFields = ["d"];
  if (saidFields.length) {
    const copy: Record<string, unknown> = { ...body };
    for (const f of saidFields) copy[f] = DUMMY;
    const said = digest(serialize(copy));
    for (const f of saidFields) {
      if (body[f] !== said) return { ok: false, problem: problem("saidMismatch", `${f} is not the message's SAID`, logId, s) };
    }
  } else if (!isQb64(body.d, ["E"])) {
    return { ok: false, problem: problem("badFields", "d must be a Blake3 SAID", logId, s) };
  }
  return { ok: true, msg: { t: type, protocol: v.protocol, raw, body } };
}

// ---- bodies

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

function bodySaid(body: Record<string, unknown>): Qb64 {
  return digest(canonicalJson({ ...body, d: DUMMY }));
}

/** Makes a body: adds a random salt `u` and its SAID `d`. Serialized with JCS. */
export function makeBody(fields: Record<string, unknown>, random: (n: number) => Uint8Array = randomBytes): { body: Body; said: Qb64; raw: string } {
  if ("d" in fields || "u" in fields) throw new Error("body fields d and u are reserved");
  const draft: Record<string, unknown> = { d: DUMMY, u: encode("0A", random(16)), ...fields };
  const said = bodySaid(draft);
  const body = { ...draft, d: said } as Body;
  return { body, said, raw: canonicalJson(body) };
}

export function checkBody(body: Body): boolean {
  try {
    return typeof body.d === "string" && bodySaid(body) === body.d && isQb64(body.u, ["0A"]);
  } catch {
    return false;
  }
}

export function bodySaidOf(body: Record<string, unknown>): Qb64 {
  return bodySaid(body);
}
