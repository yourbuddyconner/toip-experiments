import { fromB64u } from "@toip-tools/trust-core";
import bundled from "../artifacts/crs.json" with { type: "json" };

export { G2_POINT_HEX } from "./g2.js";

/** Setup data for proving and verifying: uncompressed BN254 G1 points (64 bytes each) and the G2 point. */
export interface Crs {
  points: number;
  g1: Uint8Array;
  g2: Uint8Array;
}

/**
 * Where the prover gets its CRS. The default is the copy bundled with this package, so bb.js
 * never downloads points and never caches them in IndexedDB.
 */
export type CrsSource = { kind: "bundled" } | { kind: "bytes"; crs: Crs };

let decoded: Crs | undefined;

/** The CRS bundled in artifacts/crs.json, enough points for every compiled circuit. */
export function bundledCrs(): Crs {
  decoded ??= { points: bundled.points, g1: fromB64u(bundled.g1), g2: fromB64u(bundled.g2) };
  return decoded;
}

export function resolveCrs(source: CrsSource = { kind: "bundled" }, needPoints = 0): Crs {
  const crs = source.kind === "bytes" ? source.crs : bundledCrs();
  if (crs.g1.length !== crs.points * 64) throw new Error("CRS G1 data must be 64 bytes per point");
  if (crs.g2.length !== 128) throw new Error("CRS G2 point must be 128 bytes");
  if (crs.points < needPoints) throw new Error(`the circuit needs ${needPoints} CRS points; this CRS has ${crs.points}`);
  return crs;
}
