/**
 * A registrar: runs one group of credential holders (design §4.3, §8.1). The decision for the MVP is
 * issuer-run groups, so each demo issuer runs its own registrar with its own DID. The group itself is
 * anon-membership's GroupIssuer; this adds what Agora needs before a leaf is added: the credential
 * checks, one leaf per subject and per credential, rotation limits, status-list polling, and root
 * publishing at most once per cadence with added/removed counts and per-value attribute counts.
 */
import {
  GroupIssuer,
  dayOf,
  encodeLeaf,
  epochOf,
  fieldToHex,
  groupIdOf,
  type EnrollRequest,
  type GroupIssuerState,
  type GroupRoot,
  type LeafFields,
} from "@toip-tools/anon-membership";
import { Refusal, signDocument, verifyCredential, type Clock, type Credential, type Endpoint, type Identity } from "@toip-tools/trust-core";
import type { GroupDescriptor, GroupReceipt, SlotSpec } from "../protocol/documents";
import { leafFieldsFromCredential, schemaFieldOf } from "../protocol/gate";
import { GROUP_LEAVE, GROUP_RECEIPT } from "../protocol/specs";

export interface RegistrarConfig {
  /** The group's short name: the id is "<registrar DID>#<name>". */
  name: string;
  title: string;
  credentialLabel: string;
  credentialType: string;
  /** The credential issuer this group admits. For an issuer-run group, the registrar's own DID. */
  sourceIssuer: string;
  statusList: string;
  schemaId: string;
  slots: (SlotSpec | null)[];
  maxRotationsPerYear?: number;
  rootCadenceSeconds?: number;
}

interface MemberRecord {
  credentialId: string;
  values: Record<string, string>;
  /** Encoded slot values, hex, for counts. */
  encoded: Record<string, string>;
  status?: { list: string; index: number };
  validUntil?: string;
  /** Days on which the member rotated. */
  rotations: number[];
}

export interface RegistrarState {
  v: 1;
  group: GroupIssuerState;
  members: Record<string, MemberRecord>;
  added: number;
  removed: number;
}

/** Answers whether a credential's status bit is set. */
export type StatusCheck = (status: { list: string; index: number }) => Promise<boolean>;

export class Registrar {
  readonly identity: Identity;
  readonly groupId: string;
  readonly descriptor: GroupDescriptor;
  readonly group: GroupIssuer;
  private readonly clock: Clock;
  private readonly cfg: RegistrarConfig;
  private readonly members = new Map<string, MemberRecord>();
  private readonly byCredential = new Map<string, string>();
  private added = 0;
  private removed = 0;
  private readonly statusOf: StatusCheck;
  /** Called after any change, for persistence. */
  onChange?: () => void;
  /** Called with a line for the console. */
  log?: (line: string) => void;

  constructor(opts: { identity: Identity; clock: Clock; config: RegistrarConfig; statusOf: StatusCheck; state?: RegistrarState }) {
    this.identity = opts.identity;
    this.clock = opts.clock;
    this.cfg = opts.config;
    this.statusOf = opts.statusOf;
    const cadence = opts.config.rootCadenceSeconds ?? 3600;
    this.groupId = groupIdOf(opts.identity.did, opts.config.name);
    this.group = new GroupIssuer({ identity: opts.identity, clock: opts.clock, name: opts.config.name, period: cadence, state: opts.state?.group });
    if (opts.state) {
      for (const [did, m] of Object.entries(opts.state.members)) {
        this.members.set(did, m);
        this.byCredential.set(m.credentialId, did);
      }
      this.added = opts.state.added;
      this.removed = opts.state.removed;
    }
    this.descriptor = signDocument<GroupDescriptor>(
      {
        type: "agora/group",
        version: 1,
        id: this.groupId,
        issuer: opts.identity.did,
        issuedAt: new Date(0).toISOString(),
        title: opts.config.title,
        credentialLabel: opts.config.credentialLabel,
        source: { issuer: opts.config.sourceIssuer, credentialType: opts.config.credentialType, statusList: opts.config.statusList },
        schema: { id: opts.config.schemaId, schemaId: fieldToHex(schemaFieldOf(opts.config.schemaId)), slots: opts.config.slots },
        rotation: { maxPerYear: opts.config.maxRotationsPerYear ?? 2 },
        rootCadenceSeconds: cadence,
      },
      opts.identity,
      opts.clock,
    );
  }

  private today(): number {
    return dayOf(this.clock.now());
  }

  /**
   * The checks before a leaf is added (design §8.1 step 4). Returns the leaf's fields, or a Refusal.
   * `sender` is the TSP sender: it must be the credential's subject (holder binding).
   */
  async admit(sender: string, req: EnrollRequest): Promise<LeafFields | Refusal> {
    const vc = req.credential as Credential | undefined;
    if (!vc || typeof vc !== "object" || !vc.credentialSubject) return new Refusal("credentialMissing", "send the credential this group admits");
    const check = await verifyCredential(vc, this.clock);
    if (!check.ok) return new Refusal(check.failure === "expired" ? "credentialExpired" : "credentialInvalid", `the credential doesn't verify: ${check.failure}`);
    if (vc.issuer !== this.cfg.sourceIssuer) return new Refusal("wrongIssuer", `this group admits credentials from ${this.cfg.sourceIssuer}`);
    if (!vc.type?.includes(this.cfg.credentialType)) return new Refusal("wrongType", `this group admits ${this.cfg.credentialType} credentials`);
    if (vc.credentialSubject.id !== sender) return new Refusal("notSubject", "the credential was issued to another DID");
    const status = vc.credentialStatus ? { list: vc.credentialStatus.statusListCredential, index: vc.credentialStatus.statusListIndex } : undefined;
    if (status && (await this.statusOf(status))) return new Refusal("credentialRevoked", "the credential has been revoked");
    const existing = this.members.get(sender);
    const holder = this.byCredential.get(vc.id);
    if (holder && holder !== sender) return new Refusal("alreadyMember", "this credential already holds a leaf");
    if (existing && !req.replace) return new Refusal("alreadyMember", "you already have a leaf in this group; rotate it instead");
    if (!existing && req.replace) return new Refusal("notMember", "there is no leaf to replace");
    const today = this.today();
    const rotations = (existing?.rotations ?? []).filter((d) => d > today - 365);
    if (req.replace && rotations.length >= this.descriptor.rotation.maxPerYear) {
      return new Refusal("rotationLimit", `at most ${this.descriptor.rotation.maxPerYear} rotations a year`);
    }
    let made;
    try {
      made = leafFieldsFromCredential(this.descriptor, vc, today);
    } catch (e) {
      return new Refusal("credentialInvalid", (e as Error).message);
    }
    const encoded: Record<string, string> = {};
    this.descriptor.schema.slots.forEach((s, j) => s && (encoded[s.name] = fieldToHex(made.fields.attrs[j])));
    if (existing) this.byCredential.delete(existing.credentialId);
    this.members.set(sender, {
      credentialId: vc.id,
      values: made.values,
      encoded,
      status,
      validUntil: vc.validUntil,
      rotations: req.replace ? [...rotations, today] : rotations,
    });
    this.byCredential.set(vc.id, sender);
    if (!existing) this.added++;
    this.log?.(`${this.cfg.title}: ${req.replace ? "rotated" : "joined"} ${sender.slice(0, 24)}…`);
    queueMicrotask(() => this.onChange?.());
    return made.fields;
  }

  /** Adds a member directly, as joining over TSP would. For seeding a demo group. */
  async admitDirect(subject: string, vc: Credential, commitment: bigint): Promise<void> {
    const r = await this.admit(subject, { group: this.groupId, commitment: fieldToHex(commitment), credential: vc });
    if (r instanceof Refusal) throw new Error(`${r.code}: ${r.message}`);
    this.group.enroll(subject, commitment, r);
  }

  /** Answers anon-membership/enroll (join and rotate), agora/group/receipt and agora/group/leave. */
  serve(endpoint: Endpoint): void {
    this.group.serve(endpoint, (did, req) => this.admit(did, req));
    endpoint.handle<{ group: string }, GroupReceipt>(GROUP_RECEIPT, (doc, { sender }) => {
      if (doc.payload?.group !== this.groupId) return new Refusal("unknownGroup", `this registrar runs ${this.groupId}`);
      return this.receipt(sender) ?? new Refusal("notMember", "you have no leaf in this group");
    });
    endpoint.handle<{ group: string }, { removed: true }>(GROUP_LEAVE, (doc, { sender }) => {
      if (doc.payload?.group !== this.groupId) return new Refusal("unknownGroup", `this registrar runs ${this.groupId}`);
      if (!this.members.has(sender)) return new Refusal("notMember", "you have no leaf in this group");
      this.remove(sender);
      return { removed: true };
    });
  }

  /** The signed receipt for a member, sent only to them. */
  receipt(subject: string): GroupReceipt | null {
    const m = this.group.member(subject);
    const rec = this.members.get(subject);
    if (!m || !rec) return null;
    return signDocument<GroupReceipt>(
      { type: "agora/group-receipt", issuer: this.identity.did, issuedAt: this.clock.iso(), group: this.groupId, subject, index: m.index, leaf: encodeLeaf(m.leaf), values: rec.values },
      this.identity,
      this.clock,
    );
  }

  isMember(subject: string): boolean {
    return !!this.group.member(subject);
  }

  private remove(subject: string): void {
    const rec = this.members.get(subject);
    if (this.group.member(subject)) this.group.revoke(subject);
    if (rec) this.byCredential.delete(rec.credentialId);
    this.members.delete(subject);
    this.removed++;
    this.onChange?.();
  }

  /** Removes members whose credential was revoked or has expired. Returns how many. */
  async pollStatus(): Promise<number> {
    let n = 0;
    for (const [did, m] of [...this.members]) {
      const expired = m.validUntil && Date.parse(m.validUntil) <= this.clock.now();
      if (expired || (m.status && (await this.statusOf(m.status)))) {
        this.remove(did);
        this.log?.(`${this.cfg.title}: removed ${did.slice(0, 24)}… (${expired ? "expired" : "revoked"})`);
        n++;
      }
    }
    return n;
  }

  /** Per-value counts for the slots marked publishCounts. */
  counts(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const s of this.descriptor.schema.slots) if (s?.publishCounts) out[s.name] = {};
    for (const m of this.members.values())
      for (const name of Object.keys(out)) {
        const v = m.encoded[name];
        if (v) out[name][v] = (out[name][v] ?? 0) + 1;
      }
    return out;
  }

  /**
   * Publishes a root if the tree changed and this cadence period has none yet. Changes are batched
   * until the next period. Returns the new root, or null.
   */
  tick(): GroupRoot | null {
    const log = this.group.log();
    const head = log[log.length - 1];
    const root = fieldToHex(this.group.tree().root());
    if (head && head.root === root) return null;
    if (!head && this.group.tree().size() === 0) return null;
    if (head && head.epoch === epochOf(this.clock.now(), this.group.period)) return null;
    const { root: doc } = this.group.publish({ added: this.added, removed: this.removed, counts: this.counts() });
    this.added = 0;
    this.removed = 0;
    this.log?.(`${this.cfg.title}: root ${doc.seq} published, ${doc.size} members (+${(doc.ext as { added: number }).added} −${(doc.ext as { removed: number }).removed})`);
    this.onChange?.();
    return doc;
  }

  roots(): GroupRoot[] {
    return this.group.log();
  }

  /** The snapshot of the latest root, or of a given epoch. */
  snapshot(epoch?: string): Uint8Array | undefined {
    const log = this.group.log();
    return this.group.snapshot(epoch ?? log[log.length - 1]?.epoch ?? "");
  }

  size(): number {
    return this.group.tree().size();
  }

  state(): RegistrarState {
    return { v: 1, group: this.group.state(), members: Object.fromEntries(this.members), added: this.added, removed: this.removed };
  }
}
