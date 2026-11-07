/**
 * Deterministic CBOR: RFC 8949 §4.2.1 (Core Deterministic Encoding), on top of cborg.
 *
 * Encoding: shortest integers, lengths and floats; definite lengths only; map keys sorted by the
 * bytewise order of their encodings. Plain objects become text-keyed maps; `Map` keeps any key type.
 *
 * Decoding is strict by default: it rejects anything the encoder would not have written (indefinite
 * lengths, long forms, unsorted or duplicate keys, `undefined`, trailing bytes). Maps whose keys are all
 * text come back as plain objects; other maps come back as `Map`. Tags come back as `Tagged`.
 */
import { decode, encode, rfc8949EncodeOptions, Tagged, type DecodeOptions, type TagDecoder } from "cborg";

export { Tagged };

const ENCODE = { ...rfc8949EncodeOptions, ignoreUndefinedProperties: true };

export function encodeCbor(value: unknown): Uint8Array {
  return encode(value, ENCODE);
}

/** Every tag number decodes to a `Tagged`. cborg looks decoders up by index, so a proxy serves them all. */
const ANY_TAG = new Proxy({} as Record<number, TagDecoder>, {
  get: (_, key) => (typeof key === "string" && /^\d+$/.test(key) ? Tagged.decoder(Number(key)) : undefined),
});

const STRICT: DecodeOptions = {
  strict: true,
  allowIndefinite: false,
  allowUndefined: false,
  allowInfinity: false,
  allowNaN: false,
  rejectDuplicateMapKeys: true,
  strictUtf8: true,
  useMaps: true,
  tags: ANY_TAG,
};

const LENIENT: DecodeOptions = { useMaps: true, tags: ANY_TAG };

export interface DecodeCborOptions {
  /** Reject encodings that are not deterministic. Default true. */
  strict?: boolean;
  /** Return every map as a `Map`, even text-keyed ones. Default false. */
  useMaps?: boolean;
}

export function decodeCbor<T = unknown>(bytes: Uint8Array, opts: DecodeCborOptions = {}): T {
  const strict = opts.strict !== false;
  const raw = decode(bytes, strict ? STRICT : LENIENT);
  // cborg checks the shortest-form and length rules; map order and float width are checked by encoding again.
  if (strict && !equal(encode(raw, rfc8949EncodeOptions), bytes)) throw new Error("CBOR: not in deterministic encoding");
  return (opts.useMaps ? raw : objects(raw)) as T;
}

function objects(v: unknown): unknown {
  if (v instanceof Uint8Array || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(objects);
  if (v instanceof Tagged) return new Tagged(v.tag, objects(v.value));
  if (v instanceof Map) {
    const entries = [...v].map(([k, x]) => [k, objects(x)] as const);
    if (entries.every(([k]) => typeof k === "string")) return Object.fromEntries(entries);
    return new Map(entries);
  }
  return v;
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
