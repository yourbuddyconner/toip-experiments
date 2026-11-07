/**
 * Agora's documents (design §7). Every signed document is JSON with an `issuer` and an eddsa-jcs-2022
 * proof from trust-core's signDocument. "Hash" is hex SHA-256 over the JCS form without `proof`.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { GroupRoot, MembershipProof } from "@toip-tools/anon-membership";
import { canonicalJson } from "@toip-tools/trust-core";

/** The app label for scopes and signals: scopeOf(APP, …) and messageOf(APP, …). */
export const APP = "agora/v1";

/** How long a nym pass may live (decision: 24 hours). */
export const PASS_MAX_MS = 24 * 3600_000;

export type Encoding = "hash" | "u64" | "day";

export interface SlotSpec {
  /** The attribute's name in predicates, e.g. "licenseType". */
  name: string;
  /** Words for people, e.g. "license type". */
  label: string;
  /** Where it is in the credential: a path under credentialSubject. */
  from: string;
  encoding: Encoding;
  /** Publish per-value member counts with each root, so clients can estimate anonymity sets. */
  publishCounts?: boolean;
}

/** A group, signed by its registrar (design §7.1). In the MVP the registrar is the issuer itself. */
export interface GroupDescriptor {
  type: "agora/group";
  version: 1;
  /** "<registrar DID>#<name>", as anon-membership's groupIdOf makes it. */
  id: string;
  issuer: string;
  issuedAt: string;
  /** For people: "Cascade Board of Nursing". */
  title: string;
  /** For people: "nursing license". */
  credentialLabel: string;
  source: { issuer: string; credentialType: string; statusList: string };
  schema: { id: string; schemaId: string; slots: (SlotSpec | null)[] };
  rotation: { maxPerYear: number };
  rootCadenceSeconds: number;
  proof?: unknown;
}

export interface GroupRef {
  group: string;
  registrar: string;
}

export interface GatePredicate {
  attr: string;
  op: "eq" | "gte" | "lte";
  value: string;
}

export interface Gate {
  anyOf: GroupRef[];
  where: GatePredicate[];
  minRegisteredDays: number;
  minAnonymitySet: number;
}

export interface ForumPolicy {
  type: "agora/forum-policy";
  version: 1;
  id: string;
  issuer: string;
  issuedAt: string;
  forum: { id: string; slug: string; title: string; description: string; hosts: string[] };
  previous: string | null;
  gate: Gate;
  nyms: "forum" | "thread";
  posting: { rate: { posts: number; perSeconds: number }; maxBodyBytes: number; polls: "moderators" };
  rootGraceSeconds: number;
  moderators: string[];
  /** Numbered rules; moderators cite them as reasons. */
  rules: string[];
  proof?: unknown;
}

export interface NymPass {
  type: "agora/nym-pass";
  version: 1;
  id: string;
  /** The session DID: a fresh did:key for this pass. */
  issuer: string;
  issuedAt: string;
  forum: string;
  /** Hash of the policy the pass was made under. */
  policy: string;
  /** Null for a forum nym; a thread id for a thread nym. */
  thread: string | null;
  /** The nullifier, hex. */
  nym: string;
  validUntil: string;
  zk: MembershipProof;
  proof?: unknown;
}

export interface Post {
  type: "agora/post";
  version: 1;
  id: string;
  issuer: string;
  issuedAt: string;
  forum: string;
  /** Equals `id` for a thread's first post. */
  thread: string;
  parent: string | null;
  /** First post only. */
  title?: string;
  body: string;
  nym: string;
  /** Hash of the pass that holds this session DID. */
  pass: string;
  /** First post only: "thread" asks for the thread's own nym scope. */
  nymScope?: "forum" | "thread";
  proof?: unknown;
}

export interface DeleteDoc {
  type: "agora/delete";
  version: 1;
  id: string;
  issuer: string;
  issuedAt: string;
  forum: string;
  target: string;
  nym: string;
  proof?: unknown;
}

export interface ReportDoc {
  type: "agora/report";
  version: 1;
  id: string;
  issuer: string;
  issuedAt: string;
  forum: string;
  target: string;
  reason: string;
  nym: string;
  proof?: unknown;
}

export type ModerationAction = "hide-post" | "restore-post" | "ban-nym" | "unban-nym" | "lock-thread" | "unlock-thread" | "slow-nym";
export const MODERATION_ACTIONS: ModerationAction[] = ["hide-post", "restore-post", "ban-nym", "unban-nym", "lock-thread", "unlock-thread", "slow-nym"];

export interface Moderation {
  type: "agora/moderation";
  version: 1;
  id: string;
  issuer: string;
  issuedAt: string;
  forum: string;
  action: ModerationAction;
  /** A post id, a thread id, or a nym. */
  target: string;
  /** Bans and slow-nym: null is permanent. */
  until?: string | null;
  rate?: { posts: number; perSeconds: number };
  reason: string;
  proof?: unknown;
}

export interface PinnedRoot {
  group: string;
  seq: number;
  root: string;
}

export interface Poll {
  type: "agora/poll";
  version: 1;
  id: string;
  issuer: string;
  issuedAt: string;
  forum: string;
  thread: string | null;
  question: string;
  choices: string[];
  opensAt: string;
  closesAt: string;
  gate: Gate;
  /** The latest root of each gate group when the poll was made, in gate order. */
  pinned: PinnedRoot[];
  proof?: unknown;
}

/** A vote has no session key: its proof is its authority. */
export interface Vote {
  type: "agora/vote";
  version: 1;
  poll: string;
  choice: number;
  nullifier: string;
  zk: MembershipProof;
}

export type ForumDoc = ForumPolicy | NymPass | Post | DeleteDoc | ReportDoc | Moderation | Poll | Vote;

/** The receipt a registrar keeps for a member, and sends only to them (design §7.6). */
export interface GroupReceipt {
  type: "agora/group-receipt";
  issuer: string;
  issuedAt: string;
  group: string;
  subject: string;
  index: number;
  leaf: { commitment: string; schemaId: string; validUntilDay: number; registeredDay: number; attrs: string[] };
  /** The credential's plain values per slot, so the member's client can explain the gate in words. */
  values: Record<string, string>;
  proof?: unknown;
}

const enc = new TextEncoder();

/** Hex SHA-256 of the JCS of `doc` without its `proof`. */
export function docHash(doc: object): string {
  const { proof: _p, ...rest } = doc as { proof?: unknown };
  return bytesToHex(sha256(enc.encode(canonicalJson(rest))));
}

export function newId(): string {
  return `urn:uuid:${crypto.randomUUID()}`;
}

export type { GroupRoot };
