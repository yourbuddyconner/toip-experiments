// Images with metadata, for tests and the e2e run: an EXIF writer (camera, serial number, GPS),
// a synthetic JPEG and a PNG with text and eXIf chunks.

export interface ExifFields {
  make?: string;
  model?: string;
  serial?: string;
  /** Degrees; positive is north / east. */
  lat?: number;
  lon?: number;
}

/** A big-endian TIFF block holding the fields, as EXIF stores it. */
export function tiff(f: ExifFields): Uint8Array {
  type Entry = { tag: number; type: number; count: number; value: Uint8Array | number };
  const asciiBytes = (s: string) => new TextEncoder().encode(s + "\0");
  const rationals = (deg: number) => {
    const d = Math.floor(deg);
    const mFloat = (deg - d) * 60;
    const m = Math.floor(mFloat);
    const s = Math.round((mFloat - m) * 60 * 100);
    const out = new Uint8Array(24);
    const dv = new DataView(out.buffer);
    [d, 1, m, 1, s, 100].forEach((v, i) => dv.setUint32(i * 4, v));
    return out;
  };
  const ifd0: Entry[] = [];
  if (f.make) ifd0.push({ tag: 0x010f, type: 2, count: f.make.length + 1, value: asciiBytes(f.make) });
  if (f.model) ifd0.push({ tag: 0x0110, type: 2, count: f.model.length + 1, value: asciiBytes(f.model) });
  const exif: Entry[] = f.serial ? [{ tag: 0xa431, type: 2, count: f.serial.length + 1, value: asciiBytes(f.serial) }] : [];
  const gps: Entry[] =
    f.lat !== undefined && f.lon !== undefined
      ? [
          { tag: 1, type: 2, count: 2, value: asciiBytes(f.lat >= 0 ? "N" : "S") },
          { tag: 2, type: 5, count: 3, value: rationals(Math.abs(f.lat)) },
          { tag: 3, type: 2, count: 2, value: asciiBytes(f.lon >= 0 ? "E" : "W") },
          { tag: 4, type: 5, count: 3, value: rationals(Math.abs(f.lon)) },
        ]
      : [];
  if (exif.length) ifd0.push({ tag: 0x8769, type: 4, count: 1, value: 0 });
  if (gps.length) ifd0.push({ tag: 0x8825, type: 4, count: 1, value: 0 });

  const ifdSize = (n: number) => 2 + n * 12 + 4;
  const extra = (es: Entry[]) => es.reduce((n, e) => n + (e.value instanceof Uint8Array && e.value.length > 4 ? e.value.length + (e.value.length & 1) : 0), 0);
  const off0 = 8;
  const offExif = off0 + ifdSize(ifd0.length) + extra(ifd0);
  const offGps = offExif + (exif.length ? ifdSize(exif.length) + extra(exif) : 0);
  const total = offGps + (gps.length ? ifdSize(gps.length) + extra(gps) : 0);
  for (const e of ifd0) if (e.tag === 0x8769) e.value = offExif;
  for (const e of ifd0) if (e.tag === 0x8825) e.value = offGps;

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out.set([0x4d, 0x4d, 0x00, 0x2a]);
  dv.setUint32(4, off0);
  const write = (at: number, es: Entry[]) => {
    dv.setUint16(at, es.length);
    let data = at + ifdSize(es.length);
    es.forEach((e, i) => {
      const p = at + 2 + i * 12;
      dv.setUint16(p, e.tag);
      dv.setUint16(p + 2, e.type);
      dv.setUint32(p + 4, e.count);
      if (typeof e.value === "number") dv.setUint32(p + 8, e.value);
      else if (e.value.length <= 4) out.set(e.value, p + 8);
      else {
        dv.setUint32(p + 8, data);
        out.set(e.value, data);
        data += e.value.length + (e.value.length & 1);
      }
    });
    dv.setUint32(at + 2 + es.length * 12, 0);
  };
  write(off0, ifd0);
  if (exif.length) write(offExif, exif);
  if (gps.length) write(offGps, gps);
  return out;
}

function segment(marker: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  out.set([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]);
  out.set(payload, 4);
  return out;
}

export function exifSegment(f: ExifFields): Uint8Array {
  const t = tiff(f);
  const payload = new Uint8Array(6 + t.length);
  payload.set(new TextEncoder().encode("Exif\0\0"));
  payload.set(t, 6);
  return segment(0xe1, payload);
}

/** Inserts an EXIF APP1 segment (and an XMP and a comment segment, if asked) after a JPEG's SOI. */
export function withExif(jpeg: Uint8Array, f: ExifFields, more: { xmp?: boolean; comment?: string } = {}): Uint8Array {
  const parts = [jpeg.subarray(0, 2), exifSegment(f)];
  if (more.xmp) parts.push(segment(0xe1, new TextEncoder().encode("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><dc:creator>P. Raman</dc:creator></x:xmpmeta>")));
  if (more.comment) parts.push(segment(0xfe, new TextEncoder().encode(more.comment)));
  parts.push(jpeg.subarray(2));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

/** A JPEG-shaped file: SOI, APP0 JFIF, a quantization table, a scan and EOI. Not decodable; enough for the segment parser. */
export function syntheticJpeg(): Uint8Array {
  const app0 = segment(0xe0, new Uint8Array([0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]));
  const dqt = segment(0xdb, new Uint8Array(65));
  const sos = segment(0xda, new Uint8Array([1, 1, 0, 0, 63, 0]));
  const scan = new Uint8Array([0x12, 0x34, 0xff, 0x00, 0x56]);
  const parts = [new Uint8Array([0xff, 0xd8]), app0, dqt, sos, scan, new Uint8Array([0xff, 0xd9])];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  new DataView(out.buffer).setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  return out; // CRC left as zeros: the parser doesn't check it
}

/** A PNG-shaped file with IHDR, tEXt, iTXt, zTXt, eXIf, tIME, IDAT and IEND. */
export function pngWithMetadata(): Uint8Array {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const enc = (s: string) => new TextEncoder().encode(s);
  const parts = [
    sig,
    pngChunk("IHDR", new Uint8Array(13)),
    pngChunk("tEXt", enc("Author\0Priya Raman")),
    pngChunk("iTXt", enc("Comment\0\0\0\0\0Riverside plant")),
    pngChunk("zTXt", enc("Software\0\0xyz")),
    pngChunk("eXIf", tiff({ model: "Pixel 8", lat: 29.7604, lon: -95.3698 })),
    pngChunk("tIME", new Uint8Array(7)),
    pngChunk("IDAT", new Uint8Array([1, 2, 3])),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}
