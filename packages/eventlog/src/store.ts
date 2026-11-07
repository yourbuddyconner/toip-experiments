/** Log storage: first-seen versions, receipts, bodies and evidence. Never overwrites. */
import { fromStream, toStream } from "./stream";
import type { DuplicityEvidence, MessageType, Qb64, SignedMessage } from "./types";

export interface StoredMessage {
  logId: Qb64;
  s: number;
  d: Qb64;
  t: MessageType;
  raw: string;
  /** CESR text of the controller's signatures. */
  attachments: string;
  /** First-seen ordinal in this store. */
  fn: number;
  seenAt: string;
  /** Made here, or received. */
  local: boolean;
  superseded?: Qb64;
  cutBy?: number;
}

export interface StoredReceipt {
  by: Qb64;
  /** "timed": a witness's trc over a KEL event, giving its time (ours, additive). */
  kind: "witness" | "endorsement" | "timed";
  raw: string;
  attachments: string;
  dt?: string;
}

export interface LogStore {
  /** "first": stored as first seen. "same": already held. "other": another version is first seen; this one is kept as a version. */
  put(m: StoredMessage): Promise<"first" | "same" | "other">;
  /** The trunk version: the first seen that is not superseded or cut, else the first seen. */
  get(logId: Qb64, s: number): Promise<StoredMessage | undefined>;
  /** Every version seen, in first-seen order. */
  versions(logId: Qb64, s: number): Promise<StoredMessage[]>;
  /** Trunk, ascending. */
  range(logId: Qb64, from?: number, to?: number): Promise<StoredMessage[]>;
  /** Every version of every location, in first-seen order. (Additive.) */
  all(logId: Qb64): Promise<StoredMessage[]>;
  head(logId: Qb64): Promise<StoredMessage | undefined>;
  markSuperseded(logId: Qb64, s: number, d: Qb64, by: Qb64): Promise<void>;
  markCut(logId: Qb64, s: number, d: Qb64, byKelSn: number): Promise<void>;
  /** Idempotent per (by, d, kind). */
  addReceipt(logId: Qb64, s: number, d: Qb64, r: StoredReceipt): Promise<void>;
  receipts(logId: Qb64, s: number, d: Qb64): Promise<StoredReceipt[]>;
  putBody(said: Qb64, raw: string): Promise<void>;
  getBody(said: Qb64): Promise<string | undefined>;
  putEvidence(e: DuplicityEvidence): Promise<void>;
  evidence(logId?: Qb64): Promise<DuplicityEvidence[]>;
  logs(): Promise<{ logId: Qb64; kind: "kel" | "trail"; controller: Qb64 }[]>;
}

/** Evidence as JSON: its two messages as CESR text. */
export interface StoredEvidence extends Omit<DuplicityEvidence, "a" | "b"> {
  a: string;
  b: string;
}

export interface StoreData {
  messages: StoredMessage[];
  receipts: [string, StoredReceipt[]][];
  bodies: [Qb64, string][];
  evidence: StoredEvidence[];
  fn: number;
}

const rkey = (logId: Qb64, s: number, d: Qb64) => `${logId}|${s}|${d}`;
const KEL: MessageType[] = ["icp", "rot", "ixn"];

export function evidenceToJson(e: DuplicityEvidence): StoredEvidence {
  return { ...e, a: toStream([e.a]), b: toStream([e.b]) };
}

export function evidenceFromJson(e: StoredEvidence): DuplicityEvidence {
  return { ...e, a: fromStream(e.a).messages[0], b: fromStream(e.b).messages[0] };
}

export class MemoryStore implements LogStore {
  protected readonly byLog = new Map<Qb64, Map<number, StoredMessage[]>>();
  protected readonly meta = new Map<Qb64, { kind: "kel" | "trail"; controller: Qb64 }>();
  protected readonly receiptMap = new Map<string, StoredReceipt[]>();
  protected readonly bodies = new Map<Qb64, string>();
  protected readonly evidenceList: StoredEvidence[] = [];
  protected fn = 0;

  constructor(data?: StoreData) {
    if (data) this.load(data);
  }

  protected changed(): void {}

  protected load(data: StoreData): void {
    for (const m of data.messages) this.insert(m);
    for (const [k, v] of data.receipts) this.receiptMap.set(k, v);
    for (const [k, v] of data.bodies) this.bodies.set(k, v);
    this.evidenceList.push(...data.evidence);
    this.fn = Math.max(this.fn, data.fn);
  }

  /** Everything, as JSON-safe data. */
  dump(): StoreData {
    const messages = [...this.byLog.values()].flatMap((m) => [...m.values()].flat()).sort((a, b) => a.fn - b.fn);
    return {
      messages: messages.map((m) => ({ ...m })),
      receipts: [...this.receiptMap.entries()],
      bodies: [...this.bodies.entries()],
      evidence: [...this.evidenceList],
      fn: this.fn,
    };
  }

  private insert(m: StoredMessage): void {
    let log = this.byLog.get(m.logId);
    if (!log) this.byLog.set(m.logId, (log = new Map()));
    const at = log.get(m.s) ?? [];
    at.push(m);
    log.set(m.s, at);
    if (!this.meta.has(m.logId) || (m.t === "tin" && this.meta.get(m.logId)!.controller === "")) {
      const kind = KEL.includes(m.t) ? "kel" : "trail";
      let controller = kind === "kel" ? m.logId : "";
      if (m.t === "tin") controller = String(JSON.parse(m.raw).ci);
      this.meta.set(m.logId, { kind, controller });
    }
  }

  async put(m: StoredMessage): Promise<"first" | "same" | "other"> {
    const at = this.byLog.get(m.logId)?.get(m.s) ?? [];
    if (at.some((x) => x.d === m.d)) return "same";
    const copy = { ...m, fn: ++this.fn };
    this.insert(copy);
    this.changed();
    return at.length === 0 ? "first" : "other";
  }

  private trunkOf(at: StoredMessage[] | undefined): StoredMessage | undefined {
    if (!at?.length) return undefined;
    return at.find((x) => !x.superseded && x.cutBy === undefined) ?? at[0];
  }

  async get(logId: Qb64, s: number) {
    return this.trunkOf(this.byLog.get(logId)?.get(s));
  }

  async versions(logId: Qb64, s: number) {
    return [...(this.byLog.get(logId)?.get(s) ?? [])];
  }

  async range(logId: Qb64, from = 0, to = Infinity) {
    const log = this.byLog.get(logId);
    if (!log) return [];
    const out: StoredMessage[] = [];
    for (const s of [...log.keys()].sort((a, b) => a - b)) {
      if (s < from || s > to) continue;
      const t = this.trunkOf(log.get(s));
      if (t && !t.superseded) out.push(t);
    }
    return out;
  }

  async all(logId: Qb64) {
    const log = this.byLog.get(logId);
    if (!log) return [];
    return [...log.values()].flat().sort((a, b) => a.fn - b.fn);
  }

  async head(logId: Qb64) {
    const r = await this.range(logId);
    return r[r.length - 1];
  }

  async markSuperseded(logId: Qb64, s: number, d: Qb64, by: Qb64) {
    const m = this.byLog.get(logId)?.get(s)?.find((x) => x.d === d);
    if (m && m.superseded !== by) {
      m.superseded = by;
      this.changed();
    }
  }

  async markCut(logId: Qb64, s: number, d: Qb64, byKelSn: number) {
    const m = this.byLog.get(logId)?.get(s)?.find((x) => x.d === d);
    if (m && m.cutBy !== byKelSn) {
      m.cutBy = byKelSn;
      this.changed();
    }
  }

  async addReceipt(logId: Qb64, s: number, d: Qb64, r: StoredReceipt) {
    const k = rkey(logId, s, d);
    const list = this.receiptMap.get(k) ?? [];
    if (list.some((x) => x.by === r.by && x.kind === r.kind)) return;
    list.push({ ...r });
    this.receiptMap.set(k, list);
    this.changed();
  }

  async receipts(logId: Qb64, s: number, d: Qb64) {
    return [...(this.receiptMap.get(rkey(logId, s, d)) ?? [])];
  }

  async putBody(said: Qb64, raw: string) {
    if (this.bodies.has(said)) return;
    this.bodies.set(said, raw);
    this.changed();
  }

  async getBody(said: Qb64) {
    return this.bodies.get(said);
  }

  async putEvidence(e: DuplicityEvidence) {
    const j = evidenceToJson(e);
    if (this.evidenceList.some((x) => x.kind === j.kind && x.logId === j.logId && x.s === j.s && x.witness === j.witness && ((x.a === j.a && x.b === j.b) || (x.a === j.b && x.b === j.a))))
      return;
    this.evidenceList.push(j);
    this.changed();
  }

  async evidence(logId?: Qb64) {
    return this.evidenceList.filter((e) => !logId || e.logId === logId).map(evidenceFromJson);
  }

  async logs() {
    return [...this.meta.entries()].map(([logId, m]) => ({ logId, ...m }));
  }
}

/** Converts a stored message back to a SignedMessage. */
export function fromStored(m: StoredMessage): SignedMessage {
  const r = fromStream(m.raw + m.attachments);
  if (!r.messages[0]) throw new Error(`stored message ${m.logId}:${m.s} does not parse: ${r.problems[0]?.message}`);
  return r.messages[0];
}

/** The stream of a stored receipt. */
export function receiptMessage(r: StoredReceipt): SignedMessage | undefined {
  return fromStream(r.raw + r.attachments).messages[0];
}
