/** The writing side: a controller's KEL and its trails (trail design §8, §9.3, §13.2). */
import { utf8, type Clock, type Identity } from "@zk-toip/trust-core";
import { bindingSeal, makeBinding, type DidBinding } from "./binding";
import { nextKeyDigest } from "./cesr";
import { WitnessError, withTimeout, type WitnessClient } from "./client";
import { buildIcp, buildIxn, buildRot, KelProcessor, type KeyState } from "./kel";
import { curveOf, keyQb64, signWith, verifyCouple, type ColdKeys, type SigOptions, type Signer } from "./keys";
import { makeBody } from "./said";
import { fromStored, receiptMessage, type LogStore, type StoredMessage } from "./store";
import { attachmentsOf, fromStream, toStream } from "./stream";
import { buildTcl, buildTen, buildTin, TrailProcessor } from "./trail";
import { toStoredReceipt } from "./receipts";
import type { Body, DuplicityEvidence, IndexedSig, IndexedSigCode, Qb64, Seal, SignedMessage } from "./types";

export interface InceptOptions {
  /** Current keys. */
  hot: Signer[];
  /** The rotation seed side. Optional when `next` is given. */
  cold?: ColdKeys;
  /** How many next keys to derive from `cold`. Default: as many as `hot`. */
  nextCount?: number;
  /** Next-key digests held by someone else, such as the agent's principal. Added after the cold ones. (Additive.) */
  extraNext?: Qb64[];
  /** All next-key digests, replacing cold and extraNext. (Additive.) */
  next?: Qb64[];
  kt?: number;
  nt?: number;
  witnesses?: Qb64[];
  bt?: number;
  anchors?: Seal[];
  /** A small data object put in the inception's `a`, such as a device's messaging DID and key class. (Additive.) */
  data?: Record<string, string | number | boolean>;
  /** Signs a DID binding with this identity and seals it in an ixn right after inception. (Additive.) */
  bind?: Identity;
  /** Configuration traits: [] or ["DND"]. */
  traits?: string[];
  checkpoint?: { everyEntries?: number; everyMs?: number };
  store: LogStore;
  clock: Clock;
  /** Signature options used when the controller checks its own log. */
  verify?: SigOptions;
}

export interface RotateOptions {
  kt?: number;
  nt?: number;
  nextCount?: number;
  /** Next-key digests held elsewhere, added after the cold ones. (Additive.) */
  extraNext?: Qb64[];
  /** All new next-key digests. Empty abandons the AID. (Additive.) */
  next?: Qb64[];
  addWitnesses?: Qb64[];
  removeWitnesses?: Qb64[];
  bt?: number;
  anchors?: Seal[];
  /** Recovery: seal these trails at these s, not at their heads. */
  cutAfter?: Record<Qb64, number>;
  /** Recovery: place the rot at this KEL sn, superseding ixns. */
  supersede?: number;
  /** Signers of prior next keys held elsewhere (custody patterns). They become the new current keys. */
  exposed?: Signer[];
}

export interface PublishReport {
  sent: number;
  receipted: { logId: Qb64; s: number; witnesses: Qb64[] }[];
  missing: { witness: Qb64; error: string }[];
  evidence: DuplicityEvidence[];
}

const hex = (n: number) => n.toString(16);
const half = (n: number) => Math.max(1, Math.ceil(n / 2));

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(fn, fn);
    this.tail = p.catch(() => {});
    return p;
  }
}

function sigCode(s: Signer, dual: boolean, big: boolean): IndexedSigCode {
  const p = curveOf(s) === "p256";
  if (big) return (dual ? (p ? "2E" : "2A") : p ? "2F" : "2B") as IndexedSigCode;
  return (dual ? (p ? "E" : "A") : p ? "F" : "B") as IndexedSigCode;
}

/** Signs `raw` with signers at their positions in `keys`. */
async function signAt(raw: string, signers: Signer[], keys: Qb64[], priorNext?: Qb64[]): Promise<IndexedSig[]> {
  const out: IndexedSig[] = [];
  for (const s of signers) {
    const k = keyQb64(s);
    const index = keys.indexOf(k);
    if (index < 0) throw new Error(`signer ${k} is not a current key`);
    const { sig, wrap } = await signWith(s, utf8(raw));
    let code: IndexedSigCode;
    let ondex: number | undefined = index;
    if (priorNext) {
      const j = priorNext.indexOf(nextKeyDigest(k));
      if (j < 0) {
        code = sigCode(s, false, index > 63);
        ondex = undefined;
      } else if (j === index && index < 64) code = sigCode(s, true, false);
      else {
        code = sigCode(s, true, true);
        ondex = j;
      }
    } else code = sigCode(s, true, index > 63);
    const one: IndexedSig = { code, index, sig };
    if (ondex !== undefined) one.ondex = ondex;
    if (wrap) one.wrap = wrap;
    out.push(one);
  }
  return out;
}

function stored(m: SignedMessage, clock: Clock, local = true): StoredMessage {
  return { logId: m.logId, s: m.s, d: m.d, t: m.t, raw: m.raw, attachments: attachmentsOf({ ...m, witnessSigs: undefined }), fn: 0, seenAt: clock.iso(), local };
}

function mkMessage(t: SignedMessage["t"], raw: string, body: Record<string, unknown>): SignedMessage {
  return { t, raw, body, logId: String(body.i), s: parseInt(String(body.s), 16), d: String(body.d) };
}

export class Controller {
  private hot: Signer[];
  private readonly cold?: ColdKeys;
  private readonly lock = new Mutex();
  private readonly trailMap = new Map<Qb64, Trail>();
  private readonly sentTo = new Map<Qb64, Set<string>>();
  private readonly forwarded = new Map<Qb64, Set<string>>();
  private lastCheckpoint: { entries: number; at: number } = { entries: 0, at: 0 };

  private constructor(
    readonly aid: Qb64,
    private readonly kel: KelProcessor,
    hot: Signer[],
    cold: ColdKeys | undefined,
    readonly store: LogStore,
    readonly clock: Clock,
    private readonly checkpoint?: { everyEntries?: number; everyMs?: number },
  ) {
    this.hot = hot;
    this.cold = cold;
    this.lastCheckpoint.at = clock.now();
  }

  static async incept(opts: InceptOptions): Promise<Controller> {
    if (!opts.hot.length) throw new Error("incept needs at least one current key");
    const keys = opts.hot.map(keyQb64);
    let next: Qb64[];
    if (opts.next) next = opts.next;
    else {
      if (!opts.cold) throw new Error("incept needs cold keys or next-key digests");
      next = [...opts.cold.commit(1, opts.nextCount ?? opts.hot.length), ...(opts.extraNext ?? [])];
    }
    if (!next.length) throw new Error("only transferable AIDs are incepted");
    const witnesses = opts.witnesses ?? [];
    const anchors: unknown[] = [...(opts.anchors ?? [])];
    if (opts.data) anchors.push({ ...opts.data });
    const { raw, body } = buildIcp({
      keys,
      kt: opts.kt ?? half(keys.length),
      next,
      nt: opts.nt ?? half(next.length),
      witnesses,
      bt: opts.bt ?? (witnesses.length ? half(witnesses.length) : 0),
      traits: opts.traits,
      anchors,
    });
    const msg = mkMessage("icp", raw, body);
    msg.controllerSigs = await signAt(raw, opts.hot, keys);
    const kel = new KelProcessor({ allowUnwitnessed: true, ...opts.verify });
    const r = await kel.addEvent(msg);
    if (r.result !== "first") throw new Error(`inception is invalid: ${r.problem?.message}`);
    await opts.store.put(stored(msg, opts.clock));
    const c = new Controller(msg.logId, kel, opts.hot, opts.cold, opts.store, opts.clock, opts.checkpoint);
    if (opts.bind) await c.bind(opts.bind);
    return c;
  }

  /** Loads a controller from its store and re-verifies its logs. With only hot keys it can append and interact, not rotate. */
  static async load(aid: Qb64, opts: { hot?: Signer[]; cold?: ColdKeys; store: LogStore; clock: Clock; checkpoint?: InceptOptions["checkpoint"]; verify?: SigOptions }): Promise<Controller> {
    const kel = new KelProcessor({ allowUnwitnessed: true, ...opts.verify });
    for (const m of await opts.store.all(aid)) {
      const msg = fromStored(m);
      const r = await kel.addEvent(msg);
      if (r.result === "invalid" || r.result === "duplicity") throw new Error(`stored KEL is invalid at ${m.s}: ${r.problem?.message}`);
    }
    const latest = kel.latest();
    if (!latest) throw new Error(`no KEL for ${aid}`);
    for (const p of kel.trunk)
      for (const r of await opts.store.receipts(aid, p.msg.s, p.msg.d)) {
        const rm = receiptMessage(r);
        if (rm) kel.addReceipt(rm);
      }
    let hot = opts.hot;
    if (!hot) {
      if (!opts.cold) throw new Error("load needs hot keys or cold keys");
      hot = opts.cold.release(kel.states.length - 1, latest.keys.length);
    }
    const c = new Controller(aid, kel, hot, opts.cold, opts.store, opts.clock, opts.checkpoint);
    for (const log of await opts.store.logs()) {
      if (log.kind !== "trail" || log.controller !== aid) continue;
      await c.loadTrail(log.logId);
    }
    return c;
  }

  private async loadTrail(id: Qb64): Promise<Trail> {
    const tp = new TrailProcessor(this.kel.result(), { allowUnwitnessed: true });
    for (const m of await this.store.all(id)) await tp.add(fromStored(m));
    const head = tp.head();
    if (!head) throw new Error(`stored trail ${id} is invalid`);
    const last = tp.trunk[tp.trunk.length - 1];
    const t = new Trail(this, id, tp.purpose, tp.trunk.map((r) => r.msg.d), String(last.msg.body.dt), tp.closed(), last.msg.keyRefSig?.estSn);
    this.trailMap.set(id, t);
    return t;
  }

  state(): KeyState {
    return { ...this.kel.latest()! };
  }

  /** The current signers, so the caller can keep them (sealed) after a rotation. */
  signers(): Signer[] {
    return [...this.hot];
  }

  kelMessages(): SignedMessage[] {
    return this.kel.result().messages;
  }

  /** The head of the KEL as a seal {i, s, d}: what a third party can anchor. */
  headSeal(): { i: Qb64; s: string; d: Qb64 } {
    const st = this.state();
    return { i: this.aid, s: hex(st.sn), d: st.said };
  }

  /** Runs `fn` under the controller's lock. Internal. */
  locked<T>(fn: () => Promise<T>): Promise<T> {
    return this.lock.run(fn);
  }

  private async addOwn(msg: SignedMessage): Promise<void> {
    const r = await this.kel.addEvent(msg);
    if (r.result !== "first" && r.result !== "supersede") throw new Error(`event is invalid: ${r.problem?.message ?? r.result}`);
    await this.store.put(stored(msg, this.clock));
  }

  interact(anchors: (Seal | Record<string, unknown>)[]): Promise<SignedMessage> {
    return this.lock.run(() => this.interactUnlocked(anchors));
  }

  private async interactUnlocked(anchors: (Seal | Record<string, unknown>)[]): Promise<SignedMessage> {
    const st = this.state();
    if (st.abandoned) throw new Error("the AID was abandoned");
    const { raw, body } = buildIxn({ aid: this.aid, s: st.sn + 1, prior: st.said, anchors });
    const msg = mkMessage("ixn", raw, body);
    msg.controllerSigs = await signAt(raw, this.hot, st.keys);
    await this.addOwn(msg);
    return msg;
  }

  /** A checkpoint: an ixn sealing every open trail's head. */
  checkpointNow(): Promise<SignedMessage> {
    return this.lock.run(() => this.checkpointUnlocked());
  }

  private async checkpointUnlocked(): Promise<SignedMessage> {
    const seals = this.trails()
      .filter((t) => !t.isClosed() || t.headSignedIn(this.state().estSn))
      .map((t) => t.ref());
    this.lastCheckpoint = { entries: 0, at: this.clock.now() };
    return this.interactUnlocked(seals);
  }

  /** Called by Trail after each entry. */
  async afterEntry(): Promise<void> {
    if (!this.checkpoint) return;
    this.lastCheckpoint.entries++;
    const { everyEntries, everyMs } = this.checkpoint;
    if ((everyEntries && this.lastCheckpoint.entries >= everyEntries) || (everyMs && this.clock.now() - this.lastCheckpoint.at >= everyMs))
      await this.checkpointUnlocked();
  }

  rotate(opts: RotateOptions = {}): Promise<SignedMessage> {
    return this.lock.run(() => this.rotateUnlocked(opts));
  }

  private async rotateUnlocked(opts: RotateOptions): Promise<SignedMessage> {
    const latest = this.state();
    if (latest.abandoned) throw new Error("the AID was abandoned");
    const estCount = this.kel.states.length;
    let sn = latest.sn + 1;
    let prior = latest.said;
    if (opts.supersede !== undefined) {
      const tail = this.kel.trunk.slice(opts.supersede);
      if (opts.supersede < 1 || opts.supersede > latest.sn + 1 || tail.some((p) => p.msg.t !== "ixn")) throw new Error("a rotation can only supersede interaction events");
      sn = opts.supersede;
      prior = this.kel.trunk[sn - 1].msg.d;
    }
    const priorState = latest; // ixns don't change key state, so this is the state before `sn`
    let signers = opts.exposed;
    if (!signers) {
      if (!this.cold) throw new Error("rotation needs the cold keys (or exposed signers)");
      let own = 0;
      for (let k = priorState.next.length; k >= 1; k--) {
        if (this.cold.commit(estCount, k).every((d) => priorState.next.includes(d))) {
          own = k;
          break;
        }
      }
      if (!own) throw new Error("the cold keys don't match the committed next keys");
      signers = this.cold.release(estCount, own);
    }
    const keys = signers.map(keyQb64);
    let next: Qb64[];
    if (opts.next) next = opts.next;
    else {
      if (!this.cold) throw new Error("rotation needs the cold keys or explicit next digests");
      next = [...this.cold.commit(estCount + 1, opts.nextCount ?? signers.length), ...(opts.extraNext ?? [])];
    }
    const cuts = opts.removeWitnesses ?? [];
    const adds = opts.addWitnesses ?? [];
    const witnesses = [...priorState.witnesses.filter((w) => !cuts.includes(w)), ...adds];
    const bt = opts.bt ?? Math.min(priorState.bt, witnesses.length);

    // seal every open trail, and every trail with messages in the outgoing epoch
    const seals: Seal[] = [];
    const cutAfter = opts.cutAfter ?? {};
    for (const id of Object.keys(cutAfter)) if (!this.trailMap.has(id)) throw new Error(`unknown trail ${id}`);
    for (const t of this.trails()) {
      if (t.id in cutAfter) seals.push(t.ref(cutAfter[t.id]));
      else if (!t.isClosed() || t.headSignedIn(priorState.estSn)) seals.push(t.ref());
    }
    const { raw, body } = buildRot({
      aid: this.aid,
      s: sn,
      prior,
      keys,
      kt: opts.kt ?? half(keys.length),
      next,
      nt: opts.nt ?? (next.length ? half(next.length) : 0),
      bt,
      cuts,
      adds,
      anchors: [...seals, ...(opts.anchors ?? [])],
    });
    const msg = mkMessage("rot", raw, body);
    msg.controllerSigs = await signAt(raw, signers, keys, priorState.next);
    const before = this.kel.trunk.slice(sn).map((p) => p.msg);
    await this.addOwn(msg);
    for (const old of before) await this.store.markSuperseded(this.aid, old.s, old.d, msg.d);
    this.hot = signers;
    for (const [id, s] of Object.entries(cutAfter)) await this.trailMap.get(id)!.truncateTo(s, msg.s);
    return msg;
  }

  async openTrail(purpose: string): Promise<Trail> {
    return this.lock.run(async () => {
      const st = this.state();
      const { raw, body } = buildTin({ controller: this.aid, dt: this.clock.iso(), purpose });
      const msg = mkMessage("tin", raw, body);
      msg.keyRefSig = { aid: this.aid, estSn: st.estSn, estSaid: st.estSaid, sigs: await signAt(raw, this.hot, st.keys) };
      await this.store.put(stored(msg, this.clock));
      const t = new Trail(this, msg.d, purpose, [msg.d], String(body.dt), false, st.estSn);
      this.trailMap.set(msg.d, t);
      return t;
    });
  }

  trail(id: Qb64): Trail {
    const t = this.trailMap.get(id);
    if (!t) throw new Error(`unknown trail ${id}`);
    return t;
  }

  trails(): Trail[] {
    return [...this.trailMap.values()];
  }

  /** Signs a DID binding and seals it via ixn. */
  async bind(identity: Identity, replaces?: Qb64): Promise<DidBinding> {
    const b = makeBinding(identity, this.aid, this.clock, replaces);
    await this.store.putBody(bindingSeal(b).d, JSON.stringify(b));
    await this.interact([bindingSeal(b)]);
    return b;
  }

  /** Signs trail messages for the current key state. Internal. */
  async signTrail(raw: string): Promise<SignedMessage["keyRefSig"]> {
    const st = this.state();
    return { aid: this.aid, estSn: st.estSn, estSaid: st.estSaid, sigs: await signAt(raw, this.hot, st.keys) };
  }

  // ---- publishing

  private async messagesToPublish(): Promise<{ msg: SignedMessage; witnesses: Qb64[] }[]> {
    const out: { msg: SignedMessage; witnesses: Qb64[] }[] = [];
    for (const p of this.kel.trunk) out.push({ msg: p.msg, witnesses: p.state.witnesses });
    const kel = this.kel.result();
    for (const t of this.trails()) {
      for (const m of await this.store.range(t.id)) {
        if (m.cutBy !== undefined) continue;
        const msg = fromStored(m);
        const est = kel.states.find((s) => s.estSn === msg.keyRefSig?.estSn);
        out.push({ msg, witnesses: est?.witnesses ?? [] });
      }
    }
    return out;
  }

  /** Submits messages each witness hasn't receipted, then forwards receipts round-robin. */
  async publish(witnesses: WitnessClient[], opts: { timeoutMs?: number } = {}): Promise<PublishReport> {
    const timeoutMs = opts.timeoutMs ?? 5000;
    const report: PublishReport = { sent: 0, receipted: [], missing: [], evidence: [] };
    const all = await this.messagesToPublish();
    const got = new Map<string, Set<Qb64>>();
    const key = (m: { logId: Qb64; s: number; d: Qb64 }) => `${m.logId}|${m.s}|${m.d}`;
    await Promise.all(
      witnesses.map(async (w) => {
        const sent = this.sentTo.get(w.aid) ?? new Set<string>();
        this.sentTo.set(w.aid, sent);
        const todo: SignedMessage[] = [];
        let applicable = false;
        for (const { msg, witnesses: ws } of all) {
          const receipted = (await this.store.receipts(msg.logId, msg.s, msg.d)).some((r) => r.by === w.aid);
          if (receipted || sent.has(key(msg))) continue;
          todo.push(msg);
          if (ws.includes(w.aid)) applicable = true;
        }
        if (!applicable) return;
        report.sent += todo.length;
        try {
          const res = await withTimeout(w.submit(toStream(todo.map((m) => ({ ...m, witnessSigs: undefined })))), timeoutMs, `witness ${w.aid}`);
          const receipts = res.ok ? res.receipts : (res.receipts ?? "");
          for (const r of fromStream(receipts).messages) {
            const stored = await this.storeReceipt(r, w.aid);
            if (stored) (got.get(key(r)) ?? got.set(key(r), new Set()).get(key(r))!).add(w.aid);
          }
          if (res.ok) for (const m of todo) sent.add(key(m));
          else {
            report.missing.push({ witness: w.aid, error: `${res.refusal}: ${res.problems.map((p) => p.message).join("; ")}` });
            if (res.refusal === "duplicity" && res.firstSeen) {
              const first = fromStream(res.firstSeen).messages.find((m) => m.t !== "rct" && m.t !== "trc");
              const mine = first && todo.find((m) => m.logId === first.logId && m.s === first.s);
              if (first && mine)
                report.evidence.push({ kind: "controller", logId: first.logId, s: first.s, a: first, b: mine, detectedBy: `witness ${w.aid}`, detectedAt: this.clock.iso() });
            }
          }
        } catch (e) {
          report.missing.push({ witness: w.aid, error: e instanceof Error ? e.message : String(e) });
        }
      }),
    );
    for (const [k, ws] of got) {
      const [logId, s] = k.split("|");
      report.receipted.push({ logId, s: Number(s), witnesses: [...ws] });
    }
    // round robin: give each witness the receipts it doesn't have from the others
    await Promise.all(
      witnesses.map(async (w) => {
        const fwd = this.forwarded.get(w.aid) ?? new Set<string>();
        this.forwarded.set(w.aid, fwd);
        const out: SignedMessage[] = [];
        for (const { msg } of all) {
          for (const r of await this.store.receipts(msg.logId, msg.s, msg.d)) {
            const id = `${key(msg)}|${r.by}`;
            if (r.by === w.aid || r.kind !== "witness" || fwd.has(id)) continue;
            const rm = receiptMessage(r);
            if (rm) {
              out.push(rm);
              fwd.add(id);
            }
          }
        }
        if (!out.length) return;
        try {
          await withTimeout(w.addReceipts(toStream(out)), timeoutMs, `witness ${w.aid}`);
        } catch {
          for (const r of out) fwd.delete(`${key(r)}|${r.couples?.[0]?.signer ?? ""}`);
        }
      }),
    );
    return report;
  }

  /** Stores a receipt if it is a valid receipt by `by`. Returns whether it was. */
  private async storeReceipt(r: SignedMessage, by: Qb64): Promise<boolean> {
    if (r.t === "rct") {
      const added = this.kel.addReceipt(r);
      if (!added.includes(by)) return (await this.store.receipts(r.logId, r.s, r.d)).some((x) => x.by === by);
      await this.store.addReceipt(r.logId, r.s, r.d, toStoredReceipt(r, by, "witness"));
      return true;
    }
    if (r.t === "trc") {
      const t = this.trailMap.get(r.logId);
      if (!t) return false;
      const kel = this.kel.result();
      const held = await this.store.versions(r.logId, r.s);
      const m = held.find((x) => x.d === r.d);
      if (!m) return false;
      const msg = fromStored(m);
      const est = kel.states.find((s) => s.estSn === msg.keyRefSig?.estSn);
      if (!est?.witnesses.includes(by)) return false;
      const c = r.couples?.find((x) => x.signer === by);
      if (!c) return false;
      if (!verifyCouple(by, utf8(r.raw), c.sig)) return false;
      await this.store.addReceipt(r.logId, r.s, r.d, toStoredReceipt({ ...r, couples: [c] }, by, "witness"));
      return true;
    }
    return false;
  }

  /** Number of witness receipts held for a message. */
  async receiptCount(m: { logId: Qb64; s: number; d: Qb64 }): Promise<number> {
    return (await this.store.receipts(m.logId, m.s, m.d)).filter((r) => r.kind === "witness").length;
  }
}

export class Trail {
  constructor(
    private readonly c: Controller,
    readonly id: Qb64,
    readonly purpose: string,
    private ds: Qb64[],
    private lastDt: string,
    private closed: boolean,
    private headEst?: number,
  ) {}

  get controller(): Qb64 {
    return this.c.aid;
  }

  isClosed(): boolean {
    return this.closed;
  }

  /** Whether the head was signed under the key state of establishment event `estSn`. Internal. */
  headSignedIn(estSn: number): boolean {
    return this.headEst === undefined || this.headEst === estSn;
  }

  head(): { s: number; d: Qb64 } {
    return { s: this.ds.length - 1, d: this.ds[this.ds.length - 1] };
  }

  /** {i, s, d}, for trailRef in Trust Tasks and seals. */
  ref(s = this.ds.length - 1): { i: Qb64; s: string; d: Qb64 } {
    const d = this.ds[s];
    if (!d) throw new Error(`no entry ${s}`);
    return { i: this.id, s: hex(s), d };
  }

  /** Internal: after a recovery, entries after `s` are cut. */
  async truncateTo(s: number, kelSn: number): Promise<void> {
    for (let k = s + 1; k < this.ds.length; k++) await this.c.store.markCut(this.id, k, this.ds[k], kelSn);
    this.ds = this.ds.slice(0, s + 1);
    this.closed = false;
  }

  private now(): string {
    const now = this.c.clock.iso();
    return now < this.lastDt ? this.lastDt : now;
  }

  append(input: { kind: string; body?: Record<string, unknown>; refs?: Seal[] }): Promise<{ entry: SignedMessage; body?: Body }> {
    return this.c.locked(async () => {
      if (this.closed) throw new Error("the trail is closed");
      let body: Body | undefined;
      let said: Qb64 | "" = "";
      if (input.body) {
        const b = makeBody(input.body);
        body = b.body;
        said = b.said;
        await this.c.store.putBody(b.said, b.raw);
      }
      const dt = this.now();
      const { raw, body: header } = buildTen({ trailId: this.id, s: this.ds.length, prior: this.ds[this.ds.length - 1], dt, kind: input.kind, bodySaid: said, refs: input.refs ?? [] });
      const entry = mkMessage("ten", raw, header);
      entry.keyRefSig = await this.c.signTrail(raw);
      await this.c.store.put(stored(entry, this.c.clock));
      this.ds.push(entry.d);
      this.lastDt = dt;
      this.headEst = entry.keyRefSig!.estSn;
      await this.c.afterEntry();
      return { entry, ...(body ? { body } : {}) };
    });
  }

  /**
   * Appends, publishes, and waits for the witness threshold (at least one receipt).
   * Throws WitnessError if it isn't met: the caller must not act. The entry stays in the log, pending.
   */
  async appendWitnessed(
    input: { kind: string; body?: Record<string, unknown>; refs?: Seal[] },
    witnesses: WitnessClient[],
    opts: { timeoutMs?: number } = {},
  ): Promise<{ entry: SignedMessage; body?: Body; receipts: SignedMessage[] }> {
    const res = await this.append(input);
    const needed = Math.max(1, this.c.state().bt);
    const report = await this.c.publish(witnesses, opts);
    const receipts = (await this.c.store.receipts(res.entry.logId, res.entry.s, res.entry.d)).filter((r) => r.kind === "witness");
    if (receipts.length < needed)
      throw new WitnessError(`entry ${res.entry.s} has ${receipts.length} of ${needed} witness receipts`, {
        entry: res.entry,
        receipts: receipts.length,
        needed,
        missing: report.missing,
      });
    return { ...res, receipts: receipts.map((r) => receiptMessage(r)!).filter(Boolean) };
  }

  close(): Promise<SignedMessage> {
    return this.c.locked(async () => {
      if (this.closed) throw new Error("the trail is closed");
      const dt = this.now();
      const { raw, body } = buildTcl({ trailId: this.id, s: this.ds.length, prior: this.ds[this.ds.length - 1], dt });
      const msg = mkMessage("tcl", raw, body);
      msg.keyRefSig = await this.c.signTrail(raw);
      await this.c.store.put(stored(msg, this.c.clock));
      this.ds.push(msg.d);
      this.lastDt = dt;
      this.headEst = msg.keyRefSig!.estSn;
      this.closed = true;
      return msg;
    });
  }
}
