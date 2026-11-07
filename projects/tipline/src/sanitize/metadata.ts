/**
 * Finds and removes metadata in images (design §9): EXIF (GPS position, camera make, model and
 * serial number, dates), XMP, IPTC, ICC profiles and text chunks. Pure TypeScript, so the inbox and
 * the tests can use it too. The source app first re-encodes images on a canvas (web/src/clean.ts),
 * which drops all of this; it then runs these functions to check, and to strip anything left.
 */

export type ImageKind = "jpeg" | "png" | "webp" | "other";

export interface Finding {
  /** What a person should know was in the file: "GPS position", "Camera model", … */
  what: string;
  value?: string;
}

export function imageKind(b: Uint8Array): ImageKind {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x)) return "png";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "webp";
  return "other";
}

function ascii(b: Uint8Array, at: number, n: number): string {
  let s = "";
  for (let i = at; i < at + n && i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

function startsWith(b: Uint8Array, at: number, text: string): boolean {
  return ascii(b, at, text.length) === text;
}

// ── JPEG ────────────────────────────────────────────────────────────

interface Segment {
  marker: number;
  start: number;
  /** Start of the segment's payload, after the length. */
  data: number;
  end: number;
}

/** The marker segments before the scan. Returns null if the file isn't a well-formed JPEG. */
function jpegSegments(b: Uint8Array): { segments: Segment[]; scanStart: number } | null {
  let i = 2;
  const segments: Segment[] = [];
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd9) return { segments, scanStart: i };
    if (marker >= 0xd0 && marker <= 0xd7) {
      i += 2;
      continue;
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) return null;
    const seg = { marker, start: i, data: i + 4, end: i + 2 + len };
    if (marker === 0xda) return { segments, scanStart: i };
    segments.push(seg);
    i = seg.end;
  }
  return null;
}

/** Marker segments that carry metadata: APP1 to APP13, APP15 and comments. APP0 (JFIF) and APP14 (Adobe colour) stay. */
function isMetadataSegment(marker: number): boolean {
  return (marker >= 0xe1 && marker <= 0xed) || marker === 0xef || marker === 0xfe;
}

function jpegFindings(b: Uint8Array): Finding[] {
  const parsed = jpegSegments(b);
  if (!parsed) return [{ what: "A JPEG this app can't read fully" }];
  const out: Finding[] = [];
  for (const s of parsed.segments) {
    if (s.marker === 0xe1 && startsWith(b, s.data, "Exif\0\0")) out.push(...exifFindings(b.subarray(s.data + 6, s.end)));
    else if (s.marker === 0xe1 && startsWith(b, s.data, "http://ns.adobe.com/xap/1.0/")) out.push({ what: "XMP metadata (may include editing history and author)" });
    else if (s.marker === 0xe2 && startsWith(b, s.data, "ICC_PROFILE")) out.push({ what: "ICC colour profile (may name the device)" });
    else if (s.marker === 0xed) out.push({ what: "IPTC/Photoshop metadata" });
    else if (s.marker === 0xfe) out.push({ what: "Comment", value: ascii(b, s.data, Math.min(80, s.end - s.data)) });
    else if (isMetadataSegment(s.marker)) out.push({ what: `APP${s.marker - 0xe0} segment` });
  }
  return out;
}

function stripJpeg(b: Uint8Array): Uint8Array {
  const parsed = jpegSegments(b);
  if (!parsed) throw new Error("not a JPEG this app can clean");
  const keep: Uint8Array[] = [b.subarray(0, 2)];
  for (const s of parsed.segments) if (!isMetadataSegment(s.marker)) keep.push(b.subarray(s.start, s.end));
  keep.push(b.subarray(parsed.scanStart));
  return concat(keep);
}

// ── EXIF (TIFF) ─────────────────────────────────────────────────────

const TAGS: Record<number, string> = {
  0x010f: "Camera make",
  0x0110: "Camera model",
  0x0131: "Software",
  0x0132: "Date and time",
  0x013b: "Artist",
  0x8298: "Copyright",
  0x9003: "Date taken",
  0xa430: "Camera owner",
  0xa431: "Camera serial number",
  0xa434: "Lens model",
};

function exifFindings(t: Uint8Array): Finding[] {
  try {
    return readExif(t);
  } catch {
    return [{ what: "EXIF metadata" }];
  }
}

function readExif(t: Uint8Array): Finding[] {
  const le = ascii(t, 0, 2) === "II";
  if (!le && ascii(t, 0, 2) !== "MM") throw new Error("not TIFF");
  const u16 = (o: number) => (le ? t[o] | (t[o + 1] << 8) : (t[o] << 8) | t[o + 1]);
  const u32 = (o: number) => (le ? (t[o] | (t[o + 1] << 8) | (t[o + 2] << 16) | (t[o + 3] << 24)) >>> 0 : ((t[o] << 24) | (t[o + 1] << 16) | (t[o + 2] << 8) | t[o + 3]) >>> 0);
  const out: Finding[] = [];
  const seen = new Set<number>();
  const ifd = (off: number, gps: boolean) => {
    if (seen.has(off) || off + 2 > t.length) return;
    seen.add(off);
    const n = u16(off);
    const g: Record<number, { type: number; count: number; at: number }> = {};
    for (let k = 0; k < n; k++) {
      const e = off + 2 + k * 12;
      if (e + 12 > t.length) break;
      const tag = u16(e);
      const type = u16(e + 2);
      const count = u32(e + 4);
      const size = ({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 10: 8 } as Record<number, number>)[type] ?? 1;
      const at = size * count > 4 ? u32(e + 8) : e + 8;
      if (gps) {
        g[tag] = { type, count, at };
        continue;
      }
      if (tag === 0x8825) ifd(u32(e + 8), true);
      else if (tag === 0x8769) ifd(u32(e + 8), false);
      else if (TAGS[tag]) out.push({ what: TAGS[tag], value: type === 2 ? ascii(t, at, Math.min(count, 64)).replace(/\0+$/, "") : undefined });
    }
    if (gps) {
      const rational = (at: number) => u32(at) / (u32(at + 4) || 1);
      const coord = (v?: { at: number }, ref?: { at: number }) =>
        v ? `${(rational(v.at) + rational(v.at + 8) / 60 + rational(v.at + 16) / 3600).toFixed(4)}° ${ref ? ascii(t, ref.at, 1) : ""}`.trim() : undefined;
      const lat = coord(g[2], g[1]);
      const lon = coord(g[4], g[3]);
      out.push({ what: "GPS position", value: lat && lon ? `${lat}, ${lon}` : undefined });
    }
  };
  ifd(u32(4), false);
  if (out.length === 0) out.push({ what: "EXIF metadata" });
  return out;
}

// ── PNG ─────────────────────────────────────────────────────────────

const PNG_METADATA = new Set(["eXIf", "tEXt", "iTXt", "zTXt", "tIME", "iCCP"]);

function pngChunks(b: Uint8Array): { type: string; start: number; end: number }[] | null {
  const out: { type: string; start: number; end: number }[] = [];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    const type = ascii(b, i + 4, 4);
    const end = i + 12 + len;
    if (end > b.length) return null;
    out.push({ type, start: i, end });
    i = end;
    if (type === "IEND") return out;
  }
  return null;
}

function pngFindings(b: Uint8Array): Finding[] {
  const chunks = pngChunks(b);
  if (!chunks) return [{ what: "A PNG this app can't read fully" }];
  const out: Finding[] = [];
  for (const c of chunks) {
    if (c.type === "eXIf") out.push(...exifFindings(b.subarray(c.start + 8, c.end - 4)));
    else if (c.type === "tEXt" || c.type === "iTXt" || c.type === "zTXt") {
      const data = b.subarray(c.start + 8, c.end - 4);
      const key = ascii(data, 0, Math.max(0, data.indexOf(0)));
      out.push({ what: `Text: ${key || "unnamed"}`, value: c.type === "tEXt" ? ascii(data, key.length + 1, Math.min(64, data.length - key.length - 1)) : undefined });
    } else if (c.type === "tIME") out.push({ what: "Date edited" });
    else if (c.type === "iCCP") out.push({ what: "ICC colour profile (may name the device)" });
  }
  return out;
}

function stripPng(b: Uint8Array): Uint8Array {
  const chunks = pngChunks(b);
  if (!chunks) throw new Error("not a PNG this app can clean");
  return concat([b.subarray(0, 8), ...chunks.filter((c) => !PNG_METADATA.has(c.type)).map((c) => b.subarray(c.start, c.end))]);
}

// ── WebP ────────────────────────────────────────────────────────────

function webpFindings(b: Uint8Array): Finding[] {
  const out: Finding[] = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const type = ascii(b, i, 4);
    const len = (b[i + 4] | (b[i + 5] << 8) | (b[i + 6] << 16) | (b[i + 7] << 24)) >>> 0;
    if (type === "EXIF") out.push(...exifFindings(b.subarray(i + 8 + (startsWith(b, i + 8, "Exif\0\0") ? 6 : 0), i + 8 + len)));
    else if (type === "XMP ") out.push({ what: "XMP metadata (may include editing history and author)" });
    else if (type === "ICCP") out.push({ what: "ICC colour profile (may name the device)" });
    i += 8 + len + (len & 1);
  }
  return out;
}

// ── Public ──────────────────────────────────────────────────────────

/** What metadata the image carries. Empty for a clean image; for files that aren't images, empty too (see `imageKind`). */
export function findMetadata(b: Uint8Array): Finding[] {
  switch (imageKind(b)) {
    case "jpeg":
      return jpegFindings(b);
    case "png":
      return pngFindings(b);
    case "webp":
      return webpFindings(b);
    default:
      return [];
  }
}

/** Removes metadata segments from a JPEG or PNG without re-encoding. WebP and other files are refused. */
export function stripMetadata(b: Uint8Array): Uint8Array {
  const k = imageKind(b);
  if (k === "jpeg") return stripJpeg(b);
  if (k === "png") return stripPng(b);
  throw new Error(`can't strip metadata from a ${k} file without re-encoding it`);
}

/** Things worth warning about in a file that isn't an image this app can clean. */
export function otherFileWarnings(name: string, b: Uint8Array): Finding[] {
  const head = ascii(b, 0, Math.min(b.length, 4096));
  const out: Finding[] = [];
  if (head.startsWith("%PDF")) {
    out.push({ what: "PDF: may hold an author, the software used, edit history and hidden layers" });
    const text = ascii(b, 0, Math.min(b.length, 1 << 20));
    for (const key of ["Author", "Creator", "Producer"]) {
      const m = text.match(new RegExp(`/${key}\\s*\\(([^)]{1,80})\\)`));
      if (m) out.push({ what: `PDF ${key}`, value: m[1] });
    }
  } else if (head.startsWith("PK\x03\x04")) out.push({ what: "Office document or archive: may hold an author, comments, tracked changes and edit history" });
  else out.push({ what: "This app can't check this kind of file for metadata" });
  if (/\.(docx?|xlsx?|pptx?|odt|ods)$/i.test(name)) out.push({ what: "Office files often carry the author's name" });
  return out;
}

export const extensionOf = (mediaType: string): string =>
  ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf", "text/plain": "txt" })[mediaType] ?? "bin";

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}
