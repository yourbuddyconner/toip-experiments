/**
 * Tipline's Trust Tasks (design §7) and what binds a proof to one tip (§7.3).
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { messageOf, scopeOf, type Field, type MembershipProof } from "@zk-toip/anon-membership";
import { canonicalJson, ourSpec } from "@zk-toip/trust-core";

export const APP = "tipline/v1";

export const SUBMIT = ourSpec("tipline/tip/submit");
export const CHUNK = ourSpec("tipline/tip/chunk");
export const RECEIPT = ourSpec("tipline/tip/receipt");
export const MESSAGE = ourSpec("tipline/message");
export const THREAD_REQUEST = ourSpec("tipline/thread/request");
export const PROOF_REQUEST = ourSpec("tipline/proof/request");
export const PROOF_PRESENT = ourSpec("tipline/proof/present");

/**
 * Messages wait on the relay for up to 30 days, and sources date theirs to the hour. So the
 * acceptance window is the relay's 30 days plus a day, not the trust-tasks default of 5 minutes.
 */
export const FRESHNESS: { skewMs: number; maxAgeMs: number; requireIssuedAt: boolean } = { skewMs: 60_000, maxAgeMs: 31 * 86_400_000, requireIssuedAt: true };

export interface TipBody {
  subject: string;
  text: string;
}

export interface AttachmentInfo {
  id: string;
  /** Always attachment-<n>.<ext>: the source's own file name is never sent. */
  name: string;
  mediaType: string;
  bytes: number;
  sha256: string;
  chunks: number;
  cleaned: "reencoded" | "none";
}

export interface SubmitPayload {
  v: 1;
  tipId: string;
  story: string;
  body: TipBody;
  attachments: AttachmentInfo[];
  /** Sealed chunk messages that follow, dummy ones included. */
  chunks: number;
  membership: MembershipProof;
  padding: string;
}

export interface ChunkPayload {
  tipId: string;
  /** An attachment id, or "pad" for a dummy chunk. */
  attachment: string;
  index: number;
  count: number;
  data: string;
  padding?: string;
}

export type ReceiptReason =
  | "story"
  | "duplicate"
  | "sender"
  | "malformed"
  | "attachment"
  | "circuit"
  | "group"
  | "log"
  | "equivocation"
  | "unknownRoot"
  | "stale"
  | "tooSmall"
  | "scope"
  | "signal"
  | "statement"
  | "proof";

export interface ReceiptPayload {
  tipId: string;
  status: "verified" | "rejected";
  reason?: ReceiptReason;
  missing?: { attachment: string; index: number }[];
  padding?: string;
}

export interface MessagePayload {
  tipId: string;
  /** Unique per message, so a resent thread doesn't show a message twice. */
  id: string;
  text: string;
  /** Set when the drop box resends the thread: who first wrote this message, and when (to the hour). */
  from?: "source" | "dropbox";
  at?: string;
  padding?: string;
}

export interface ThreadRequestPayload {
  tipId: string;
  padding?: string;
}

export interface ProofRequestPayload {
  tipId: string;
  challenge: string;
  /** The story the tip was for, so a source who kept nothing knows which proof to make. */
  story: string;
  padding?: string;
}

export interface ProofPresentPayload {
  tipId: string;
  challenge: string;
  membership: MembershipProof;
  padding?: string;
}

export function hexSha256(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

export function bodyHash(body: TipBody): string {
  return hexSha256(new TextEncoder().encode(canonicalJson(body)));
}

/** The nullifier scope: one per drop box and story. */
export function tipScope(dropbox: string, story: string): Field {
  return scopeOf(APP, dropbox, story);
}

/** What a tip's proof is bound to: the drop box, the story, the tip, the reply DID, the body and the files. */
export function tipSignal(t: { dropbox: string; story: string; tipId: string; replyTo: string; body: TipBody; attachments: { id: string; sha256: string; bytes: number }[] }): Field {
  return messageOf(APP, {
    kind: "tip",
    dropbox: t.dropbox,
    story: t.story,
    tipId: t.tipId,
    replyTo: t.replyTo,
    body: bodyHash(t.body),
    attachments: t.attachments.map((a) => ({ id: a.id, sha256: a.sha256, bytes: a.bytes })),
  });
}

/** What a fresh proof (tipline/proof/present) is bound to. */
export function presentSignal(t: { dropbox: string; story: string; tipId: string; replyTo: string; challenge: string }): Field {
  return messageOf(APP, { kind: "present", dropbox: t.dropbox, story: t.story, tipId: t.tipId, replyTo: t.replyTo, challenge: t.challenge });
}

/** Why a drop box refused a tip, in words for the source and the journalist. */
export const REASON_TEXT: Record<ReceiptReason, string> = {
  story: "the story isn't open, or isn't one of this drop box's",
  duplicate: "this tip id was already used",
  sender: "the document's signer isn't its sender",
  malformed: "the message isn't a well-formed tip",
  attachment: "an attachment didn't match its hash",
  circuit: "the proof is for a circuit this drop box doesn't accept",
  group: "the proof is for another group",
  log: "the organization's root log couldn't be checked",
  equivocation: "the organization signed two different roots for one day",
  unknownRoot: "the proof is against a root that isn't in the organization's log",
  stale: "the proof is against a root older than this story accepts",
  tooSmall: "the group was too small at that root",
  scope: "the proof is for another story or drop box",
  signal: "the proof was made for another tip, sender, body or file",
  statement: "the proof's statement doesn't match this drop box's policy",
  proof: "the proof doesn't verify",
};
