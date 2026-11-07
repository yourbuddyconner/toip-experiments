/**
 * Sizes the relay sees (design §8.5, §9). Every message a source sends is exactly SOURCE_WIRE_BYTES
 * on the wire: the submit, each chunk, dummy chunks, follow-ups. Messages from the drop box are
 * padded to a multiple of 16 KiB. Attachments travel in chunks of exactly 144 KiB, and the number of
 * chunks in a tip is padded up to a power of two.
 */
import { toB64u, type Endpoint } from "@zk-toip/trust-core";
type SpecPolicy = Parameters<Endpoint["seal"]>[1];
import type { ChunkPayload } from "./messages";

export const CHUNK_BYTES = 144 * 1024;
export const SOURCE_WIRE_BYTES = 200 * 1024;
export const DROPBOX_WIRE_STEP = 16 * 1024;
export const MAX_CHUNKS = 128;

/** Random bytes of any length (getRandomValues gives at most 64 KiB at a time). */
export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
}

/** A random base64url string of exactly `n` characters. */
export function randomPadding(n: number): string {
  if (n <= 0) return "";
  return toB64u(randomBytes(Math.ceil((n * 3) / 4) + 3)).slice(0, n);
}

/**
 * Seals `payload` for `to` with a `padding` field sized so the wire is `target(unpadded)` bytes. TSP
 * encodes the ciphertext in 3-byte groups, so the size reached is the largest one at or under the
 * target on that grid: within 2 bytes of it, and the same for every message of a given target.
 */
export async function sealPadded(endpoint: Endpoint, to: string, spec: SpecPolicy, payload: object, target: (unpadded: number) => number): Promise<Uint8Array> {
  const base = await endpoint.seal(to, spec, { ...payload, padding: "" });
  const want = target(base.length);
  if (base.length > want) throw new Error(`a ${base.length}-byte message doesn't fit its ${want}-byte size`);
  let pad = want - base.length;
  for (let i = 0; i < 16; i++) {
    const wire = await endpoint.seal(to, spec, { ...payload, padding: randomPadding(pad) });
    if (wire.length <= want && wire.length > want - 3) return wire;
    pad += wire.length > want ? -1 : Math.max(1, Math.floor((want - wire.length) / 3) * 3 - 2);
    if (pad < 0) break;
  }
  throw new Error("couldn't pad the message to its size");
}

export const sourceSize = () => SOURCE_WIRE_BYTES;
export const dropboxSize = (n: number) => Math.ceil(n / DROPBOX_WIRE_STEP) * DROPBOX_WIRE_STEP;

/** The next of 1, 2, 4, …, 128 at or above n. */
export function paddedChunkCount(n: number): number {
  if (n > MAX_CHUNKS) throw new Error(`at most ${MAX_CHUNKS} chunks per tip`);
  let c = 1;
  while (c < n) c *= 2;
  return c;
}

/** Cuts an attachment into chunks of exactly CHUNK_BYTES; the last is filled with random bytes. */
export function splitAttachment(tipId: string, attachment: string, bytes: Uint8Array): ChunkPayload[] {
  const count = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));
  const out: ChunkPayload[] = [];
  for (let i = 0; i < count; i++) {
    const piece = randomBytes(CHUNK_BYTES);
    piece.set(bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES));
    out.push({ tipId, attachment, index: i, count, data: toB64u(piece) });
  }
  return out;
}

export function chunksFor(bytes: number): number {
  return Math.max(1, Math.ceil(bytes / CHUNK_BYTES));
}

/** A dummy chunk: random bytes, dropped by the inbox. */
export function padChunk(tipId: string, index: number, count: number): ChunkPayload {
  return { tipId, attachment: "pad", index, count, data: toB64u(randomBytes(CHUNK_BYTES)) };
}

/** Joins an attachment's chunks, in index order, and cuts it to its stated length. */
export function joinChunks(pieces: Uint8Array[], bytes: number): Uint8Array {
  const out = new Uint8Array(pieces.length * CHUNK_BYTES);
  pieces.forEach((p, i) => out.set(p, i * CHUNK_BYTES));
  return out.slice(0, bytes);
}
