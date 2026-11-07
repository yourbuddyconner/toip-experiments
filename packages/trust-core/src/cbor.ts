/**
 * The small, strict CBOR (RFC 8949) subset CTT1 needs: definite lengths only, shortest heads,
 * simple values 16, 17 and 20 to 22, and float32/float64. Not a general CBOR library.
 * cborg rejects simple values other than true, false, null and undefined, so CTT1 can't use it.
 */

export const MT = { uint: 0, neg: 1, bytes: 2, text: 3, array: 4, map: 5, tag: 6, simple: 7 } as const;

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

export class CborWriter {
  private buf = new Uint8Array(256);
  private len = 0;

  private room(n: number): void {
    if (this.len + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + n));
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  byte(b: number): void {
    this.room(1);
    this.buf[this.len++] = b;
  }

  raw(bytes: Uint8Array): void {
    this.room(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }

  /** A major type with its argument, in the shortest form. `n` is a non-negative safe integer. */
  head(major: number, n: number): void {
    const m = major << 5;
    if (n < 24) this.byte(m | n);
    else if (n < 0x100) {
      this.byte(m | 24);
      this.byte(n);
    } else if (n < 0x10000) {
      this.byte(m | 25);
      this.byte(n >>> 8);
      this.byte(n & 0xff);
    } else if (n < 0x100000000) {
      this.byte(m | 26);
      this.u32(n);
    } else {
      this.byte(m | 27);
      this.u32(Math.floor(n / 0x100000000));
      this.u32(n >>> 0);
    }
  }

  private u32(n: number): void {
    this.byte((n >>> 24) & 0xff);
    this.byte((n >>> 16) & 0xff);
    this.byte((n >>> 8) & 0xff);
    this.byte(n & 0xff);
  }

  int(n: number): void {
    if (n >= 0) this.head(MT.uint, n);
    else this.head(MT.neg, -1 - n);
  }

  text(s: string): void {
    const b = enc.encode(s);
    this.head(MT.text, b.length);
    this.raw(b);
  }

  bytes(b: Uint8Array): void {
    this.head(MT.bytes, b.length);
    this.raw(b);
  }

  simple(v: number): void {
    this.byte(0xe0 | v);
  }

  /** float32 when exact, otherwise float64. */
  float(n: number): void {
    if (Math.fround(n) === n) {
      this.byte(0xfa);
      const b = new Uint8Array(4);
      new DataView(b.buffer).setFloat32(0, n);
      this.raw(b);
    } else {
      this.byte(0xfb);
      const b = new Uint8Array(8);
      new DataView(b.buffer).setFloat64(0, n);
      this.raw(b);
    }
  }

  done(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

export interface Head {
  major: number;
  /** The argument: a count, a length, a value or a tag number. For major 7, the simple value or the float. */
  value: number;
  float?: boolean;
}

export class CborReader {
  pos: number;
  constructor(
    readonly data: Uint8Array,
    start = 0,
  ) {
    this.pos = start;
  }

  get done(): boolean {
    return this.pos >= this.data.length;
  }

  private take(n: number): Uint8Array {
    if (n < 0 || this.pos + n > this.data.length) throw new Error("cbor: truncated");
    const out = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  private uint(bytes: number): number {
    const b = this.take(bytes);
    let n = 0;
    for (const x of b) n = n * 256 + x;
    return n;
  }

  head(): Head {
    const [first] = this.take(1);
    const major = first >> 5;
    const info = first & 0x1f;
    if (major === MT.simple) {
      if (info < 24) return { major, value: info };
      const v = new DataView(this.data.buffer, this.data.byteOffset);
      if (info === 26) {
        const at = this.pos;
        this.take(4);
        return { major, value: v.getFloat32(at), float: true };
      }
      if (info === 27) {
        const at = this.pos;
        this.take(8);
        return { major, value: v.getFloat64(at), float: true };
      }
      throw new Error("cbor: unsupported simple or float form");
    }
    let value: number;
    if (info < 24) value = info;
    else if (info === 24) value = this.uint(1);
    else if (info === 25) value = this.uint(2);
    else if (info === 26) value = this.uint(4);
    else if (info === 27) value = this.uint(8);
    else throw new Error("cbor: indefinite or reserved length");
    if (!Number.isSafeInteger(value)) throw new Error("cbor: argument too large");
    // Shortest form only, so every value has one encoding.
    const min = info === 24 ? 24 : info === 25 ? 0x100 : info === 26 ? 0x10000 : info === 27 ? 0x100000000 : 0;
    if (value < min) throw new Error("cbor: non-shortest head");
    return { major, value };
  }

  /** `n` bytes after a bytes or text head. */
  body(n: number): Uint8Array {
    return this.take(n);
  }

  textBody(n: number): string {
    return dec.decode(this.take(n));
  }
}
