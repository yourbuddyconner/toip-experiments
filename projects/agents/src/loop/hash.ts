/** Canonical JSON (sorted keys, no whitespace) and SHA-256, for request and tool-manifest hashes. Node only, no trust-core. */
import { createHash } from "node:crypto";

export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canonical(x))).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

export const sha256Hex = (text: string): string => `sha256:${createHash("sha256").update(text).digest("hex")}`;
export const hashOf = (v: unknown): string => sha256Hex(canonical(v));
