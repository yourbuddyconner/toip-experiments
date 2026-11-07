/**
 * Sensor frames (design §12.2), small enough for LoRa: a 1-byte type, then CBOR with small integer fields.
 * 0x01 reading (unsigned, hash-chained), 0x02 seal (COSE_Sign1 over the chain head), 0x03 signed reading,
 * 0x04 beacon (gateway to sensors), 0x05 backfill request.
 */
import { decodeCbor, encodeCbor, signCose1, type AsyncSigner } from "@toip-tools/cose";
import { concat, sha, utf8 } from "./bytes";

export const FRAME = { reading: 1, seal: 2, signedReading: 3, beacon: 4, backfill: 5 } as const;

export interface Reading {
  dev: Uint8Array;
  seq: number;
  /** Unix seconds, the device's clock. */
  t: number;
  link: Uint8Array;
  values: [number, number][];
  /** Low byte of the drand round the sensor last heard, then the first 2 bytes of its randomness. */
  beacon?: Uint8Array;
}

export interface Seal {
  dev: Uint8Array;
  firstSeq: number;
  lastSeq: number;
  head: Uint8Array;
  beacon?: { round: number; prefix: Uint8Array };
}

export type Frame =
  | { type: 1; reading: Reading; body: Uint8Array }
  | { type: 2; seal: Seal; cose: Uint8Array }
  | { type: 3; cose: Uint8Array; reading: Omit<Reading, "link"> }
  | { type: 4; round: number; prefix: Uint8Array }
  | { type: 5; dev: Uint8Array; fromSeq: number; toSeq: number };

/** First 4 bytes of SHA-256 of the device identifier. */
export const devTag = (deviceId: string) => sha(utf8(deviceId)).slice(0, 4);
export const ZERO_LINK = new Uint8Array(8);

const withType = (t: number, b: Uint8Array) => concat(Uint8Array.of(t), b);

export function readingBody(r: Reading): Uint8Array {
  const arr: unknown[] = [r.dev, r.seq, r.t, r.link, r.values];
  if (r.beacon) arr.push(r.beacon);
  return encodeCbor(arr);
}

export const sealPayload = (s: Seal) => encodeCbor(s.beacon ? [s.dev, s.firstSeq, s.lastSeq, s.head, [s.beacon.round, s.beacon.prefix]] : [s.dev, s.firstSeq, s.lastSeq, s.head]);

export function encodeBeacon(round: number, prefix: Uint8Array): Uint8Array {
  return withType(FRAME.beacon, encodeCbor([1, round, prefix.slice(0, 8)]));
}

export function encodeBackfill(dev: Uint8Array, fromSeq: number, toSeq: number): Uint8Array {
  return withType(FRAME.backfill, encodeCbor([dev, fromSeq, toSeq]));
}

const isBytes = (x: unknown, n?: number): x is Uint8Array => x instanceof Uint8Array && (n === undefined || x.length === n);
const isUint = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0;
const isValues = (x: unknown): x is [number, number][] => Array.isArray(x) && x.length <= 16 && x.every((v) => Array.isArray(v) && v.length === 2 && isUint(v[0]) && Number.isInteger(v[1]));

function coseParts(cose: Uint8Array): { payload: Uint8Array } {
  const v = decodeCbor(cose, { strict: false, useMaps: true }) as { tag?: number; value?: unknown[] } | unknown[];
  const arr = Array.isArray(v) ? v : (v as { value?: unknown[] }).value;
  if (!Array.isArray(arr) || arr.length !== 4 || !isBytes(arr[2])) throw new Error("not a COSE_Sign1");
  return { payload: arr[2] };
}

/** Decodes a frame. Throws on anything malformed. */
export function decodeFrame(b: Uint8Array): Frame {
  const type = b[0];
  const body = b.subarray(1);
  if (type === FRAME.reading) {
    const a = decodeCbor<unknown[]>(body, { strict: true });
    if (!Array.isArray(a) || (a.length !== 5 && a.length !== 6) || !isBytes(a[0], 4) || !isUint(a[1]) || !isUint(a[2]) || !isBytes(a[3], 8) || !isValues(a[4]) || (a.length === 6 && !isBytes(a[5], 3)))
      throw new Error("bad reading frame");
    const reading: Reading = { dev: a[0], seq: a[1], t: a[2], link: a[3], values: a[4], ...(a.length === 6 ? { beacon: a[5] as Uint8Array } : {}) };
    return { type: 1, reading, body: body.slice() };
  }
  if (type === FRAME.seal) {
    const cose = body.slice();
    const p = decodeCbor<unknown[]>(coseParts(cose).payload, { strict: true });
    if (!Array.isArray(p) || (p.length !== 4 && p.length !== 5) || !isBytes(p[0], 4) || !isUint(p[1]) || !isUint(p[2]) || !isBytes(p[3], 32) || p[2] < p[1]) throw new Error("bad seal");
    let beacon: Seal["beacon"];
    if (p.length === 5) {
      const bb = p[4] as unknown[];
      if (!Array.isArray(bb) || bb.length !== 2 || !isUint(bb[0]) || !isBytes(bb[1], 8)) throw new Error("bad seal beacon");
      beacon = { round: bb[0], prefix: bb[1] };
    }
    return { type: 2, cose, seal: { dev: p[0], firstSeq: p[1], lastSeq: p[2], head: p[3], ...(beacon ? { beacon } : {}) } };
  }
  if (type === FRAME.signedReading) {
    const cose = body.slice();
    const p = decodeCbor<unknown[]>(coseParts(cose).payload, { strict: true });
    if (!Array.isArray(p) || (p.length !== 4 && p.length !== 5) || !isBytes(p[0], 4) || !isUint(p[1]) || !isUint(p[2]) || !isValues(p[3])) throw new Error("bad signed reading");
    return { type: 3, cose, reading: { dev: p[0], seq: p[1], t: p[2], values: p[3], ...(p.length === 5 ? { beacon: p[4] as Uint8Array } : {}) } };
  }
  if (type === FRAME.beacon) {
    const a = decodeCbor<unknown[]>(body, { strict: true });
    if (!Array.isArray(a) || a.length !== 3 || a[0] !== 1 || !isUint(a[1]) || !isBytes(a[2], 8)) throw new Error("bad beacon");
    return { type: 4, round: a[1], prefix: a[2] };
  }
  if (type === FRAME.backfill) {
    const a = decodeCbor<unknown[]>(body, { strict: true });
    if (!Array.isArray(a) || a.length !== 3 || !isBytes(a[0], 4) || !isUint(a[1]) || !isUint(a[2])) throw new Error("bad backfill request");
    return { type: 5, dev: a[0], fromSeq: a[1], toSeq: a[2] };
  }
  throw new Error(`unknown frame type ${type}`);
}

export interface ChainState {
  dev: Uint8Array;
  /** The next reading's sequence number. */
  seq: number;
  /** SHA-256 of the last reading's CBOR array; 32 zero bytes before the first. */
  lastHash: Uint8Array;
  /** The first reading not yet covered by a seal. */
  firstUnsealed: number;
}

export const freshChain = (dev: Uint8Array): ChainState => ({ dev, seq: 0, lastHash: new Uint8Array(32), firstUnsealed: 0 });

/** The device side: appends readings to the chain and seals its head. The caller persists `state`. */
export class ReadingChain {
  readonly sent = new Map<number, Uint8Array>();
  /** Seals sent, by last seq. */
  readonly seals = new Map<number, { firstSeq: number; frame: Uint8Array }>();
  constructor(
    public state: ChainState,
    private readonly signer: AsyncSigner,
    private readonly keep = 2000,
  ) {}

  next(t: number, values: [number, number][], beacon?: Uint8Array): Uint8Array {
    const s = this.state;
    const link = s.seq === 0 ? ZERO_LINK : s.lastHash.slice(0, 8);
    const body = readingBody({ dev: s.dev, seq: s.seq, t, link, values, ...(beacon ? { beacon } : {}) });
    const frame = withType(FRAME.reading, body);
    this.sent.set(s.seq, frame);
    if (this.sent.size > this.keep) this.sent.delete(this.sent.keys().next().value!);
    this.state = { ...s, seq: s.seq + 1, lastHash: sha(body) };
    return frame;
  }

  /** A seal over the readings since the last seal; null when there are none. */
  async seal(beacon?: Seal["beacon"]): Promise<Uint8Array | null> {
    const s = this.state;
    if (s.seq === 0 || s.firstUnsealed >= s.seq) return null;
    const seal: Seal = { dev: s.dev, firstSeq: s.firstUnsealed, lastSeq: s.seq - 1, head: s.lastHash, ...(beacon ? { beacon } : {}) };
    const cose = await signCose1(sealPayload(seal), this.signer, { omitKid: true });
    this.state = { ...s, firstUnsealed: s.seq };
    const frame = withType(FRAME.seal, cose);
    this.seals.set(seal.lastSeq, { firstSeq: seal.firstSeq, frame });
    if (this.seals.size > this.keep / 4) this.seals.delete(this.seals.keys().next().value!);
    return frame;
  }

  async signedReading(t: number, values: [number, number][], beacon?: Uint8Array): Promise<Uint8Array> {
    const arr: unknown[] = [this.state.dev, this.state.seq, t, values];
    if (beacon) arr.push(beacon);
    return withType(FRAME.signedReading, await signCose1(encodeCbor(arr), this.signer, { omitKid: true }));
  }

  /** Frames for a backfill request, from what this chain still holds: the readings, and the seals over them. */
  backfill(fromSeq: number, toSeq: number): Uint8Array[] {
    const out: Uint8Array[] = [];
    for (let s = fromSeq; s <= toSeq; s++) {
      const f = this.sent.get(s);
      if (f) out.push(f);
    }
    for (const [last, { firstSeq, frame }] of this.seals) if (last >= fromSeq && firstSeq <= toSeq) out.push(frame);
    return out;
  }
}

/** The 3-byte beacon tag a reading carries: the round's low byte and 2 bytes of its randomness. */
export const beaconTag = (round: number, randomness: Uint8Array) => Uint8Array.of(round & 255, randomness[0], randomness[1]);
