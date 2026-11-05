import { newUrnUuid } from "@openvtc/trust-tasks-tsp";
import type { Proof } from "@openvtc/trust-tasks/runtime";
import { openItem, signDocument, verifyDocument, type DemoClock, type Identity, type SealedText } from "@zk-toip/trust-core";

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

export function signOp(author: Identity, clock: DemoClock, body: OpBody): Op {
  const op: Op = { id: newUrnUuid(), type: "todo/op", issuer: author.did, at: clock.iso(), ...body };
  return signDocument(op, author, clock);
}

export async function verifyOp(op: Op, clock: DemoClock): Promise<boolean> {
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
