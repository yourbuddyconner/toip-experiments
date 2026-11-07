import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Refusal, fromB64u, ourSpec, signDocument, toB64u, type Clock, type Endpoint, type Identity } from "@toip-tools/trust-core";
import { CIRCUIT_ID } from "./artifacts.js";
import { groupFieldOf, groupIdOf } from "./encode.js";
import { fieldFromHex, fieldToHex, type Field } from "./field.js";
import { commitmentOf, leafHash, plainLeaf, type Leaf } from "./hash.js";
import { DAY_SECONDS, ROOT_TYPE, epochOf, rootDocHash, type GroupRoot } from "./roots.js";
import { GroupTree } from "./tree.js";

/** ourSpec("anon-membership/enroll"): member DID → issuer, request and response. */
export const ENROLL = ourSpec("anon-membership/enroll");

export interface EnrollRequest {
  group: string;
  commitment: string;
  /** Anything the issuer's admit() needs to decide and to fill the leaf's attributes, such as a credential. */
  credential?: unknown;
  /** The member asks to replace a leaf they already have, with a new commitment (a rotation). admit() decides. (Additive.) */
  replace?: boolean;
}

export interface LeafJson {
  commitment: string;
  schemaId: string;
  validUntilDay: number;
  registeredDay: number;
  attrs: string[];
}

export interface EnrollResponse {
  group: string;
  index: number;
  /** The first epoch whose root will hold the leaf. */
  firstEpoch: string;
  leaf: LeafJson;
}

/** What the member's side gets back, decoded. */
export interface Enrollment {
  group: string;
  index: number;
  firstEpoch: string;
  leaf: Leaf;
}

export type LeafFields = Omit<Leaf, "commitment">;

export function encodeLeaf(l: Leaf): LeafJson {
  return { commitment: fieldToHex(l.commitment), schemaId: fieldToHex(l.schemaId), validUntilDay: l.validUntilDay, registeredDay: l.registeredDay, attrs: l.attrs.map(fieldToHex) };
}

export function decodeLeaf(j: LeafJson): Leaf {
  if (!j || !Array.isArray(j.attrs) || j.attrs.length !== 4) throw new Error("malformed leaf");
  const leaf: Leaf = {
    commitment: fieldFromHex(j.commitment),
    schemaId: fieldFromHex(j.schemaId),
    validUntilDay: j.validUntilDay,
    registeredDay: j.registeredDay,
    attrs: j.attrs.map(fieldFromHex) as Leaf["attrs"],
  };
  leafHash(leaf); // checks the day numbers
  return leaf;
}

export interface GroupIssuerState {
  v: 1;
  name: string;
  depth: number;
  period: number;
  leaves: string[];
  members: Record<string, { index: number; leaf: LeafJson }>;
  log: GroupRoot[];
  /** Snapshots of recent epochs, base64url. */
  snapshots: Record<string, string>;
}

/**
 * Runs one group: enrolls members, removes leavers, and signs one root per epoch in a hash chain.
 * It holds DIDs and commitments, never a member's secret.
 */
export class GroupIssuer {
  readonly groupId: string;
  readonly groupField: Field;
  readonly period: number;
  private readonly identity: Identity;
  private readonly clock: Clock;
  private readonly name: string;
  private readonly depth: number;
  private readonly keepSnapshots: number;
  private readonly t: GroupTree;
  private readonly members = new Map<string, { index: number; leaf: Leaf }>();
  private readonly roots: GroupRoot[] = [];
  private readonly snapshots = new Map<string, Uint8Array>();

  constructor(opts: {
    identity: Identity;
    clock: Clock;
    name: string;
    depth?: number;
    /** Seconds per epoch. Default: one day. */
    period?: number;
    /** How many recent epochs' snapshots to keep. Default 30. */
    keepSnapshots?: number;
    state?: GroupIssuerState;
  }) {
    this.identity = opts.identity;
    this.clock = opts.clock;
    this.name = opts.name;
    this.depth = opts.depth ?? 20;
    if (this.depth !== 20) throw new Error("only depth 20 has a circuit");
    this.period = opts.period ?? DAY_SECONDS;
    this.keepSnapshots = opts.keepSnapshots ?? 30;
    this.groupId = groupIdOf(opts.identity.did, opts.name);
    this.groupField = groupFieldOf(this.groupId);
    const s = opts.state;
    if (s) {
      if (s.v !== 1 || s.name !== opts.name || s.depth !== this.depth || s.period !== this.period) throw new Error("state is for another group");
      this.t = GroupTree.fromLeaves(s.leaves.map(fieldFromHex), this.depth);
      for (const [did, m] of Object.entries(s.members)) this.members.set(did, { index: m.index, leaf: decodeLeaf(m.leaf) });
      this.roots.push(...s.log);
      for (const [epoch, b] of Object.entries(s.snapshots)) this.snapshots.set(epoch, fromB64u(b));
    } else {
      this.t = new GroupTree(this.depth);
    }
  }

  /**
   * Adds or replaces `subject`'s leaf. The old leaf, if any, becomes 0 and a new index is used.
   * `fields` sets the leaf's schema, days and attributes; the default is a plain leaf.
   */
  enroll(subject: string, commitment: Field, fields?: LeafFields): { index: number; leaf: Leaf } {
    const leaf: Leaf = fields ? { ...fields, commitment } : plainLeaf(commitment);
    const hash = leafHash(leaf);
    if (hash === 0n) throw new Error("a leaf can't be 0");
    const old = this.members.get(subject);
    const index = this.t.append(hash);
    if (old) this.t.remove(old.index);
    this.members.set(subject, { index, leaf });
    return { index, leaf };
  }

  revoke(subject: string): void {
    const m = this.members.get(subject);
    if (!m) throw new Error(`${subject} is not a member`);
    this.t.remove(m.index);
    this.members.delete(subject);
  }

  member(subject: string): { index: number; leaf: Leaf } | undefined {
    return this.members.get(subject);
  }

  /** The live tree. Treat it as read-only. */
  tree(): GroupTree {
    return this.t;
  }

  /** The epoch the next root will be for. */
  nextEpoch(): string {
    const now = epochOf(this.clock.now(), this.period);
    const head = this.roots[this.roots.length - 1];
    if (head?.epoch !== now) return now;
    return epochOf(this.clock.now() + this.period * 1000, this.period);
  }

  /** Signs this epoch's root. Throws if this epoch already has one. */
  publish(ext?: Record<string, unknown>): { root: GroupRoot; snapshot: Uint8Array } {
    const epoch = epochOf(this.clock.now(), this.period);
    const head = this.roots[this.roots.length - 1];
    if (head && head.epoch === epoch) throw new Error(`epoch ${epoch} already has a root`);
    const snapshot = this.t.snapshot();
    const doc: GroupRoot = {
      id: `urn:uuid:${crypto.randomUUID()}`,
      type: ROOT_TYPE,
      v: 1,
      issuer: this.identity.did,
      group: this.groupId,
      groupId: fieldToHex(this.groupField),
      circuit: CIRCUIT_ID,
      period: this.period,
      epoch,
      seq: this.roots.length,
      prev: head ? rootDocHash(head) : null,
      root: fieldToHex(this.t.root()),
      length: this.t.length(),
      size: this.t.size(),
      snapshotHash: bytesToHex(sha256(snapshot)),
      issuedAt: this.clock.iso(),
      ...(ext ? { ext } : {}),
    };
    const root = signDocument(doc, this.identity, this.clock);
    this.roots.push(root);
    this.snapshots.set(epoch, snapshot);
    while (this.snapshots.size > this.keepSnapshots) this.snapshots.delete(this.snapshots.keys().next().value!);
    return { root, snapshot };
  }

  log(): GroupRoot[] {
    return [...this.roots];
  }

  snapshot(epoch: string): Uint8Array | undefined {
    return this.snapshots.get(epoch);
  }

  /**
   * Answers anon-membership/enroll. `admit` decides whether the sending DID may join: false refuses,
   * a Refusal refuses with its own code, true admits with a plain leaf, and leaf fields admit with those attributes.
   */
  serve(
    endpoint: Endpoint,
    admit: (did: string, request: EnrollRequest) => boolean | LeafFields | Refusal | Promise<boolean | LeafFields | Refusal>,
  ): void {
    endpoint.handle<EnrollRequest, EnrollResponse>(ENROLL, async (doc, { sender }) => {
      const req = doc.payload;
      if (!req || req.group !== this.groupId) return new Refusal("unknownGroup", `unknown group; this issuer runs ${this.groupId}`);
      let commitment: Field;
      try {
        commitment = fieldFromHex(req.commitment);
      } catch {
        return new Refusal("badRequest", "commitment is not a field");
      }
      const decision = await admit(sender, req);
      if (decision instanceof Refusal) return decision;
      if (decision === false) return new Refusal("notAdmitted", "not admitted to this group");
      const { index, leaf } = this.enroll(sender, commitment, decision === true ? undefined : decision);
      return { group: this.groupId, index, firstEpoch: this.nextEpoch(), leaf: encodeLeaf(leaf) };
    });
  }

  state(): GroupIssuerState {
    return {
      v: 1,
      name: this.name,
      depth: this.depth,
      period: this.period,
      leaves: this.t.leaves().map(fieldToHex),
      members: Object.fromEntries([...this.members].map(([did, m]) => [did, { index: m.index, leaf: encodeLeaf(m.leaf) }])),
      log: [...this.roots],
      snapshots: Object.fromEntries([...this.snapshots].map(([e, b]) => [e, toB64u(b)])),
    };
  }
}

/** Member side: sends the commitment for `groupId` and checks the leaf the issuer recorded. */
export async function enroll(
  endpoint: Endpoint,
  issuerDid: string,
  groupId: string,
  secret: Field,
  extra: { credential?: unknown; replace?: boolean } = {},
): Promise<Enrollment> {
  const commitment = commitmentOf(secret, groupFieldOf(groupId));
  const req: EnrollRequest = {
    group: groupId,
    commitment: fieldToHex(commitment),
    ...(extra.credential !== undefined ? { credential: extra.credential } : {}),
    ...(extra.replace ? { replace: true } : {}),
  };
  const res = await endpoint.request<EnrollRequest, EnrollResponse>(issuerDid, ENROLL, req);
  const p = res.payload;
  if (p.group !== groupId) throw new Error("the issuer answered for another group");
  const leaf = decodeLeaf(p.leaf);
  if (leaf.commitment !== commitment) throw new Error("the issuer recorded another commitment");
  if (!Number.isInteger(p.index) || p.index < 0) throw new Error("bad index");
  return { group: p.group, index: p.index, firstEpoch: p.firstEpoch, leaf };
}
