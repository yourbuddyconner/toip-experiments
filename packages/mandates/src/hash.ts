import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalJson, utf8 } from "@toip-tools/trust-core";
import type { Action, Mandate } from "./types.js";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export const sha256Tag = (bytes: Uint8Array): string => `sha256:${hex(sha256(bytes))}`;

/** SHA-256 of the JCS form of any JSON value, as "sha256:<hex>". */
export const jcsHash = (value: unknown): string => sha256Tag(utf8(canonicalJson(value)));

/** SHA-256 of a mandate's JCS form, proof included. A child's `parent.hash`. */
export const mandateHash = (m: Mandate): string => jcsHash(m);

/** SHA-256 of an action's JCS form. Approvals and decisions refer to it. */
export const actionHash = (a: Action): string => jcsHash(a);
