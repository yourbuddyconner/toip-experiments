/**
 * Tile commitments and redaction proofs (design §11.3). The camera commits to salted hashes of 64×64 RGBA
 * tiles decoded with a fixed decoder. An editor that redacts or crops discloses the salts of the tiles it
 * kept, so a verifier can check they are exactly what the camera saw, without the original.
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import jpeg from "jpeg-js";
import { decode as decodePng, encode as encodePng } from "fast-png";
import { concat, equal, sha, u16, u32, utf8 } from "./bytes";
import type { Rect, TileCommit, TileProofRef } from "./manifest";

export const TILE = 64;
export const JPEG_DECODER = "jpeg-js/0.4.4/rgba";
export const PNG_DECODER = "fast-png/8.0.0/rgba";
const SALT_LABEL = utf8("capture/tile-salt/v1");
const TILE_LABEL = utf8("capture/tile/v1");

export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

/** The reference JPEG decoder: jpeg-js, pure JavaScript, so every platform gets the same pixels. */
export function decodeJpegReference(b: Uint8Array): Rgba {
  const img = jpeg.decode(b, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
  return { width: img.width, height: img.height, data: new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength) };
}

/** The reference PNG decoder: fast-png, normalized to 8-bit RGBA. */
export function decodePngReference(b: Uint8Array): Rgba {
  const img = decodePng(b);
  const { width, height, channels, depth } = img;
  const src = img.data;
  const out = new Uint8Array(width * height * 4);
  const scale = depth === 16 ? (v: number) => v >> 8 : (v: number) => v;
  for (let p = 0; p < width * height; p++) {
    const s = p * channels;
    if (channels >= 3) {
      out[p * 4] = scale(src[s]);
      out[p * 4 + 1] = scale(src[s + 1]);
      out[p * 4 + 2] = scale(src[s + 2]);
      out[p * 4 + 3] = channels === 4 ? scale(src[s + 3]) : 255;
    } else {
      const g = scale(src[s]);
      out[p * 4] = out[p * 4 + 1] = out[p * 4 + 2] = g;
      out[p * 4 + 3] = channels === 2 ? scale(src[s + 1]) : 255;
    }
  }
  return { width, height, data: out };
}

export function encodePngRgba(img: Rgba): Uint8Array {
  return encodePng({ width: img.width, height: img.height, data: img.data, channels: 4, depth: 8 });
}

export function encodeJpegRgba(img: Rgba, quality = 90): Uint8Array {
  const out = jpeg.encode({ width: img.width, height: img.height, data: img.data }, quality);
  return new Uint8Array(out.data);
}

export interface Grid {
  size: number;
  cols: number;
  rows: number;
  width: number;
  height: number;
}

export const gridOf = (width: number, height: number, size = TILE): Grid => ({ size, cols: Math.ceil(width / size), rows: Math.ceil(height / size), width, height });

export function tileRect(g: Grid, i: number): Rect {
  const x = (i % g.cols) * g.size;
  const y = Math.floor(i / g.cols) * g.size;
  return { x, y, w: Math.min(g.size, g.width - x), h: Math.min(g.size, g.height - y) };
}

function tilePixels(img: Rgba, x: number, y: number, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let r = 0; r < h; r++) out.set(img.data.subarray(((y + r) * img.width + x) * 4, ((y + r) * img.width + x + w) * 4), r * w * 4);
  return out;
}

export function tileSalt(tileKey: Uint8Array, i: number): Uint8Array {
  return hmac(sha256, tileKey, concat(SALT_LABEL, u32(i))).slice(0, 16);
}

function tileHash(i: number, r: Rect, salt: Uint8Array, rgba: Uint8Array): Uint8Array {
  return sha(concat(TILE_LABEL, u32(i), u16(r.x), u16(r.y), u16(r.w), u16(r.h), salt, rgba));
}

export function commitTiles(img: Rgba, tileKey: Uint8Array, decoder = JPEG_DECODER, size = TILE): { commit: TileCommit; hashes: Uint8Array } {
  const g = gridOf(img.width, img.height, size);
  const n = g.cols * g.rows;
  const hashes = new Uint8Array(n * 32);
  for (let i = 0; i < n; i++) {
    const r = tileRect(g, i);
    hashes.set(tileHash(i, r, tileSalt(tileKey, i), tilePixels(img, r.x, r.y, r.w, r.h)), i * 32);
  }
  return { commit: { size, cols: g.cols, rows: g.rows, decoder, root: sha(hashes) }, hashes };
}

export const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const bit = (bm: Uint8Array, i: number) => (bm[i >> 3] >> (i & 7)) & 1;

/** Where capture tile `i` lands in the output, given the crop offset in tiles. */
function outputRect(g: Grid, i: number, offset: [number, number]): Rect {
  const r = tileRect(g, i);
  return { x: r.x - offset[0] * g.size, y: r.y - offset[1] * g.size, w: r.w, h: r.h };
}

const inside = (r: Rect, img: { width: number; height: number }) => r.x >= 0 && r.y >= 0 && r.x + r.w <= img.width && r.y + r.h <= img.height;
const overlaps = (r: Rect, img: { width: number; height: number }) => intersects(r, { x: 0, y: 0, w: img.width, h: img.height });

/**
 * The editor's side: which capture tiles survive unchanged in `edited`, and their salts.
 * `regions` are the declared redactions in output pixels; a tile touching one counts as changed.
 */
export function proveTiles(original: Rgba, edited: Rgba, tileKey: Uint8Array, regions: Rect[], offset: [number, number] = [0, 0], size = TILE): { ref: Omit<TileProofRef, "against">; salts: Uint8Array; kept: number } {
  const g = gridOf(original.width, original.height, size);
  const n = g.cols * g.rows;
  const kept = new Uint8Array(Math.ceil(n / 8));
  const salts: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const src = tileRect(g, i);
    const out = outputRect(g, i, offset);
    if (!inside(out, edited) || regions.some((r) => intersects(r, out))) continue;
    if (!equal(tilePixels(original, src.x, src.y, src.w, src.h), tilePixels(edited, out.x, out.y, out.w, out.h))) continue;
    kept[i >> 3] |= 1 << (i & 7);
    salts.push(tileSalt(tileKey, i));
  }
  return { ref: { offset, kept }, salts: concat(...salts), kept: salts.length };
}

export interface TileFailure {
  tile: number;
  reason: "changed" | "undeclaredChange" | "outsideOutput" | "malformed";
}

export interface TileCheck {
  kept: number;
  redacted: number;
  cropped: number;
  total: number;
  failures: TileFailure[];
  /** Per capture tile: "kept", "redacted", "cropped" or "failed"; for the overlay. */
  map: ("kept" | "redacted" | "cropped" | "failed")[];
  grid: Grid;
}

/**
 * The verifier's side. `captureHashes` is the capture's tile hash list; the caller checks it against the
 * signed root first. `capture` gives the capture's pixel size.
 */
export function checkTiles(
  edited: Rgba,
  capture: { width: number; height: number; commit: TileCommit },
  captureHashes: Uint8Array,
  ref: TileProofRef,
  salts: Uint8Array,
  regions: Rect[],
): TileCheck {
  const g = gridOf(capture.width, capture.height, capture.commit.size);
  const n = g.cols * g.rows;
  const out: TileCheck = { kept: 0, redacted: 0, cropped: 0, total: n, failures: [], map: [], grid: g };
  if (g.cols !== capture.commit.cols || g.rows !== capture.commit.rows || captureHashes.length !== n * 32 || ref.kept.length !== Math.ceil(n / 8)) {
    out.failures.push({ tile: -1, reason: "malformed" });
    return out;
  }
  const [dx, dy] = ref.offset;
  // every output pixel must come from some capture tile: no growing the canvas
  if (dx < 0 || dy < 0 || edited.width > capture.width - dx * g.size || edited.height > capture.height - dy * g.size) {
    out.failures.push({ tile: -1, reason: "outsideOutput" });
    return out;
  }
  let k = 0;
  for (let i = 0; i < n; i++) {
    const o = outputRect(g, i, ref.offset);
    if (bit(ref.kept, i)) {
      const salt = salts.subarray(k * 16, k * 16 + 16);
      k++;
      if (salt.length !== 16 || !inside(o, edited)) {
        out.failures.push({ tile: i, reason: salt.length !== 16 ? "malformed" : "outsideOutput" });
        out.map.push("failed");
        continue;
      }
      const h = tileHash(i, tileRect(g, i), salt, tilePixels(edited, o.x, o.y, o.w, o.h));
      if (equal(h, captureHashes.subarray(i * 32, i * 32 + 32))) {
        out.kept++;
        out.map.push("kept");
      } else {
        out.failures.push({ tile: i, reason: "changed" });
        out.map.push("failed");
      }
      continue;
    }
    if (!overlaps(o, edited)) {
      out.cropped++;
      out.map.push("cropped");
    } else if (regions.some((r) => intersects(r, o))) {
      out.redacted++;
      out.map.push("redacted");
    } else {
      out.failures.push({ tile: i, reason: "undeclaredChange" });
      out.map.push("failed");
    }
  }
  if (k * 16 !== salts.length) out.failures.push({ tile: -1, reason: "malformed" });
  return out;
}

// ---- redaction filters (deterministic, so tests and the browser agree)

export type RedactMethod = "pixelate-16" | "gaussian-12" | "fill-black";

export function redact(img: Rgba, regions: Rect[], method: RedactMethod): Rgba {
  const data = img.data.slice();
  const W = img.width;
  for (const r0 of regions) {
    const r = { x: Math.max(0, r0.x), y: Math.max(0, r0.y), w: Math.min(W, r0.x + r0.w) - Math.max(0, r0.x), h: Math.min(img.height, r0.y + r0.h) - Math.max(0, r0.y) };
    if (r.w <= 0 || r.h <= 0) continue;
    if (method === "fill-black") {
      for (let y = r.y; y < r.y + r.h; y++)
        for (let x = r.x; x < r.x + r.w; x++) {
          const p = (y * W + x) * 4;
          data[p] = data[p + 1] = data[p + 2] = 0;
          data[p + 3] = 255;
        }
      continue;
    }
    const block = method === "pixelate-16" ? 16 : 24;
    for (let by = r.y; by < r.y + r.h; by += block)
      for (let bx = r.x; bx < r.x + r.w; bx += block) {
        const bw = Math.min(block, r.x + r.w - bx);
        const bh = Math.min(block, r.y + r.h - by);
        const sum = [0, 0, 0];
        for (let y = by; y < by + bh; y++)
          for (let x = bx; x < bx + bw; x++) {
            const p = (y * W + x) * 4;
            sum[0] += img.data[p];
            sum[1] += img.data[p + 1];
            sum[2] += img.data[p + 2];
          }
        const n = bw * bh;
        for (let y = by; y < by + bh; y++)
          for (let x = bx; x < bx + bw; x++) {
            const p = (y * W + x) * 4;
            // a heavy blur: the block mean, nudged toward grey so detail can't be recovered from it
            const mix = method === "gaussian-12" ? 0.85 : 1;
            data[p] = Math.round((sum[0] / n) * mix + 128 * (1 - mix));
            data[p + 1] = Math.round((sum[1] / n) * mix + 128 * (1 - mix));
            data[p + 2] = Math.round((sum[2] / n) * mix + 128 * (1 - mix));
            data[p + 3] = 255;
          }
      }
  }
  return { width: img.width, height: img.height, data };
}

/** Crops to a rectangle. For tile proofs, x and y should be multiples of the tile size. */
export function crop(img: Rgba, r: Rect): Rgba {
  const out = new Uint8Array(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) out.set(img.data.subarray(((r.y + y) * img.width + r.x) * 4, ((r.y + y) * img.width + r.x + r.w) * 4), y * r.w * 4);
  return { width: r.w, height: r.h, data: out };
}
