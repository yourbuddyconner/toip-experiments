/**
 * Carrying a store inside the file (design §9.2): JPEG APP15 segments after SOI, or a PNG `zkCp` chunk
 * before the first IDAT. The content hash is SHA-256 of the file with Capture's own segments removed, so
 * it is the same before and after embedding, however often the store is re-embedded.
 */
import { concat, equal, sha, u32, utf8 } from "./bytes";
import { decodeStore, encodeStore, type Store } from "./store";

const JPEG_ID = utf8("ZKTOIP-CAPTURE\0");
/** Data per APP15 segment: 65,533 bytes less the identifier and the index and count bytes. */
const JPEG_CHUNK = 65533 - JPEG_ID.length - 2;
const PNG_SIG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const PNG_TYPE = "zkCp";

export function sniffMime(b: Uint8Array): string {
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (equal(b.subarray(0, 8), PNG_SIG)) return "image/png";
  return "application/octet-stream";
}

// ---- JPEG

interface JpegSegment {
  start: number;
  end: number;
  marker: number;
}

/** The marker segments between SOI and SOS. Throws if the file is not a JPEG. */
function jpegSegments(b: Uint8Array): { segments: JpegSegment[]; scanStart: number } {
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new Error("not a JPEG");
  const segments: JpegSegment[] = [];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) throw new Error("bad JPEG marker");
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return { segments, scanStart: i };
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) throw new Error("truncated JPEG segment");
    segments.push({ start: i, end: i + 2 + len, marker });
    i += 2 + len;
  }
  return { segments, scanStart: b.length };
}

const isOurs = (b: Uint8Array, s: JpegSegment) => s.marker === 0xef && equal(b.subarray(s.start + 4, s.start + 4 + JPEG_ID.length), JPEG_ID);

function stripJpeg(b: Uint8Array): { stripped: Uint8Array; ours: Uint8Array[] } {
  const { segments } = jpegSegments(b);
  const ours = segments.filter((s) => isOurs(b, s));
  if (!ours.length) return { stripped: b, ours: [] };
  const parts: Uint8Array[] = [];
  let at = 0;
  for (const s of ours) {
    parts.push(b.subarray(at, s.start));
    at = s.end;
  }
  parts.push(b.subarray(at));
  return { stripped: concat(...parts), ours: ours.map((s) => b.subarray(s.start + 4, s.end)) };
}

function embedJpeg(b: Uint8Array, data: Uint8Array): Uint8Array {
  const { stripped } = stripJpeg(b);
  const count = Math.max(1, Math.ceil(data.length / JPEG_CHUNK));
  if (count > 255) throw new Error("store too large for APP15 segments");
  const segs: Uint8Array[] = [];
  for (let k = 0; k < count; k++) {
    const chunk = data.subarray(k * JPEG_CHUNK, (k + 1) * JPEG_CHUNK);
    const len = 2 + JPEG_ID.length + 2 + chunk.length;
    segs.push(concat(Uint8Array.of(0xff, 0xef, len >> 8, len & 255), JPEG_ID, Uint8Array.of(k, count), chunk));
  }
  return concat(stripped.subarray(0, 2), ...segs, stripped.subarray(2));
}

function extractJpeg(b: Uint8Array): Uint8Array | null {
  const { ours } = stripJpeg(b);
  if (!ours.length) return null;
  const parts = ours.map((p) => ({ index: p[JPEG_ID.length], count: p[JPEG_ID.length + 1], data: p.subarray(JPEG_ID.length + 2) }));
  const count = parts[0].count;
  if (parts.length !== count || parts.some((p) => p.count !== count)) throw new Error("the embedded store is incomplete");
  parts.sort((x, y) => x.index - y.index);
  if (parts.some((p, i) => p.index !== i)) throw new Error("the embedded store is incomplete");
  return concat(...parts.map((p) => p.data));
}

// ---- PNG

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface PngChunk {
  start: number;
  end: number;
  type: string;
  data: Uint8Array;
}

function pngChunks(b: Uint8Array): PngChunk[] {
  if (!equal(b.subarray(0, 8), PNG_SIG)) throw new Error("not a PNG");
  const out: PngChunk[] = [];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
    const end = i + 12 + len;
    if (end > b.length) throw new Error("truncated PNG chunk");
    out.push({ start: i, end, type, data: b.subarray(i + 8, i + 8 + len) });
    i = end;
    if (type === "IEND") break;
  }
  return out;
}

function stripPng(b: Uint8Array): { stripped: Uint8Array; ours: Uint8Array | null } {
  const chunks = pngChunks(b);
  const ours = chunks.filter((c) => c.type === PNG_TYPE);
  if (!ours.length) return { stripped: b, ours: null };
  const parts: Uint8Array[] = [];
  let at = 0;
  for (const c of ours) {
    parts.push(b.subarray(at, c.start));
    at = c.end;
  }
  parts.push(b.subarray(at));
  return { stripped: concat(...parts), ours: ours[0].data };
}

function embedPng(b: Uint8Array, data: Uint8Array): Uint8Array {
  const { stripped } = stripPng(b);
  const idat = pngChunks(stripped).find((c) => c.type === "IDAT");
  if (!idat) throw new Error("PNG has no IDAT");
  const typeAndData = concat(utf8(PNG_TYPE), data);
  const chunk = concat(u32(data.length), typeAndData, u32(crc32(typeAndData)));
  return concat(stripped.subarray(0, idat.start), chunk, stripped.subarray(idat.start));
}

// ---- both

/** The file without Capture's segments or chunks. Other files are returned as they are. */
export function withoutStore(file: Uint8Array, mime = sniffMime(file)): Uint8Array {
  if (mime === "image/jpeg") return stripJpeg(file).stripped;
  if (mime === "image/png") return stripPng(file).stripped;
  return file;
}

export function contentHash(file: Uint8Array, mime = sniffMime(file)): Uint8Array {
  return sha(withoutStore(file, mime));
}

export function embedStore(file: Uint8Array, store: Store, mime = sniffMime(file)): Uint8Array {
  const data = encodeStore(store);
  if (mime === "image/jpeg") return embedJpeg(file, data);
  if (mime === "image/png") return embedPng(file, data);
  throw new Error(`can't embed a store in ${mime}; use a sidecar`);
}

/** The embedded store's bytes, or null when there is none. */
export function extractStoreBytes(file: Uint8Array, mime = sniffMime(file)): Uint8Array | null {
  if (mime === "image/jpeg") return extractJpeg(file);
  if (mime === "image/png") return stripPng(file).ours;
  return null;
}

export function extractStore(file: Uint8Array, mime = sniffMime(file)): Store | null {
  const b = extractStoreBytes(file, mime);
  return b ? decodeStore(b) : null;
}
