/** Witnesses: receipt the first version seen at each location (trail design §9). Runs in browsers and Node. */
import { utf8, type Clock } from "@zk-toip/trust-core";
import { didKeyOf } from "./cesr";
import type { Refusal, SubmitResult, WitnessClient } from "./client";
import { KelProcessor, type KelResult } from "./kel";
import { verifyCouple, type SigOptions, type Signer } from "./keys";
import { makeReceipt, makeTimedReceipt, signerAid, toStoredReceipt } from "./receipts";
import { fromStored, receiptMessage, type LogStore, type StoredMessage } from "./store";
import { attachmentsOf, fromStream, toStream } from "./stream";
import { TrailProcessor } from "./trail";
import type { DuplicityEvidence, Problem, Qb64, SignedMessage } from "./types";
import { problem } from "./types";

export type { SubmitResult, WitnessClient } from "./client";

const KEL_T = new Set(["icp", "rot", "ixn"]);
const TRAIL_T = new Set(["tin", "ten", "tcl"]);

function storedOf(m: SignedMessage, clock: Clock): StoredMessage {
  return { logId: m.logId, s: m.s, d: m.d, t: m.t, raw: m.raw, attachments: attachmentsOf({ ...m, witnessSigs: undefined }), fn: 0, seenAt: clock.iso(), local: false };
}

/**
 * Keeps first-seen copies of KELs and trails, checked as they arrive. Shared by Witness and Watcher.
 */
export class LogKeeper {
  protected readonly kels = new Map<Qb64, KelProcessor>();
  protected readonly trails = new Map<Qb64, TrailProcessor>();
  protected readonly trailOwner = new Map<Qb64, Qb64>();

  constructor(
    readonly store: LogStore,
    readonly clock: Clock,
    protected readonly sigOptions: SigOptions = {},
  ) {}

  async kel(aid: Qb64): Promise<KelProcessor | undefined> {
    let p = this.kels.get(aid);
    if (p) return p;
    const msgs = await this.store.all(aid);
    if (!msgs.length) return undefined;
    p = new KelProcessor({ allowUnwitnessed: true, ...this.sigOptions });
    for (const m of msgs) {
      const r = await p.addEvent(fromStored(m));
      if (r.result === "supersede") for (const x of p.superseded) await this.store.markSuperseded(aid, x.s, x.d, x.by);
    }
    this.kels.set(aid, p);
    return p;
  }

  async kelResult(aid: Qb64): Promise<KelResult | undefined> {
    return (await this.kel(aid))?.result();
  }

  async controllerOf(trailId: Qb64, m?: SignedMessage): Promise<Qb64 | undefined> {
    if (m?.t === "tin") return String(m.body.ci);
    const known = this.trailOwner.get(trailId);
    if (known) return known;
    const tin = (await this.store.versions(trailId, 0))[0];
    if (!tin) return undefined;
    const ci = String(JSON.parse(tin.raw).ci);
    this.trailOwner.set(trailId, ci);
    return ci;
  }

  async trail(trailId: Qb64, controller: Qb64): Promise<TrailProcessor | undefined> {
    let t = this.trails.get(trailId);
    if (t) return t;
    const kel = await this.kelResult(controller);
    if (!kel) return undefined;
    t = new TrailProcessor(kel, { allowUnwitnessed: true, ...this.sigOptions });
    for (const m of await this.store.all(trailId)) await t.add(fromStored(m));
    this.trails.set(trailId, t);
    this.trailOwner.set(trailId, controller);
    return t;
  }

  /** After a KEL changes key state, re-run its trails and mark cut entries in the store. */
  protected async refreshTrails(aid: Qb64): Promise<void> {
    const kel = await this.kelResult(aid);
    if (!kel) return;
    for (const [id, t] of this.trails) {
      if (this.trailOwner.get(id) !== aid) continue;
      await t.setKel(kel);
      for (const r of t.cut) await this.store.markCut(id, r.msg.s, r.msg.d, r.cutBy!);
    }
  }

  /**
   * Checks and stores one message. Returns the outcome and, for duplicity, the first-seen version.
   */
  async accept(m: SignedMessage, opts: { checkSkew?: number } = {}): Promise<
    | { ok: true; kind: "kel" | "trail"; witnesses: Qb64[]; fresh: boolean }
    | { ok: false; refusal: Refusal; problems: Problem[]; firstSeen?: SignedMessage }
  > {
    if (KEL_T.has(m.t)) {
      let p = await this.kel(m.logId);
      if (!p) {
        if (m.t !== "icp") return { ok: false, refusal: "unknownController", problems: [problem("unknownKeyState", "no KEL for this AID", m.logId, m.s)] };
        p = new KelProcessor({ allowUnwitnessed: true, ...this.sigOptions });
        this.kels.set(m.logId, p);
      }
      const removed = p.trunk.slice(m.s).map((x) => x.msg);
      const r = await p.addEvent(m);
      if (r.result === "invalid") return { ok: false, refusal: "invalid", problems: [r.problem!] };
      if (r.result === "duplicity") {
        await this.store.put(storedOf(m, this.clock));
        const first = p.trunk[m.s].msg;
        await this.store.putEvidence(p.evidence[p.evidence.length - 1]);
        return { ok: false, refusal: "duplicity", problems: [r.problem!], firstSeen: first };
      }
      if (r.result !== "same") await this.store.put(storedOf(m, this.clock));
      if (r.result === "supersede") {
        for (const x of removed) await this.store.markSuperseded(m.logId, x.s, x.d, m.d);
      }
      if (m.t === "rot" && r.result !== "same") await this.refreshTrails(m.logId);
      const ws = p.trunk[m.s]?.state.witnesses ?? [];
      return { ok: true, kind: "kel", witnesses: ws, fresh: r.result !== "same" };
    }
    if (TRAIL_T.has(m.t)) {
      const controller = await this.controllerOf(m.logId, m);
      if (!controller) return { ok: false, refusal: "unknownController", problems: [problem("unknownKeyState", "unknown trail", m.logId, m.s)] };
      const kel = await this.kelResult(controller);
      if (!kel) return { ok: false, refusal: "unknownController", problems: [problem("unknownKeyState", "no KEL for the trail's controller", m.logId, m.s)] };
      if (opts.checkSkew !== undefined && Date.parse(String(m.body.dt)) > this.clock.now() + opts.checkSkew)
        return { ok: false, refusal: "clockSkew", problems: [problem("badFields", "dt is too far in the future", m.logId, m.s)] };
      let t = await this.trail(m.logId, controller);
      if (!t) {
        t = new TrailProcessor(kel, { allowUnwitnessed: true, ...this.sigOptions });
        this.trails.set(m.logId, t);
        this.trailOwner.set(m.logId, controller);
      }
      const r = await t.add(m);
      if (r.result === "invalid") return { ok: false, refusal: "invalid", problems: [r.problem!] };
      if (r.result === "cut") {
        await this.store.put(storedOf(m, this.clock));
        await this.store.markCut(m.logId, m.s, m.d, r.cutBy!);
        return { ok: false, refusal: "invalid", problems: [problem("staleKeyState", `entry ${m.s} is cut by the rotation at KEL ${r.cutBy}`, m.logId, m.s)] };
      }
      if (r.result === "duplicity") {
        await this.store.put(storedOf(m, this.clock));
        await this.store.putEvidence(t.evidence[t.evidence.length - 1]);
        return { ok: false, refusal: "duplicity", problems: [r.problem!], firstSeen: t.trunk[m.s].msg };
      }
      if (r.result === "first") await this.store.put(storedOf(m, this.clock));
      const est = t.trunk[m.s]?.est;
      return { ok: true, kind: "trail", witnesses: est?.witnesses ?? [], fresh: r.result === "first" };
    }
    return { ok: false, refusal: "invalid", problems: [problem("badFields", `${m.t} can't be submitted`, m.logId, m.s)] };
  }

  /** Checks a receipt (rct or trc) and stores it. Detects witness duplicity. */
  async acceptReceipt(r: SignedMessage, detectedBy: string): Promise<{ stored: Qb64[]; evidence: DuplicityEvidence[] }> {
    const stored: Qb64[] = [];
    const evidence: DuplicityEvidence[] = [];
    const versions = await this.store.versions(r.logId, r.s);
    const target = versions.find((v) => v.d === r.d);
    let witnesses: Qb64[] = [];
    if (r.t === "rct") {
      const p = await this.kel(r.logId);
      const at = p?.trunk[r.s];
      witnesses = at && at.msg.d === r.d ? at.state.witnesses : (p?.latest()?.witnesses ?? []);
    } else if (r.t === "trc" && target && KEL_T.has(target.t)) {
      const p = await this.kel(r.logId);
      const at = p?.trunk[r.s];
      witnesses = at && at.msg.d === r.d ? at.state.witnesses : [];
    } else if (r.t === "trc" && target) {
      const controller = await this.controllerOf(r.logId);
      const kel = controller ? await this.kelResult(controller) : undefined;
      const msg = fromStored(target);
      witnesses = kel?.states.find((s) => s.estSn === msg.keyRefSig?.estSn)?.witnesses ?? [];
    }
    const signed: { by: Qb64; one: SignedMessage }[] = [];
    if (r.t === "rct" && target) {
      for (const w of r.witnessSigs ?? []) {
        const by = witnesses[w.index];
        if (by && verifyCouple(by, utf8(target.raw), w.sig)) signed.push({ by, one: { ...r, witnessSigs: [w], couples: undefined } });
      }
      for (const c of r.couples ?? []) if (verifyCouple(c.signer, utf8(target.raw), c.sig)) signed.push({ by: c.signer, one: { ...r, couples: [c], witnessSigs: undefined } });
    } else if (r.t === "trc") {
      for (const c of r.couples ?? []) if (verifyCouple(c.signer, utf8(r.raw), c.sig)) signed.push({ by: c.signer, one: { ...r, couples: [c] } });
    }
    for (const { by, one } of signed) {
      // witness duplicity: the same signer on another version at this location
      for (const v of versions) {
        // a cut entry and its replacement, or a superseded ixn and its rot, are recovery, not duplicity
        if (v.d === r.d || v.cutBy !== undefined || v.superseded || target?.cutBy !== undefined || target?.superseded) continue;
        const prior = (await this.store.receipts(r.logId, r.s, v.d)).find((x) => x.by === by);
        if (!prior) continue;
        const a = receiptMessage(prior)!;
        const e: DuplicityEvidence = {
          kind: "witness",
          logId: r.logId,
          s: r.s,
          a: r.t === "rct" ? { ...fromStored(v), witnessSigs: a.witnessSigs } : a,
          b: r.t === "rct" && target ? { ...fromStored(target), witnessSigs: one.witnessSigs } : one,
          witness: by,
          detectedBy,
          detectedAt: this.clock.iso(),
        };
        if (r.t === "rct" && !target) continue;
        evidence.push(e);
        await this.store.putEvidence(e);
      }
      if (!target) continue;
      const onKel = KEL_T.has(target.t);
      let kind: "witness" | "endorsement" | "timed" = witnesses.includes(by) ? "witness" : "endorsement";
      if (onKel && r.t === "trc") {
        if (kind !== "witness") continue;
        kind = "timed";
      }
      if (r.t === "rct" && kind !== "witness") continue;
      await this.store.addReceipt(r.logId, r.s, r.d, toStoredReceipt(one, by, kind));
      if (r.t === "rct") (await this.kel(r.logId))?.addReceipt(one);
      if (kind === "timed") (await this.kel(r.logId))?.addTimedReceipt(one);
      stored.push(by);
    }
    return { stored, evidence };
  }

  /** The stored trunk with attachments, followed by every stored receipt. */
  async queryStream(q: { logId: Qb64; from?: number; to?: number }): Promise<string> {
    const msgs = await this.store.range(q.logId, q.from ?? 0, q.to ?? Infinity);
    let out = "";
    for (const m of msgs) {
      out += m.raw + m.attachments;
      for (const r of await this.store.receipts(m.logId, m.s, m.d)) out += r.raw + r.attachments;
    }
    return out;
  }
}

export class Witness extends LogKeeper implements WitnessClient {
  readonly aid: Qb64;
  readonly did: string;
  private readonly signer: Signer;
  private readonly maxSkewMs: number;

  constructor(opts: { signer: Signer; store: LogStore; clock: Clock; maxSkewMs?: number; verify?: SigOptions }) {
    super(opts.store, opts.clock, opts.verify);
    this.signer = opts.signer;
    this.aid = signerAid(opts.signer);
    this.did = didKeyOf(this.aid);
    this.maxSkewMs = opts.maxSkewMs ?? 5 * 60_000;
  }

  private async ownReceipt(m: SignedMessage, witnesses: Qb64[]): Promise<SignedMessage[]> {
    const index = witnesses.indexOf(this.aid);
    if (index < 0) return [];
    const held = (await this.store.receipts(m.logId, m.s, m.d)).filter((r) => r.by === this.aid);
    if (held.length) return held.map((h) => receiptMessage(h)!).filter(Boolean);
    const r = await makeReceipt(m, this.signer, { index, dt: this.clock.iso() });
    await this.store.addReceipt(m.logId, m.s, m.d, toStoredReceipt(r, this.aid, "witness"));
    const out = [r];
    if (r.t === "rct") {
      (await this.kel(m.logId))?.addReceipt(r);
      // and a timed receipt, so "not after" verifies offline (not KERI)
      const timed = await makeTimedReceipt(m, this.signer, this.clock.iso());
      await this.store.addReceipt(m.logId, m.s, m.d, toStoredReceipt(timed, this.aid, "timed"));
      (await this.kel(m.logId))?.addTimedReceipt(timed);
      out.push(timed);
    }
    return out;
  }

  async submit(stream: string): Promise<SubmitResult> {
    const { messages, problems } = fromStream(stream);
    const receipts: SignedMessage[] = [];
    for (const m of messages) {
      if (m.t === "rct" || m.t === "trc") {
        await this.acceptReceipt(m, this.aid);
        continue;
      }
      const r = await this.accept(m, { checkSkew: this.maxSkewMs });
      if (!r.ok) {
        const firstSeen = r.firstSeen ? await this.withReceipts(r.firstSeen) : undefined;
        return { ok: false, refusal: r.refusal, problems: r.problems, ...(firstSeen ? { firstSeen } : {}), receipts: toStream(receipts) };
      }
      receipts.push(...(await this.ownReceipt(m, r.witnesses)));
    }
    if (problems.length) return { ok: false, refusal: "invalid", problems, receipts: toStream(receipts) };
    return { ok: true, receipts: toStream(receipts) };
  }

  private async withReceipts(m: SignedMessage): Promise<string> {
    let out = m.raw + attachmentsOf({ ...m, witnessSigs: undefined });
    for (const r of await this.store.receipts(m.logId, m.s, m.d)) out += r.raw + r.attachments;
    return out;
  }

  async addReceipts(stream: string): Promise<void> {
    for (const m of fromStream(stream).messages) if (m.t === "rct" || m.t === "trc") await this.acceptReceipt(m, this.aid);
  }

  async query(q: { logId: Qb64; from?: number; to?: number }): Promise<string> {
    return this.queryStream(q);
  }

  async head(logId: Qb64): Promise<SignedMessage | undefined> {
    const msgs = await this.store.range(logId);
    for (let i = msgs.length - 1; i >= 0; i--) {
      const own = (await this.store.receipts(logId, msgs[i].s, msgs[i].d)).find((r) => r.by === this.aid && r.kind === "witness");
      if (own) return receiptMessage(own);
    }
    return undefined;
  }

  async evidence(logId?: Qb64): Promise<DuplicityEvidence[]> {
    return this.store.evidence(logId);
  }
}

/** A client for a witness in the same process. Copies through text, as a remote one would. */
export function localWitnessClient(w: Witness): WitnessClient {
  return {
    aid: w.aid,
    submit: (s) => w.submit(s),
    addReceipts: (s) => w.addReceipts(s),
    query: (q) => w.query(q),
    head: async (id) => {
      const h = await w.head(id);
      return h ? fromStream(toStream([h])).messages[0] : undefined;
    },
  };
}
