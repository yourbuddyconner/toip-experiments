/**
 * KERI 1.0 key event logs: event builders, key state, and verification (trail design §11.1).
 * Supported: non-delegated self-addressing AIDs, Ed25519 and P-256 keys, integer thresholds, traits [] or ["DND"].
 */
import { utf8 } from "@toip-tools/trust-core";
import { DUAL_CODES, decode, isQb64, nextKeyDigest } from "./cesr";
import { verifyCouple, verifyKeySig, type SigOptions } from "./keys";
import { buildMessage, hexNumber } from "./said";
import type { LogStore } from "./store";
import { fromStream } from "./stream";
import type { Clock } from "@toip-tools/trust-core";
import type { DuplicityEvidence, IndexedSig, Problem, Qb64, Seal, SignedMessage } from "./types";
import { problem } from "./types";

export const MAX_KEYS = 64;
const KEY_CODES = ["D", "1AAJ"] as const;
const WITNESS_CODES = ["B"] as const;

export interface KeyState {
  aid: Qb64;
  /** Latest event. */
  sn: number;
  said: Qb64;
  /** Latest establishment event. */
  estSn: number;
  estSaid: Qb64;
  kt: number;
  keys: Qb64[];
  nt: number;
  next: Qb64[];
  bt: number;
  witnesses: Qb64[];
  traits: string[];
  abandoned: boolean;
}

export interface VerifyOptions extends SigOptions {
  /** Don't require witness receipts (a controller checking its own log). */
  allowUnwitnessed?: boolean;
  /** Compare with this store's first-seen copies. */
  firstSeen?: LogStore;
  clock?: Clock;
}

export type EventStatus = "valid" | "pending" | "superseded" | "invalid";

export interface KelEvent {
  s: number;
  d: Qb64;
  t: string;
  status: EventStatus;
  receipts: Qb64[];
  /** Timed witness receipts (our trc over a KEL event; not KERI): each witness's own time. (Additive.) */
  receiptTimes: { witness: Qb64; dt: string }[];
  earliestReceipt?: string;
}

export interface KelResult {
  ok: boolean;
  aid: Qb64;
  /** One per establishment event, in order. */
  states: KeyState[];
  latest: KeyState;
  events: KelEvent[];
  superseded: { s: number; d: Qb64; by: Qb64 }[];
  problems: Problem[];
  evidence: DuplicityEvidence[];
  /** The trunk, with attached witness signatures merged in. */
  messages: SignedMessage[];
}

// ---- builders

export interface IcpFields {
  keys: Qb64[];
  kt: number;
  next: Qb64[];
  nt: number;
  witnesses: Qb64[];
  bt: number;
  traits?: string[];
  anchors?: unknown[];
}

const hex = (n: number) => n.toString(16);

export function buildIcp(f: IcpFields) {
  return buildMessage("icp", {
    s: "0",
    kt: hex(f.kt),
    k: f.keys,
    nt: hex(f.nt),
    n: f.next,
    bt: hex(f.bt),
    b: f.witnesses,
    c: f.traits ?? [],
    a: f.anchors ?? [],
  });
}

export function buildRot(f: {
  aid: Qb64;
  s: number;
  prior: Qb64;
  keys: Qb64[];
  kt: number;
  next: Qb64[];
  nt: number;
  bt: number;
  cuts: Qb64[];
  adds: Qb64[];
  anchors?: unknown[];
}) {
  return buildMessage("rot", {
    i: f.aid,
    s: hex(f.s),
    p: f.prior,
    kt: hex(f.kt),
    k: f.keys,
    nt: hex(f.nt),
    n: f.next,
    bt: hex(f.bt),
    br: f.cuts,
    ba: f.adds,
    a: f.anchors ?? [],
  });
}

export function buildIxn(f: { aid: Qb64; s: number; prior: Qb64; anchors: unknown[] }) {
  return buildMessage("ixn", { i: f.aid, s: hex(f.s), p: f.prior, a: f.anchors });
}

export function buildRct(f: { aid: Qb64; s: number; said: Qb64 }) {
  return buildMessage("rct", { d: f.said, i: f.aid, s: hex(f.s) });
}

export function isEventSeal(a: unknown): a is { i: Qb64; s: string; d: Qb64 } {
  if (typeof a !== "object" || a === null) return false;
  const k = Object.keys(a);
  const o = a as Record<string, unknown>;
  return k.length === 3 && k[0] === "i" && k[1] === "s" && k[2] === "d" && typeof o.i === "string" && hexNumber(o.s) !== undefined && typeof o.d === "string";
}

export function isDigestSeal(a: unknown): a is { d: Qb64 } {
  if (typeof a !== "object" || a === null) return false;
  const k = Object.keys(a);
  return k.length === 1 && k[0] === "d" && typeof (a as { d: unknown }).d === "string";
}

export function sealsOf(m: SignedMessage): unknown[] {
  const a = m.body.a;
  return Array.isArray(a) ? a : [];
}

// ---- verification

interface Pending {
  msg: SignedMessage;
  state: KeyState;
  receipts: Map<Qb64, true>;
  times: Map<Qb64, string>;
  status: EventStatus;
}

function cloneState(s: KeyState): KeyState {
  return { ...s, keys: [...s.keys], next: [...s.next], witnesses: [...s.witnesses], traits: [...s.traits] };
}

function asThreshold(v: unknown, logId: Qb64, s: number, label: string): number | Problem {
  if (Array.isArray(v)) return problem("unsupported", `fractional ${label} is not supported`, logId, s);
  const n = hexNumber(v);
  if (n === undefined) return problem("badFields", `${label} must be a hex string`, logId, s);
  return n;
}

function qbList(v: unknown, codes: readonly string[], label: string, logId: Qb64, s: number): Qb64[] | Problem {
  if (!Array.isArray(v)) return problem("badFields", `${label} must be a list`, logId, s);
  if (v.length > MAX_KEYS) return problem("unsupported", `more than ${MAX_KEYS} ${label}`, logId, s);
  for (const x of v) {
    if (typeof x !== "string") return problem("badFields", `${label} must hold strings`, logId, s);
    if (!isQb64(x)) {
      let why = "";
      try {
        decode(x);
      } catch (e) {
        why = e instanceof Error ? e.message : "";
      }
      if (why.startsWith("unsupported")) return problem("unsupported", `unsupported code in ${label}: ${x.slice(0, 4)}`, logId, s);
      return problem("badFields", `${label} holds a bad primitive`, logId, s);
    }
    if (!isQb64(x, codes)) return problem("unsupported", `unsupported code in ${label}: ${x.slice(0, 4)}`, logId, s);
  }
  if (new Set(v).size !== v.length) return problem("badFields", `${label} has duplicates`, logId, s);
  return v as Qb64[];
}

const isProblem = (x: unknown): x is Problem => typeof x === "object" && x !== null && "code" in x && "message" in x && !Array.isArray(x);

/**
 * Processes KEL events and receipts one at a time. Used by verifyKel, witnesses, watchers and controllers.
 */
export class KelProcessor {
  aid?: Qb64;
  readonly trunk: Pending[] = [];
  readonly states: KeyState[] = [];
  readonly superseded: { s: number; d: Qb64; by: Qb64; msg: SignedMessage }[] = [];
  readonly problems: Problem[] = [];
  readonly evidence: DuplicityEvidence[] = [];
  /** Receipts that arrived before their event, by "s:d". */
  private readonly early = new Map<string, SignedMessage[]>();

  constructor(private readonly opts: VerifyOptions = {}) {}

  latest(): KeyState | undefined {
    const last = this.trunk[this.trunk.length - 1];
    return last?.state;
  }

  /** The key state after event `sn` of the trunk. */
  stateAt(sn: number): KeyState | undefined {
    return this.trunk[sn]?.state;
  }

  /** Validates `msg` as the event after `prior` (state before it). Returns the new state or a problem. */
  private async validate(msg: SignedMessage, prior: KeyState | undefined): Promise<KeyState | Problem> {
    const b = msg.body;
    const { logId, s } = msg;
    if (msg.t === "icp") {
      if (s !== 0) return problem("badSequence", "icp must have s 0", logId, s);
      if (!isQb64(b.i, ["E"])) return problem("unsupported", "only self-addressing (E) AIDs are supported", logId, s);
    } else if (!prior) {
      return problem("badSequence", "event before inception", logId, s);
    }
    if (prior?.abandoned) return problem("abandoned", "the AID was abandoned", logId, s);
    if (prior && b.p !== this.trunk[s - 1]?.msg.d) return problem("badChain", "p is not the prior event's SAID", logId, s);

    let state: KeyState;
    let signingKeys: Qb64[];
    if (msg.t === "ixn") {
      if (!Array.isArray(b.a)) return problem("badFields", "a must be a list", logId, s);
      state = { ...cloneState(prior!), sn: s, said: msg.d };
      signingKeys = prior!.keys;
    } else {
      const kt = asThreshold(b.kt, logId, s, "kt");
      if (isProblem(kt)) return kt;
      const nt = asThreshold(b.nt, logId, s, "nt");
      if (isProblem(nt)) return nt;
      const bt = asThreshold(b.bt, logId, s, "bt");
      if (isProblem(bt)) return bt;
      const keys = qbList(b.k, KEY_CODES, "keys", logId, s);
      if (isProblem(keys)) return keys;
      const next = qbList(b.n, ["E"], "next digests", logId, s);
      if (isProblem(next)) return next;
      if (!Array.isArray(b.a)) return problem("badFields", "a must be a list", logId, s);
      let witnesses: Qb64[];
      let traits: string[];
      if (msg.t === "icp") {
        const w = qbList(b.b, WITNESS_CODES, "witnesses", logId, s);
        if (isProblem(w)) return w;
        witnesses = w;
        if (!Array.isArray(b.c) || b.c.some((x) => typeof x !== "string")) return problem("badFields", "c must be a list of strings", logId, s);
        traits = b.c as string[];
        if (traits.some((t) => t !== "DND")) return problem("unsupported", `unsupported traits ${traits.join(",")}`, logId, s);
        if (next.length === 0) return problem("unsupported", "non-transferable inception is not supported", logId, s);
      } else {
        const cuts = qbList(b.br, WITNESS_CODES, "br", logId, s);
        if (isProblem(cuts)) return cuts;
        const adds = qbList(b.ba, WITNESS_CODES, "ba", logId, s);
        if (isProblem(adds)) return adds;
        for (const c of cuts) if (!prior!.witnesses.includes(c)) return problem("badFields", `br removes ${c}, which is not a witness`, logId, s);
        const kept = prior!.witnesses.filter((w) => !cuts.includes(w));
        for (const a of adds) if (kept.includes(a)) return problem("badFields", `ba adds ${a}, which is already a witness`, logId, s);
        witnesses = [...kept, ...adds];
        if (witnesses.length > MAX_KEYS) return problem("unsupported", `more than ${MAX_KEYS} witnesses`, logId, s);
        traits = prior!.traits;
      }
      if (kt < 1 || kt > keys.length) return problem("badFields", `kt ${kt} out of range for ${keys.length} keys`, logId, s);
      if (nt > next.length || (next.length > 0 && nt < 1)) return problem("badFields", `nt ${nt} out of range for ${next.length} digests`, logId, s);
      if (bt > witnesses.length) return problem("badFields", `bt ${bt} is more than ${witnesses.length} witnesses`, logId, s);
      state = {
        aid: msg.t === "icp" ? String(b.i) : prior!.aid,
        sn: s,
        said: msg.d,
        estSn: s,
        estSaid: msg.d,
        kt,
        keys,
        nt,
        next,
        bt,
        witnesses,
        traits,
        abandoned: next.length === 0,
      };
      signingKeys = keys;
    }

    // controller signatures
    const sigs = msg.controllerSigs ?? [];
    const raw = utf8(msg.raw);
    const seen = new Set<number>();
    const seenOndex = new Set<number>();
    for (const sig of sigs) {
      const key = signingKeys[sig.index];
      if (!key) return problem("signatureInvalid", `signature index ${sig.index} has no key`, logId, s);
      if (!(await verifyKeySig(key, raw, sig, this.opts))) return problem("signatureInvalid", `signature ${sig.index} does not verify`, logId, s);
      seen.add(sig.index);
      if (msg.t === "rot" && sig.ondex !== undefined && DUAL_CODES.has(sig.code)) {
        if (prior!.next[sig.ondex] === nextKeyDigest(key)) seenOndex.add(sig.ondex);
      }
    }
    if (seen.size < state.kt) return problem("thresholdNotMet", `${seen.size} of ${state.kt} signatures`, logId, s);
    if (msg.t === "rot" && seenOndex.size < prior!.nt)
      return problem("nextKeyMismatch", `${seenOndex.size} of ${prior!.nt} prior next keys signed`, logId, s);
    return state;
  }

  /** Adds an event. Returns what happened. */
  async addEvent(msg: SignedMessage): Promise<{ result: "first" | "same" | "supersede" | "duplicity" | "invalid"; problem?: Problem }> {
    const fail = (p: Problem) => {
      this.problems.push(p);
      return { result: "invalid" as const, problem: p };
    };
    if (msg.t !== "icp" && msg.t !== "rot" && msg.t !== "ixn") return fail(problem("badFields", `${msg.t} is not a KEL event`, msg.logId, msg.s));
    if (this.aid && msg.logId !== this.aid) return fail(problem("badFields", "event for another AID", msg.logId, msg.s));
    const at = this.trunk[msg.s];
    if (at && at.msg.d === msg.d) {
      this.mergeWitnessSigs(at, msg);
      return { result: "same" };
    }
    if (msg.s > this.trunk.length) return fail(problem("badSequence", `expected s ${this.trunk.length}, got ${msg.s}`, msg.logId, msg.s));
    if (at) {
      // another version at an existing location: a superseding recovery (rule A0) or duplicity
      const prior = this.trunk[msg.s - 1]?.state;
      const tailIsIxn = this.trunk.slice(msg.s).every((p) => p.msg.t === "ixn");
      if (msg.t === "rot" && tailIsIxn) {
        const st = await this.validate(msg, prior);
        if (isProblem(st)) return fail(st);
        const removed = this.trunk.splice(msg.s);
        for (const r of removed) {
          r.status = "superseded";
          this.superseded.push({ s: r.msg.s, d: r.msg.d, by: msg.d, msg: r.msg });
        }
        this.push(msg, st);
        return { result: "supersede" };
      }
      const st = await this.validate(msg, msg.t === "icp" ? undefined : prior);
      if (isProblem(st)) return fail(st);
      const p = problem("duplicity", `two versions at s ${msg.s}`, msg.logId, msg.s);
      this.problems.push(p);
      this.evidence.push({
        kind: "controller",
        logId: msg.logId,
        s: msg.s,
        a: at.msg,
        b: msg,
        detectedBy: "verifyKel",
        detectedAt: this.opts.clock?.iso() ?? new Date().toISOString(),
      });
      return { result: "duplicity", problem: p };
    }
    const st = await this.validate(msg, this.latest());
    if (isProblem(st)) return fail(st);
    if (msg.t === "icp") this.aid = msg.logId;
    this.push(msg, st);
    return { result: "first" };
  }

  private push(msg: SignedMessage, state: KeyState): void {
    const copy: SignedMessage = { ...msg, witnessSigs: [] };
    const p: Pending = { msg: copy, state, receipts: new Map(), times: new Map(), status: "pending" };
    this.trunk.push(p);
    if (msg.t !== "ixn") {
      // keep one state per establishment event; a superseding rot replaces nothing here, as A0 only supersedes ixns
      this.states.push(cloneState(state));
    }
    this.mergeWitnessSigs(p, msg);
    for (const r of this.early.get(`${msg.s}:${msg.d}`) ?? []) this.applyReceipt(p, r);
    this.early.delete(`${msg.s}:${msg.d}`);
  }

  private mergeWitnessSigs(p: Pending, msg: SignedMessage): void {
    const raw = utf8(p.msg.raw);
    for (const w of msg.witnessSigs ?? []) {
      const wit = p.state.witnesses[w.index];
      if (!wit || p.receipts.has(wit)) continue;
      if (verifyCouple(wit, raw, w.sig)) {
        p.receipts.set(wit, true);
        p.msg.witnessSigs!.push(w);
      }
    }
  }

  private applyReceipt(p: Pending, rct: SignedMessage): Qb64[] {
    const added: Qb64[] = [];
    const raw = utf8(p.msg.raw);
    for (const w of rct.witnessSigs ?? []) {
      const wit = p.state.witnesses[w.index];
      if (wit && !p.receipts.has(wit) && verifyCouple(wit, raw, w.sig)) {
        p.receipts.set(wit, true);
        p.msg.witnessSigs!.push(w);
        added.push(wit);
      }
    }
    for (const c of rct.couples ?? []) {
      const index = p.state.witnesses.indexOf(c.signer);
      if (index >= 0 && !p.receipts.has(c.signer) && verifyCouple(c.signer, raw, c.sig)) {
        p.receipts.set(c.signer, true);
        p.msg.witnessSigs!.push({ code: "A", index, ondex: index, sig: c.sig });
        added.push(c.signer);
      }
    }
    return added;
  }

  /** Adds a KERI `rct` receipt. Returns the witnesses whose valid signatures it added. */
  addReceipt(rct: SignedMessage): Qb64[] {
    const p = this.trunk[rct.s];
    if (p && p.msg.d === rct.d) return this.applyReceipt(p, rct);
    const sup = this.superseded.find((x) => x.s === rct.s && x.d === rct.d);
    if (sup) return [];
    const key = `${rct.s}:${rct.d}`;
    this.early.set(key, [...(this.early.get(key) ?? []), rct]);
    return [];
  }

  /**
   * Adds a timed receipt: a `trc` over a KEL event, signed by one of its witnesses (our extension).
   * It gives a "not after" time that verifies offline. Returns the witness, if it counted.
   */
  addTimedReceipt(trc: SignedMessage): Qb64 | undefined {
    const p = this.trunk[trc.s];
    if (!p || p.msg.d !== trc.d || typeof trc.body.dt !== "string") return undefined;
    for (const c of trc.couples ?? []) {
      if (!p.state.witnesses.includes(c.signer) || p.times.has(c.signer)) continue;
      if (verifyCouple(c.signer, utf8(trc.raw), c.sig)) {
        p.times.set(c.signer, trc.body.dt);
        return c.signer;
      }
    }
    return undefined;
  }

  receiptsOf(s: number, d: Qb64): Qb64[] {
    const p = this.trunk[s];
    return p && p.msg.d === d ? [...p.receipts.keys()] : [];
  }

  result(): KelResult {
    const problems = [...this.problems];
    const events: KelEvent[] = [];
    for (const p of this.trunk) {
      const n = p.receipts.size;
      const witnessed = n >= p.state.bt;
      if (!witnessed && !this.opts.allowUnwitnessed)
        problems.push(problem("notWitnessed", `${n} of ${p.state.bt} witness receipts`, p.msg.logId, p.msg.s));
      const receiptTimes = [...p.times.entries()].map(([witness, dt]) => ({ witness, dt }));
      const earliest = receiptTimes.map((x) => x.dt).sort()[0];
      events.push({ s: p.msg.s, d: p.msg.d, t: p.msg.t, status: witnessed ? "valid" : "pending", receipts: [...p.receipts.keys()], receiptTimes, ...(earliest ? { earliestReceipt: earliest } : {}) });
    }
    for (const x of this.superseded) events.push({ s: x.s, d: x.d, t: x.msg.t, status: "superseded", receipts: [], receiptTimes: [] });
    const latest = this.latest();
    return {
      ok: problems.length === 0 && this.evidence.length === 0 && !!latest,
      aid: this.aid ?? "",
      states: this.states.map(cloneState),
      latest: latest ? cloneState(latest) : emptyState(),
      events,
      superseded: this.superseded.map(({ s, d, by }) => ({ s, d, by })),
      problems,
      evidence: [...this.evidence],
      messages: this.trunk.map((p) => p.msg),
    };
  }
}

function emptyState(): KeyState {
  return { aid: "", sn: -1, said: "", estSn: -1, estSaid: "", kt: 0, keys: [], nt: 0, next: [], bt: 0, witnesses: [], traits: [], abandoned: false };
}

/** Verifies a KEL stream or message list. Never throws on bad input. */
export async function verifyKel(input: string | SignedMessage[], opts: VerifyOptions = {}): Promise<KelResult> {
  const parsed = typeof input === "string" ? fromStream(input) : { messages: input, problems: [] as Problem[] };
  const proc = new KelProcessor(opts);
  proc.problems.push(...parsed.problems);
  const receipts: SignedMessage[] = [];
  for (const m of parsed.messages) {
    if (m.t === "rct" || m.t === "trc") receipts.push(m);
    else await proc.addEvent(m);
  }
  for (const r of receipts) {
    if (proc.aid && r.logId !== proc.aid) continue;
    if (r.t === "rct") proc.addReceipt(r);
    else proc.addTimedReceipt(r);
  }
  if (opts.firstSeen && proc.aid) {
    for (const p of proc.trunk) {
      const held = await opts.firstSeen.get(proc.aid, p.msg.s);
      if (held && held.d !== p.msg.d && !held.superseded) {
        proc.problems.push(problem("duplicity", `first-seen copy differs at s ${p.msg.s}`, proc.aid, p.msg.s));
        const heldMsg = fromStream(held.raw + held.attachments).messages[0];
        if (heldMsg)
          proc.evidence.push({
            kind: "controller",
            logId: proc.aid,
            s: p.msg.s,
            a: heldMsg,
            b: p.msg,
            detectedBy: "firstSeen",
            detectedAt: opts.clock?.iso() ?? new Date().toISOString(),
          });
      }
    }
  }
  return proc.result();
}

// ---- key state queries (for capture)

/** The establishment state made current by the event at `estSn`. */
export function stateOf(kel: KelResult, estSn: number): KeyState | undefined {
  return kel.states.find((s) => s.estSn === estSn);
}

/** Keys made current by the establishment event at `estSn`. */
export function keyAt(kel: KelResult, estSn: number): { curve: "ed25519" | "p256"; bytes: Uint8Array; qb64: Qb64 }[] {
  const st = stateOf(kel, estSn);
  if (!st) return [];
  return st.keys.map((k) => {
    const d = decodeKey(k);
    return { ...d, qb64: k };
  });
}

function decodeKey(k: Qb64): { curve: "ed25519" | "p256"; bytes: Uint8Array } {
  const { code, raw } = decode(k);
  return { curve: code === "1AAJ" ? "p256" : "ed25519", bytes: raw };
}

/** The sn of the rotation that retired the keys of `estSn`, or null if they are current. */
export function retiredAt(kel: KelResult, estSn: number): number | null {
  const i = kel.states.findIndex((s) => s.estSn === estSn);
  if (i < 0 || i === kel.states.length - 1) return null;
  return kel.states[i + 1].estSn;
}

/** Whether the keys made current at `estSn` were current at event `atSn`. */
export function isCurrentAt(kel: KelResult, estSn: number, atSn: number): boolean {
  if (!stateOf(kel, estSn) || atSn < estSn) return false;
  const r = retiredAt(kel, estSn);
  return r === null || atSn < r;
}

/** Seals in the trunk events, with the sn of the event holding each. */
export function kelSeals(kel: KelResult): { sn: number; seal: Seal | Record<string, unknown> }[] {
  const out: { sn: number; seal: Seal | Record<string, unknown> }[] = [];
  for (const m of kel.messages) for (const a of sealsOf(m)) out.push({ sn: m.s, seal: a as Seal });
  return out;
}

export function isIndexedSig(x: unknown): x is IndexedSig {
  return typeof x === "object" && x !== null && "sig" in x && "index" in x;
}
