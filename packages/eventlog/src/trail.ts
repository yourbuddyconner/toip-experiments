/**
 * Trails: our audit logs on top of a KEL (trail design §7.4, §11.2). Not KERI.
 */
import { utf8 } from "@zk-toip/trust-core";
import { verifyCouple, verifyKeySig } from "./keys";
import { isEventSeal, sealsOf, type KelResult, type KeyState, type VerifyOptions } from "./kel";
import { buildMessage, checkBody, hexNumber } from "./said";
import { fromStream } from "./stream";
import type { Body, DuplicityEvidence, KeyRef, KeyRefSig, Problem, Qb64, Seal, SignedMessage } from "./types";
import { problem } from "./types";

const hex = (n: number) => n.toString(16);
export const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function buildTin(f: { controller: Qb64; dt: string; purpose: string }) {
  return buildMessage("tin", { s: "0", ci: f.controller, dt: f.dt, m: f.purpose });
}

export function buildTen(f: { trailId: Qb64; s: number; prior: Qb64; dt: string; kind: string; bodySaid: Qb64 | ""; refs: Seal[] }) {
  return buildMessage("ten", { i: f.trailId, s: hex(f.s), p: f.prior, dt: f.dt, k: f.kind, a: f.bodySaid, x: f.refs });
}

export function buildTcl(f: { trailId: Qb64; s: number; prior: Qb64; dt: string }) {
  return buildMessage("tcl", { i: f.trailId, s: hex(f.s), p: f.prior, dt: f.dt });
}

/** A receipt or endorsement of a trail message. Its signature covers its own `dt`. */
export function buildTrc(f: { logId: Qb64; s: number; said: Qb64; dt: string }) {
  return buildMessage("trc", { d: f.said, i: f.logId, s: hex(f.s), dt: f.dt });
}

export type EntryStatus = "valid" | "pending" | "cut" | "invalid";

export interface TrailEntry {
  s: number;
  d: Qb64;
  t: "tin" | "ten" | "tcl";
  kind: string;
  dt: string;
  status: EntryStatus;
  keyState: KeyRef;
  receipts: { witness: Qb64; dt: string }[];
  earliestReceipt?: string;
  endorsements: { signer: string; dt: string }[];
  /** KEL sn of the first checkpoint or rotation that sealed this entry or a later one. */
  anchoredBy?: number;
  body?: { said: Qb64; ok: boolean };
  /** KEL sn of the rotation that cut it. */
  cutBy?: number;
  /** The body SAID the header commits to (`a`), and its other seals (`x`). */
  a: Qb64 | "";
  x: Seal[];
}

export interface TrailResult {
  ok: boolean;
  trailId: Qb64;
  controller: Qb64;
  purpose: string;
  closed: boolean;
  /** Trunk entries in order, then cut entries. */
  entries: TrailEntry[];
  /** The latest trunk entry. (Additive.) */
  head?: { s: number; d: Qb64 };
  problems: Problem[];
  evidence: DuplicityEvidence[];
}

interface Rec {
  msg: SignedMessage;
  est?: KeyState;
  status: EntryStatus;
  cutBy?: number;
  receipts: Map<Qb64, string>;
  receiptMsgs: Map<Qb64, SignedMessage>;
  endorsements: Map<string, string>;
}

export interface TrailVerifyOptions extends VerifyOptions {
  /** KELs of AIDs that may endorse entries with -F groups. */
  endorserKels?: KelResult[];
}

/** Which KEL trunk events seal trail `trailId`, and at what entry. */
export function trailSeals(kel: KelResult, trailId: Qb64): { kelSn: number; kelType: string; s: number; d: Qb64 }[] {
  const out: { kelSn: number; kelType: string; s: number; d: Qb64 }[] = [];
  for (const m of kel.messages)
    for (const a of sealsOf(m)) if (isEventSeal(a) && a.i === trailId) out.push({ kelSn: m.s, kelType: m.t, s: hexNumber(a.s)!, d: a.d });
  return out;
}

/** Checks a message's -F group against the KEL. Returns the key state, or a problem. */
export async function checkKeyRefSig(
  msg: SignedMessage,
  kel: KelResult,
  opts: VerifyOptions = {},
  cache?: Map<string, boolean>,
): Promise<KeyState | Problem> {
  const g: KeyRefSig | undefined = msg.keyRefSig;
  if (!g) return problem("signatureInvalid", "no -F signature group", msg.logId, msg.s);
  if (g.aid !== kel.aid) return problem("unknownKeyState", "signed by another AID", msg.logId, msg.s);
  const est = kel.states.find((st) => st.estSn === g.estSn && st.estSaid === g.estSaid);
  if (!est) return problem("unknownKeyState", `establishment event ${g.estSn} is not in the KEL`, msg.logId, msg.s);
  const key = `${msg.d}|${msg.raw.length}|${g.estSaid}|${g.sigs.map((x) => x.index + ":" + x.sig.join(",")).join(";")}`;
  let ok = cache?.get(key);
  if (ok === undefined) {
    ok = true;
    const raw = utf8(msg.raw);
    const seen = new Set<number>();
    for (const sig of g.sigs) {
      const k = est.keys[sig.index];
      if (!k || !(await verifyKeySig(k, raw, sig, opts))) {
        ok = false;
        break;
      }
      seen.add(sig.index);
    }
    if (ok && seen.size < est.kt) {
      cache?.set(key, false);
      return problem("thresholdNotMet", `${seen.size} of ${est.kt} signatures`, msg.logId, msg.s);
    }
    cache?.set(key, ok);
  }
  if (!ok) return problem("signatureInvalid", "a signature does not verify", msg.logId, msg.s);
  return est;
}

const isProblem = (x: unknown): x is Problem => typeof x === "object" && x !== null && "code" in x && "message" in x;

/** R2: is an entry under `est` at `s` cut by the next rotation? */
export function cutStatus(kel: KelResult, trailId: Qb64, est: KeyState, s: number): { cut: false } | { cut: true; by: number } | { unsealed: number } {
  const j = kel.states.findIndex((x) => x.estSn === est.estSn);
  const next = kel.states[j + 1];
  if (!next) return { cut: false };
  const rot = kel.messages[next.estSn];
  const seal = sealsOf(rot).find((a) => isEventSeal(a) && a.i === trailId) as { s: string } | undefined;
  if (!seal) return { unsealed: next.estSn };
  return s > hexNumber(seal.s)! ? { cut: true, by: next.estSn } : { cut: false };
}

/**
 * Processes a trail's messages against a verified KEL. Witnesses and watchers use it incrementally;
 * verifyTrail uses it in one pass.
 */
export class TrailProcessor {
  trailId?: Qb64;
  controller = "";
  purpose = "";
  private all: SignedMessage[] = [];
  private receiptsIn: SignedMessage[] = [];
  trunk: Rec[] = [];
  cut: Rec[] = [];
  invalid: Rec[] = [];
  problems: Problem[] = [];
  evidence: DuplicityEvidence[] = [];
  private readonly sigCache = new Map<string, boolean>();

  constructor(
    private kel: KelResult,
    private readonly opts: TrailVerifyOptions = {},
  ) {}

  closed(): boolean {
    return this.trunk[this.trunk.length - 1]?.msg.t === "tcl";
  }

  head(): { s: number; d: Qb64 } | undefined {
    const h = this.trunk[this.trunk.length - 1];
    return h ? { s: h.msg.s, d: h.msg.d } : undefined;
  }

  /** Replaces the KEL (after a rotation) and re-runs every message. */
  async setKel(kel: KelResult): Promise<void> {
    this.kel = kel;
    const msgs = this.all;
    const rcts = this.receiptsIn;
    this.all = [];
    this.receiptsIn = [];
    this.trunk = [];
    this.cut = [];
    this.invalid = [];
    this.problems = [];
    this.evidence = [];
    for (const m of msgs) await this.add(m);
    for (const r of rcts) this.addReceipt(r);
  }

  private fail(m: SignedMessage, p: Problem, est?: KeyState): { result: "invalid"; problem: Problem } {
    this.problems.push(p);
    this.invalid.push({ msg: m, est, status: "invalid", receipts: new Map(), receiptMsgs: new Map(), endorsements: new Map() });
    return { result: "invalid", problem: p };
  }

  /** Adds a tin, ten or tcl. */
  async add(m: SignedMessage): Promise<{ result: "first" | "same" | "cut" | "duplicity" | "invalid"; problem?: Problem; cutBy?: number }> {
    this.all.push(m);
    if (m.t !== "tin" && m.t !== "ten" && m.t !== "tcl") return this.fail(m, problem("badFields", `${m.t} is not a trail message`, m.logId, m.s));
    if (m.t === "tin") {
      if (this.trailId && this.trailId !== m.logId) return this.fail(m, problem("badFields", "message for another trail", m.logId, m.s));
    } else if (this.trailId === undefined && this.trunk.length === 0) {
      // a stream that doesn't begin at the tin
      return this.fail(m, problem("badSequence", "trail stream must begin with its tin", m.logId, m.s));
    }
    if (this.trailId && m.logId !== this.trailId) return this.fail(m, problem("badFields", "message for another trail", m.logId, m.s));
    const same = this.trunk[m.s];
    if (same && same.msg.d === m.d) return { result: "same" };
    const known = [...this.cut, ...this.invalid].find((r) => r.msg.d === m.d && r.msg.s === m.s && r.status === "cut");
    if (known) return { result: "same" };

    const est = await checkKeyRefSig(m, this.kel, this.opts, this.sigCache);
    if (isProblem(est)) return this.fail(m, est);
    if (m.t === "tin" && m.body.ci !== this.kel.aid) return this.fail(m, problem("badFields", "tin controller is not the KEL's AID", m.logId, m.s), est);
    if (typeof m.body.dt !== "string" || !ISO_MS.test(m.body.dt)) return this.fail(m, problem("badFields", "dt must be ISO 8601 UTC with milliseconds", m.logId, m.s), est);
    if (m.t === "ten" && (typeof m.body.k !== "string" || typeof m.body.a !== "string" || !Array.isArray(m.body.x)))
      return this.fail(m, problem("badFields", "bad entry fields", m.logId, m.s), est);

    const trailId = m.t === "tin" ? m.logId : this.trailId!;
    const c = cutStatus(this.kel, trailId, est, m.s);
    if ("cut" in c && c.cut) {
      this.cut.push({ msg: m, est, status: "cut", cutBy: c.by, receipts: new Map(), receiptMsgs: new Map(), endorsements: new Map() });
      return { result: "cut", cutBy: c.by };
    }
    if (same) {
      // two versions at one location, neither cut: duplicity
      const p = problem("duplicity", `two versions of entry ${m.s}`, m.logId, m.s);
      this.problems.push(p);
      this.evidence.push({
        kind: "controller",
        logId: m.logId,
        s: m.s,
        a: same.msg,
        b: m,
        detectedBy: "verifyTrail",
        detectedAt: this.opts.clock?.iso() ?? new Date().toISOString(),
      });
      return { result: "duplicity", problem: p };
    }
    if (m.s !== this.trunk.length) return this.fail(m, problem("badSequence", `expected entry ${this.trunk.length}, got ${m.s}`, m.logId, m.s), est);
    const prev = this.trunk[m.s - 1];
    if (m.t !== "tin") {
      if (!prev) return this.fail(m, problem("badSequence", "entry before the tin", m.logId, m.s), est);
      if (prev.msg.t === "tcl") return this.fail(m, problem("afterClose", "entry after the trail was closed", m.logId, m.s), est);
      if (m.body.p !== prev.msg.d) return this.fail(m, problem("badChain", "p is not the prior entry's SAID", m.logId, m.s), est);
      if (prev.est && est.estSn < prev.est.estSn) return this.fail(m, problem("staleKeyState", "signed by an older key state than the prior entry", m.logId, m.s), est);
      if (Date.parse(String(m.body.dt)) < Date.parse(String(prev.msg.body.dt)))
        return this.fail(m, problem("timeReversed", "dt is before the prior entry's", m.logId, m.s), est);
    } else {
      this.trailId = m.logId;
      this.controller = String(m.body.ci);
      this.purpose = String(m.body.m);
    }
    const rec: Rec = { msg: m, est, status: "pending", receipts: new Map(), receiptMsgs: new Map(), endorsements: new Map() };
    if ("unsealed" in c) {
      rec.status = "invalid";
      this.problems.push(problem("unsealedRotation", `the rotation at KEL ${c.unsealed} did not seal this trail`, m.logId, m.s));
    }
    this.trunk.push(rec);
    return { result: "first" };
  }

  private findRec(s: number, d: Qb64): Rec | undefined {
    const t = this.trunk[s];
    if (t && t.msg.d === d) return t;
    return this.cut.find((r) => r.msg.s === s && r.msg.d === d);
  }

  /**
   * Adds a trc. Returns what it was: a witness receipt, an endorsement, or nothing usable.
   * A witness that receipted two versions at one location is recorded as witness duplicity.
   */
  addReceipt(trc: SignedMessage): { kind: "witness" | "endorsement" | "none"; signer?: string } {
    this.receiptsIn.push(trc);
    const rec = this.findRec(trc.s, trc.d);
    const raw = utf8(trc.raw);
    const dt = String(trc.body.dt);
    if (!ISO_MS.test(dt)) return { kind: "none" };
    for (const c of trc.couples ?? []) {
      if (!verifyCouple(c.signer, raw, c.sig)) continue;
      // witness duplicity: one witness, two versions at one location
      for (const other of [...this.trunk, ...this.cut]) {
        if (other.msg.s !== trc.s || other.msg.d === trc.d) continue;
        const prior = other.receiptMsgs.get(c.signer);
        if (prior) {
          this.evidence.push({
            kind: "witness",
            logId: trc.logId,
            s: trc.s,
            a: prior,
            b: trc,
            witness: c.signer,
            detectedBy: "verifyTrail",
            detectedAt: this.opts.clock?.iso() ?? new Date().toISOString(),
          });
          this.problems.push(problem("duplicity", `witness ${c.signer} receipted two versions of entry ${trc.s}`, trc.logId, trc.s));
        }
      }
      if (!rec) return { kind: "none" };
      if (rec.est?.witnesses.includes(c.signer)) {
        if (!rec.receipts.has(c.signer)) {
          rec.receipts.set(c.signer, dt);
          rec.receiptMsgs.set(c.signer, { ...trc, couples: [c] });
        }
        return { kind: "witness", signer: c.signer };
      }
      rec.endorsements.set(c.signer, dt);
      return { kind: "endorsement", signer: c.signer };
    }
    if (trc.keyRefSig && rec) {
      const kel = this.opts.endorserKels?.find((k) => k.aid === trc.keyRefSig!.aid);
      if (kel) {
        const g = trc.keyRefSig;
        const est = kel.states.find((x) => x.estSn === g.estSn && x.estSaid === g.estSaid);
        if (est && g.sigs.length >= est.kt && g.sigs.every((s) => est.keys[s.index] && verifyCouple(est.keys[s.index], raw, s.sig))) {
          rec.endorsements.set(g.aid, dt);
          return { kind: "endorsement", signer: g.aid };
        }
      }
    }
    return { kind: "none" };
  }

  result(bodies: Body[] = []): TrailResult {
    const problems = [...this.problems];
    const trailId = this.trailId ?? "";
    const seals = this.kel.messages.length ? trailSeals(this.kel, trailId) : [];
    // R3 and R4
    for (const seal of seals) {
      const at = this.trunk[seal.s];
      if (!at) problems.push(problem("truncated", `the KEL seals entry ${seal.s}, which is not shown`, trailId, seal.s));
      else if (at.msg.d !== seal.d) problems.push(problem("sealMismatch", `entry ${seal.s} is not the one sealed at KEL ${seal.kelSn}`, trailId, seal.s));
      else if (seal.kelType === "ixn" && at.est && at.est.estSn > seal.kelSn)
        problems.push(problem("staleKeyState", `entry ${seal.s} uses a key state newer than its checkpoint`, trailId, seal.s));
    }
    const bodyBySaid = new Map(bodies.map((b) => [b.d, b]));
    const entry = (r: Rec): TrailEntry => {
      const receipts = [...r.receipts.entries()].map(([witness, dt]) => ({ witness, dt }));
      const earliest = receipts.map((x) => x.dt).sort()[0];
      let status = r.status;
      if (status === "pending" && r.est && r.receipts.size >= r.est.bt) status = "valid";
      const a = (r.msg.t === "ten" ? String(r.msg.body.a) : "") as Qb64 | "";
      const e: TrailEntry = {
        s: r.msg.s,
        d: r.msg.d,
        t: r.msg.t as "tin" | "ten" | "tcl",
        kind: r.msg.t === "ten" ? String(r.msg.body.k) : "",
        dt: String(r.msg.body.dt),
        status,
        keyState: r.msg.keyRefSig ? { aid: r.msg.keyRefSig.aid, estSn: r.msg.keyRefSig.estSn, estSaid: r.msg.keyRefSig.estSaid } : { aid: "", estSn: -1, estSaid: "" },
        receipts,
        endorsements: [...r.endorsements.entries()].map(([signer, dt]) => ({ signer, dt })),
        a,
        x: r.msg.t === "ten" ? (r.msg.body.x as Seal[]) : [],
      };
      if (earliest) e.earliestReceipt = earliest;
      if (r.cutBy !== undefined) e.cutBy = r.cutBy;
      if (r.status !== "cut") {
        const anchors = seals.filter((x) => x.s >= r.msg.s && this.trunk[x.s]?.msg.d === x.d).map((x) => x.kelSn);
        if (anchors.length) e.anchoredBy = Math.min(...anchors);
      }
      if (a) {
        const body = bodyBySaid.get(a);
        if (body) {
          const ok = checkBody(body);
          e.body = { said: a, ok };
          if (!ok) problems.push(problem("bodyMismatch", `body of entry ${r.msg.s} does not match its SAID`, trailId, r.msg.s));
        }
      }
      return e;
    };
    const entries = [...this.trunk.map(entry), ...this.cut.map(entry)];
    for (const e of entries) {
      if (e.status === "pending" && !this.opts.allowUnwitnessed)
        problems.push(problem("notWitnessed", `entry ${e.s} has ${e.receipts.length} receipts`, trailId, e.s));
    }
    // bodies whose SAID doesn't match any entry are reported, as they may be tampered copies
    const known = new Set(entries.map((e) => e.a).filter(Boolean));
    for (const b of bodies) {
      if (!known.has(b.d)) problems.push(problem("bodyMismatch", `body ${String(b.d).slice(0, 12)}… is not committed by any entry`, trailId));
    }
    if (!this.trunk.length && !problems.length) problems.push(problem("badSequence", "no trail inception", trailId));
    const head = this.head();
    return {
      ok: problems.length === 0 && this.evidence.length === 0 && this.kel.ok !== false,
      trailId,
      controller: this.controller,
      purpose: this.purpose,
      closed: this.closed(),
      entries,
      ...(head ? { head } : {}),
      problems,
      evidence: [...this.evidence],
    };
  }
}

export async function verifyTrail(
  input: { kel: KelResult; stream: string | SignedMessage[]; bodies?: Body[] },
  opts: TrailVerifyOptions = {},
): Promise<TrailResult> {
  const parsed = typeof input.stream === "string" ? fromStream(input.stream) : { messages: input.stream, problems: [] as Problem[] };
  const proc = new TrailProcessor(input.kel, opts);
  proc.problems.push(...parsed.problems);
  const receipts: SignedMessage[] = [];
  for (const m of parsed.messages) {
    if (m.t === "trc") receipts.push(m);
    else await proc.add(m);
  }
  for (const r of receipts) proc.addReceipt(r);
  const res = proc.result(input.bodies);
  if (!input.kel.ok && !opts.allowUnwitnessed) res.ok = false;
  return res;
}
