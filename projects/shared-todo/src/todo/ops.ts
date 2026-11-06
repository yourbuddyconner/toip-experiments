import { newUrnUuid } from "@openvtc/trust-tasks-tsp";
import type { Proof } from "@openvtc/trust-tasks/runtime";
import { openItem, signDocument, verifyDocument, type Clock, type Identity, type SealedText } from "@zk-toip/trust-core";

export type OpKind = "add" | "check" | "uncheck" | "edit" | "delete";

/**
 * One change to the list, signed by its author. It is separate from the message that carries it,
 * so anyone can forward it and it still proves who wrote it (design 4.4).
 */
export interface Op {
  id: string;
  type: "todo/op";
  list: string;
  issuer: string;
  kind: OpKind;
  itemId: string;
  at: string;
  text?: string;
  sealed?: SealedText;
  readers?: string[];
  membershipId: string;
  proof?: Proof;
}

export type OpBody = Omit<Op, "id" | "type" | "issuer" | "at" | "proof">;

export function signOp(author: Identity, clock: Clock, body: OpBody): Op {
  const op: Op = { id: newUrnUuid(), type: "todo/op", issuer: author.did, at: clock.iso(), ...body };
  return signDocument(op, author, clock);
}

export async function verifyOp(op: Op, clock: Clock): Promise<boolean> {
  if (op?.type !== "todo/op") return false;
  return (await verifyDocument(op, clock)).valid;
}

/** A copy of `op` with different text and the original proof, which no longer verifies. */
export function tamperOp(op: Op, text: string): Op {
  return { ...structuredClone(op), text };
}

/** The op's text as `me` can read it: plain text, private text `me` can open, or undefined. */
export async function readableText(op: Op, me: Identity): Promise<string | undefined> {
  if (op.text !== undefined) return op.text;
  if (!op.sealed) return undefined;
  return (await openItem(op.sealed, me))?.text;
}

const KINDS = new Set(["add", "check", "uncheck", "edit", "delete"]);
/** Strict UTC ISO 8601, so times compare the same way on every device and browser (review I2). */
export const STRICT_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const isStr = (x: unknown): x is string => typeof x === "string";

/** Shape check before anything else touches an op (design v2 §4.5 rule 1). */
export function validateOpShape(x: unknown): x is Op {
  const o = x as Op;
  if (!o || typeof o !== "object") return false;
  if (o.type !== "todo/op" || !isStr(o.id) || !isStr(o.list) || !isStr(o.issuer) || !KINDS.has(o.kind) || !isStr(o.itemId)) return false;
  if (!isStr(o.at) || !STRICT_UTC.test(o.at) || !isStr(o.membershipId)) return false;
  if (o.text !== undefined && !isStr(o.text)) return false;
  if (o.readers !== undefined && !(Array.isArray(o.readers) && o.readers.every(isStr))) return false;
  if (o.sealed !== undefined) {
    const s = o.sealed;
    if (!s || !isStr(s.nonce) || !isStr(s.ciphertext) || !Array.isArray(s.keys)) return false;
    if (!s.keys.every((k) => k && isStr(k.to) && isStr(k.enc) && isStr(k.wrapped))) return false;
  }
  return typeof o.proof === "object" && o.proof !== null;
}

/** Ops are identified by author and id. */
export const opKey = (op: Pick<Op, "issuer" | "id">): string => `${op.issuer}|${op.id}`;
