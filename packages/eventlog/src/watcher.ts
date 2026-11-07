/** Watchers: a verifier's first-seen copies, witness polling, and duplicity evidence (trail design §10). */
import { utf8, type Clock } from "@toip-tools/trust-core";
import type { WitnessClient } from "./client.js";
import { KelProcessor, type KelResult } from "./kel.js";
import { verifyCouple } from "./keys.js";
import { receiptMessage, type LogStore } from "./store.js";
import { fromStream, toStream } from "./stream.js";
import { checkKeyRefSig, cutStatus } from "./trail.js";
import type { DuplicityEvidence, Problem, Qb64, SignedMessage } from "./types.js";
import { LogKeeper } from "./witness.js";

export class Watcher extends LogKeeper {
  readonly id: string;
  private readonly sources: WitnessClient[];
  private readonly watched = new Map<Qb64, Qb64>();

  constructor(opts: { id: string; store: LogStore; sources: WitnessClient[]; clock: Clock }) {
    super(opts.store, opts.clock);
    this.id = opts.id;
    this.sources = [...opts.sources];
  }

  addSource(s: WitnessClient): void {
    this.sources.push(s);
  }

  /** Watch a log. For a trail, `controller` is its AID; for a KEL, the AID itself. */
  watch(logId: Qb64, controller: Qb64): void {
    this.watched.set(logId, controller);
    if (controller !== logId) this.watched.set(controller, controller);
  }

  /** Compares every message in `stream` with the first-seen copies, keeping new ones. */
  async ingest(stream: string, from: string): Promise<{ evidence: DuplicityEvidence[]; problems: Problem[] }> {
    const { messages, problems } = fromStream(stream);
    const evidence: DuplicityEvidence[] = [];
    const receipts: SignedMessage[] = [];
    for (const m of messages) {
      if (m.t === "rct" || m.t === "trc") {
        receipts.push(m);
        continue;
      }
      const r = await this.accept(m);
      if (!r.ok) {
        if (r.refusal === "duplicity") {
          const e = (await this.store.evidence(m.logId)).filter((x) => x.s === m.s && x.kind === "controller");
          for (const x of e) {
            const tagged = { ...x, detectedBy: `${this.id} (from ${from})` };
            if (!evidence.some((y) => y.a.d === x.a.d && y.b.d === x.b.d)) evidence.push(tagged);
          }
        } else if (r.refusal !== "unknownController") problems.push(...r.problems);
      }
    }
    for (const r of receipts) {
      const got = await this.acceptReceipt(r, `${this.id} (from ${from})`);
      evidence.push(...got.evidence);
    }
    return { evidence, problems };
  }

  /** Asks every source for the head of each watched log, and fetches what differs. */
  async poll(): Promise<DuplicityEvidence[]> {
    const out: DuplicityEvidence[] = [];
    // KELs first, so trails can be checked against them
    const ids = [...this.watched.keys()].sort((a, b) => Number(this.watched.get(a) !== a) - Number(this.watched.get(b) !== b));
    for (const logId of ids) {
      for (const src of this.sources) {
        let head: SignedMessage | undefined;
        try {
          head = await src.head(logId);
        } catch {
          continue;
        }
        const mine = await this.store.head(logId);
        const held = head ? (await this.store.versions(logId, head.s)).some((v) => v.d === head!.d) : true;
        if (head && held && (await this.store.receipts(logId, head.s, head.d)).some((r) => r.by === src.aid)) continue;
        // from the last location both hold, so a different version there shows as duplicity, not just a broken chain
        const from = !mine ? 0 : head ? Math.min(head.s, mine.s) : mine.s + 1;
        try {
          const kelId = this.watched.get(logId)!;
          if (kelId !== logId && !(await this.kel(kelId))) await this.ingest(await src.query({ logId: kelId }), src.aid);
          const got = await this.ingest(await src.query({ logId, from: Math.max(0, from) }), src.aid);
          out.push(...got.evidence);
          if (head) out.push(...(await this.ingest(toStream([head]), src.aid)).evidence);
        } catch {
          // a source that fails is skipped; the next poll tries again
        }
      }
    }
    return out;
  }

  async heads(logId: Qb64): Promise<{ source: string; s: number; d: Qb64; receipt: SignedMessage }[]> {
    const out: { source: string; s: number; d: Qb64; receipt: SignedMessage }[] = [];
    for (const src of this.sources) {
      try {
        const h = await src.head(logId);
        if (h) out.push({ source: src.aid, s: h.s, d: h.d, receipt: h });
      } catch {
        // unreachable sources are left out
      }
    }
    return out;
  }

  async evidence(logId?: Qb64): Promise<DuplicityEvidence[]> {
    return this.store.evidence(logId);
  }

  /** This watcher as a source for other watchers (gossip). Its head is the latest witness receipt it holds. */
  asSource(): WitnessClient {
    return {
      aid: this.id,
      submit: async () => ({ ok: false, refusal: "invalid", problems: [{ code: "badFields", message: "a watcher does not witness" }] }),
      addReceipts: async (s) => {
        await this.ingest(s, "peer");
      },
      query: (q) => this.queryStream(q),
      head: async (logId) => {
        const msgs = await this.store.range(logId);
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].cutBy !== undefined || msgs[i].superseded) continue;
          const r =(await this.store.receipts(logId, msgs[i].s, msgs[i].d)).find((x) => x.kind === "witness");
          if (r) return receiptMessage(r);
        }
        return undefined;
      },
    };
  }
}

/** Checks evidence with only the evidence and the controller's KEL. */
export async function verifyEvidence(e: DuplicityEvidence, kel: KelResult): Promise<boolean> {
  try {
    const { a, b } = e;
    if (a.logId !== e.logId || b.logId !== e.logId || a.s !== e.s || b.s !== e.s || a.d === b.d) return false;
    if (e.kind === "controller") {
      if (a.t === "icp" || a.t === "rot" || a.t === "ixn") {
        if (e.logId !== kel.aid) return false;
        // A0: a rot superseding an ixn is recovery, not duplicity
        if ((a.t === "rot" && b.t === "ixn") || (a.t === "ixn" && b.t === "rot")) return false;
        for (const m of [a, b]) if (!(await kelEventSigned(m, kel))) return false;
        return true;
      }
      for (const m of [a, b]) {
        const est = await checkKeyRefSig(m, kel);
        if ("code" in est) return false;
        const c = cutStatus(kel, e.logId, est, m.s);
        if ("cut" in c && c.cut) return false;
      }
      return true;
    }
    if (!e.witness) return false;
    for (const m of [a, b]) {
      if (m.t === "trc") {
        const c = m.couples?.find((x) => x.signer === e.witness);
        if (!c || !verifyCouple(e.witness, utf8(m.raw), c.sig)) return false;
      } else {
        const st = kel.states.filter((s) => s.estSn <= m.s).pop();
        const index = st?.witnesses.indexOf(e.witness) ?? -1;
        const w = m.witnessSigs?.find((x) => x.index === index);
        if (index < 0 || !w || !verifyCouple(e.witness, utf8(m.raw), w.sig)) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function kelEventSigned(m: SignedMessage, kel: KelResult): Promise<boolean> {
  // validate the event against the state before it
  const proc = new KelProcessor({ allowUnwitnessed: true });
  for (const p of kel.messages.slice(0, m.s)) await proc.addEvent({ ...p });
  if (proc.trunk.length !== m.s) return false;
  const r = await proc.addEvent(m);
  return r.result === "first";
}
