/**
 * The processor's transparency log (design §9): append-only, hash-chained, with a signed head.
 * Anyone holding a payment's documents can check them against it and against the chain.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalJson, signDocument, utf8, verifyDocument, type Clock, type Identity } from "@zk-toip/trust-core";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const GENESIS = "0".repeat(64);

export interface LogEntry {
  seq: number;
  at: string;
  kind: "opened" | "signature" | "dispute" | "ruling" | "hold" | "settled";
  termsHash: string;
  detail: Record<string, unknown>;
  prev: string;
  hash: string;
}

export interface LogHead {
  type: "settle/log-head";
  issuer: string;
  size: number;
  head: string;
  at: string;
  proof?: unknown;
}

const entryHash = (e: Omit<LogEntry, "hash">) => hex(sha256(utf8(canonicalJson(e))));

export class TransparencyLog {
  private readonly entries: LogEntry[] = [];

  constructor(
    private readonly identity: Identity,
    private readonly clock: Clock,
  ) {}

  /** Picks up a saved log, refusing one whose entries don't chain together. */
  load(entries: LogEntry[]): void {
    let prev = this.entries.at(-1)?.hash ?? GENESIS;
    for (const [i, e] of entries.entries()) {
      const { hash, ...body } = e;
      if (e.seq !== this.entries.length + i || e.prev !== prev || entryHash(body) !== hash) throw new Error(`saved log entry ${i} doesn't check out`);
      prev = hash;
    }
    this.entries.push(...entries);
  }

  append(kind: LogEntry["kind"], termsHash: string, detail: Record<string, unknown>): LogEntry {
    const body = { seq: this.entries.length, at: this.clock.iso(), kind, termsHash, detail, prev: this.entries.at(-1)?.hash ?? GENESIS };
    const e = { ...body, hash: entryHash(body) };
    this.entries.push(e);
    return e;
  }

  snapshot(): { entries: LogEntry[]; head: LogHead } {
    const head = signDocument(
      { type: "settle/log-head" as const, issuer: this.identity.did, size: this.entries.length, head: this.entries.at(-1)?.hash ?? GENESIS, at: this.clock.iso() },
      this.identity,
      this.clock,
    );
    return { entries: [...this.entries], head };
  }
}

/** Checks a log: each entry's hash, the chain of `prev` links, and the processor's signature on the head. */
export async function verifyLog(entries: LogEntry[], head: LogHead, processorDid: string, clock: Clock): Promise<{ ok: boolean; problem?: string }> {
  let prev = GENESIS;
  for (const [i, e] of entries.entries()) {
    const { hash, ...body } = e;
    if (e.seq !== i) return { ok: false, problem: `entry ${i} is out of sequence` };
    if (e.prev !== prev) return { ok: false, problem: `entry ${i} doesn't follow entry ${i - 1}` };
    if (entryHash(body) !== hash) return { ok: false, problem: `entry ${i} was altered` };
    prev = hash;
  }
  if (head.issuer !== processorDid || !(await verifyDocument(head, clock)).valid) return { ok: false, problem: "the head isn't signed by the processor" };
  if (head.size !== entries.length || head.head !== prev) return { ok: false, problem: "the head doesn't match the entries" };
  return { ok: true };
}
