/** Making and reading witness receipts and endorsements. */
import { ed25519 } from "@noble/curves/ed25519.js";
import { utf8, type Identity } from "@zk-toip/trust-core";
import { nonTransferableAid } from "./cesr";
import { buildRct } from "./kel";
import { signWith, type Signer } from "./keys";
import { buildTrc } from "./trail";
import { attachmentsOf } from "./stream";
import type { StoredReceipt } from "./store";
import type { SignedMessage } from "./types";

/** A non-transferable (B) signer's AID. Witnesses and did:key endorsers have one. */
export function signerAid(s: Signer): string {
  if ((s.curve ?? "ed25519") !== "ed25519") throw new Error("witnesses and endorsers use Ed25519 keys");
  return nonTransferableAid(s.publicKey);
}

/**
 * A witness receipt.
 * KEL events: a KERI `rct` with a `-B` indexed signature over the event (index = position in the witness list).
 * Trail messages: a `trc` with its own time, and a `-C` couple over the trc.
 */
export async function makeReceipt(msg: SignedMessage, signer: Signer, opts: { index?: number; dt: string }): Promise<SignedMessage> {
  if (msg.t === "icp" || msg.t === "rot" || msg.t === "ixn") {
    if (opts.index === undefined) throw new Error("a KEL receipt needs the witness index");
    const { raw, body } = buildRct({ aid: msg.logId, s: msg.s, said: msg.d });
    const { sig } = await signWith(signer, utf8(msg.raw));
    return { t: "rct", raw, body, logId: msg.logId, s: msg.s, d: msg.d, witnessSigs: [{ code: "A", index: opts.index, ondex: opts.index, sig }] };
  }
  const { raw, body } = buildTrc({ logId: msg.logId, s: msg.s, said: msg.d, dt: opts.dt });
  const { sig } = await signWith(signer, utf8(raw));
  return { t: "trc", raw, body, logId: msg.logId, s: msg.s, d: msg.d, couples: [{ signer: signerAid(signer), sig }] };
}

/** An endorsement of a trail entry by a did:key identity (a counterparty, a principal). */
export function endorse(entry: SignedMessage, identity: Identity, dt: string): SignedMessage {
  const { raw, body } = buildTrc({ logId: entry.logId, s: entry.s, said: entry.d, dt });
  const sig = ed25519.sign(utf8(raw), identity.signingSecret);
  return { t: "trc", raw, body, logId: entry.logId, s: entry.s, d: entry.d, couples: [{ signer: nonTransferableAid(identity.signingPublic), sig }] };
}

export function toStoredReceipt(r: SignedMessage, by: string, kind: StoredReceipt["kind"]): StoredReceipt {
  const out: StoredReceipt = { by, kind, raw: r.raw, attachments: attachmentsOf(r) };
  if (typeof r.body.dt === "string") out.dt = r.body.dt;
  return out;
}

/** The signers of a receipt: couples, and -B indexes resolved against a witness list. */
export function receiptSigners(r: SignedMessage, witnesses: string[] = []): string[] {
  const out = (r.couples ?? []).map((c) => c.signer);
  for (const w of r.witnessSigs ?? []) if (witnesses[w.index]) out.push(witnesses[w.index]);
  return out;
}
