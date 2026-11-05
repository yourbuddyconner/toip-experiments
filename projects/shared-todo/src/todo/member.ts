import {
  Endpoint,
  KnowledgeLog,
  Refusal,
  StatusList,
  TaskError,
  checkStatus,
  fromB64u,
  identityFromSeed,
  issueCredential,
  openItem,
  resealText,
  resolveDidKey,
  sealItem,
  seedFrom,
  toB64u,
  verifyCredential,
  type Bus,
  type Credential,
  type DemoClock,
  type Identity,
  type Policies,
  type SealedText,
  type StatusListDoc,
} from "@zk-toip/trust-core";
import { authorize, checkOp, type Role } from "./checks";
import { ListState } from "./list";
import { signOp, tamperOp, type Op, type OpKind } from "./ops";
import { ACK, COLLECT, DEPOSIT, JOIN, OP, STATUS, SYNC } from "./specs";

export interface Invitation {
  inviter: string;
  list: string;
  listName: string;
  code: string;
  role: Role;
}

export interface MemberInfo {
  name: string;
  role: Role;
  membership: Credential;
  acknowledged?: boolean;
}

export interface Rejection {
  at: string;
  opId: string;
  author: string;
  via?: string;
  reason: string;
  summary: string;
}

interface OpMessage {
  op: Op;
  membership?: Credential;
  forwarded?: boolean;
}

interface JoinReply {
  listName: string;
  membership: Credential;
  members: { did: string; name: string; role: Role; membership: Credential }[];
  ops: OpMessage[];
  status: StatusListDoc;
}

interface StatusMessage {
  status: StatusListDoc;
  members?: { did: string; name: string; role: Role; membership: Credential }[];
}

const FRESHNESS = { skewMs: 60_000, maxAgeMs: 7 * 24 * 3600_000 };
const shortId = () => toB64u(crypto.getRandomValues(new Uint8Array(6)));

/** One person's device: their keys, their copy of the list, and every decision about what to accept. */
export class MemberAgent {
  readonly name: string;
  readonly did: string;
  readonly identity: Identity;
  readonly knowledge: KnowledgeLog;
  readonly endpoint: Endpoint;
  list?: { did: string; name: string };
  role?: Role;
  membership?: Credential;
  acknowledgement?: Credential;
  state = new ListState();
  rejected: Rejection[] = [];
  members = new Map<string, MemberInfo>();
  status?: StatusListDoc;
  lastError: string | null = null;
  sendAnyway = false;
  online = true;

  private readonly bus: Bus;
  private readonly clock: DemoClock;
  private readonly policies: Policies;
  private readonly relayDid: string;
  private readonly listeners = new Set<() => void>();
  private readonly itemKeys = new Map<string, { key: Uint8Array; sealed: SealedText }>();
  // Admin only: the list's own key, its revocation list, and open invitations.
  private listIdentity?: Identity;
  private statusList?: StatusList;
  private readonly invites = new Map<string, Role>();

  constructor(opts: { name: string; bus: Bus; clock: DemoClock; policies: Policies; relayDid: string }) {
    this.name = opts.name;
    this.bus = opts.bus;
    this.clock = opts.clock;
    this.policies = opts.policies;
    this.relayDid = opts.relayDid;
    this.identity = identityFromSeed(seedFrom(`shared-todo/${opts.name.toLowerCase()}`));
    this.did = this.identity.did;
    this.knowledge = new KnowledgeLog(opts.clock);
    this.endpoint = new Endpoint({ identity: this.identity, bus: opts.bus, clock: opts.clock, freshness: FRESHNESS });
    this.endpoint.handle<{ code: string; displayName: string; list: string }, JoinReply>(JOIN, (doc, ctx) => this.onJoin(doc.payload, ctx.sender));
    this.endpoint.handle<{ acknowledgement: Credential }, void>(ACK, (doc, ctx) => this.onAck(doc.payload.acknowledgement, ctx.sender));
    this.endpoint.handle<OpMessage, void>(OP, (doc, ctx) => this.onOp(doc.payload, ctx.sender));
    this.endpoint.handle<StatusMessage, void>(STATUS, (doc) => this.onStatus(doc.payload));
    this.endpoint.handle<Record<string, never>, { ops: OpMessage[] }>(SYNC, (_doc, ctx) => this.onSync(ctx.sender));
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ---------------------------------------------------------------- admin

  /** Makes a new list whose key this device holds, with this person as its admin (design 4.1). */
  createList(name: string): void {
    this.listIdentity = identityFromSeed(seedFrom("shared-todo/list"));
    this.statusList = new StatusList();
    this.list = { did: this.listIdentity.did, name };
    this.membership = this.issueMembership(this.did, "admin");
    this.role = "admin";
    this.members.set(this.did, { name: this.name, role: "admin", membership: this.membership, acknowledged: true });
    this.status = this.statusList.sign(this.listIdentity, this.clock);
    this.changed();
  }

  invite(role: Role): Invitation {
    if (!this.list || !this.listIdentity) throw new Error("only the list's admin can invite");
    const code = shortId();
    this.invites.set(code, role);
    this.changed();
    return { inviter: this.did, list: this.list.did, listName: this.list.name, code, role };
  }

  async revoke(memberDid: string): Promise<void> {
    await this.act(async () => {
      if (!this.listIdentity || !this.statusList || !this.list) throw new Refusal("permissionDenied", "only the list's admin can revoke");
      const d = authorize(this.policies, { role: this.role!, kind: "revoke", isItemAuthor: false, itemPrivate: false, isReader: false });
      if (!d.allow) throw new Refusal("permissionDenied", d.reasons[0]);
      const m = this.members.get(memberDid);
      if (!m) throw new Refusal("malformedRequest", "not a member");
      this.statusList.revoke(m.membership.credentialStatus!.statusListIndex);
      this.status = this.statusList.sign(this.listIdentity, this.clock);
      const msg: StatusMessage = { status: this.status };
      for (const did of this.members.keys()) if (did !== this.did) await this.sendTo(did, STATUS, msg);
    });
  }

  private issueMembership(subject: string, role: Role): Credential {
    return issueCredential(this.listIdentity!, this.clock, {
      type: ["VerifiableCredential", "TodoListMembership"],
      credentialSubject: { id: subject, list: this.listIdentity!.did, role },
      credentialStatus: {
        type: "BitstringStatusListEntry",
        statusListIndex: this.statusList!.allocate(),
        statusListCredential: `${this.listIdentity!.did}#status`,
      },
    });
  }

  private async onJoin(p: { code: string; displayName: string; list: string }, sender: string): Promise<JoinReply | Refusal> {
    const role = this.invites.get(p.code);
    if (!this.listIdentity || !this.list || p.list !== this.list.did || !role) return new Refusal("permissionDenied", "invitation is not valid");
    this.invites.delete(p.code);
    const membership = this.issueMembership(sender, role);
    this.members.set(sender, { name: p.displayName, role, membership });
    this.knowledge.add({ about: sender, what: "name", value: p.displayName, how: "join request" });
    this.knowledge.add({ about: sender, what: "role", value: role, how: "invitation I issued" });
    this.changed();
    const roster = this.roster();
    // Tell everyone else about the newcomer once the reply has gone out.
    queueMicrotask(() => {
      void (async () => {
        for (const did of this.members.keys()) {
          if (did !== this.did && did !== sender) await this.sendTo(did, STATUS, { status: this.status!, members: roster });
        }
      })();
    });
    return { listName: this.list.name, membership, members: roster, ops: this.opMessages(), status: this.status! };
  }

  private async onAck(ack: Credential, sender: string): Promise<void> {
    const m = this.members.get(sender);
    if (!m || ack.issuer !== sender || ack.credentialSubject.id !== this.list?.did) return;
    if (!(await verifyCredential(ack, this.clock)).ok) return;
    m.acknowledged = true;
    this.changed();
  }

  private roster() {
    return [...this.members].map(([did, m]) => ({ did, name: m.name, role: m.role, membership: m.membership }));
  }

  // ---------------------------------------------------------------- joining

  /** Scans an invitation: asks to join, then signs an acknowledgement back (design 3, step 3). */
  async scan(inv: Invitation): Promise<void> {
    await this.act(async () => {
      const res = await this.endpoint.request<{ code: string; displayName: string; list: string }, JoinReply>(inv.inviter, JOIN, {
        code: inv.code,
        displayName: this.name,
        list: inv.list,
      });
      const r = res.payload;
      const ok = await verifyCredential(r.membership, this.clock);
      if (!ok.ok || r.membership.issuer !== inv.list || r.membership.credentialSubject.id !== this.did) {
        throw new Refusal("proofInvalid", "membership from the inviter does not verify");
      }
      const st = await checkStatus(r.status, 0, inv.list, this.clock);
      if (!st.signatureValid) throw new Refusal("proofInvalid", "revocation list does not verify");
      this.list = { did: inv.list, name: r.listName };
      this.membership = r.membership;
      this.role = r.membership.credentialSubject.role as Role;
      this.status = r.status;
      await this.mergeMembers(r.members);
      for (const m of r.members) this.knowledge.add({ about: m.did, what: "name", value: m.name, how: "join reply" });
      for (const msg of r.ops) await this.receiveOp(msg, undefined, inv.inviter);
      this.acknowledgement = issueCredential(this.identity, this.clock, {
        type: ["VerifiableCredential", "TodoListMembershipAcknowledgement"],
        credentialSubject: { id: inv.list, member: this.did, role: this.role },
      });
      await this.endpoint.notify(inv.inviter, ACK, { acknowledgement: this.acknowledgement });
    });
  }

  private async mergeMembers(list: { did: string; name: string; role: Role; membership: Credential }[]): Promise<void> {
    for (const m of list) {
      if (!this.list) return;
      const v = await verifyCredential(m.membership, this.clock);
      if (!v.ok || m.membership.issuer !== this.list.did || m.membership.credentialSubject.id !== m.did) continue;
      const prior = this.members.get(m.did);
      this.members.set(m.did, { name: m.name, role: m.membership.credentialSubject.role as Role, membership: m.membership, acknowledged: prior?.acknowledged });
    }
  }

  // ---------------------------------------------------------------- editing

  async add(text: string, readers?: string[]): Promise<string> {
    const itemId = shortId();
    await this.act(async () => {
      if (readers) {
        const all = [...new Set([this.did, ...readers])];
        const { key, sealed } = await sealItem(
          text,
          all.map((did) => ({ did, encryptionPublic: resolveDidKey(did).encryptionKey })),
        );
        this.itemKeys.set(itemId, { key, sealed });
        await this.change({ kind: "add", itemId, sealed, readers: all }, text);
      } else {
        await this.change({ kind: "add", itemId, text }, text);
      }
    });
    return itemId;
  }

  check(itemId: string): Promise<void> {
    return this.act(() => this.change({ kind: "check", itemId }));
  }

  uncheck(itemId: string): Promise<void> {
    return this.act(() => this.change({ kind: "uncheck", itemId }));
  }

  remove(itemId: string): Promise<void> {
    return this.act(() => this.change({ kind: "delete", itemId }));
  }

  edit(itemId: string, text: string): Promise<void> {
    return this.act(async () => {
      const k = this.itemKeys.get(itemId);
      if (this.state.item(itemId)?.readers) {
        if (!k) throw new Refusal("permissionDenied", "not a reader of this item");
        const sealed = resealText(text, k.key, k.sealed);
        this.itemKeys.set(itemId, { key: k.key, sealed });
        await this.change({ kind: "edit", itemId, sealed }, text);
      } else {
        await this.change({ kind: "edit", itemId, text }, text);
      }
    });
  }

  /**
   * Signs an op, checks it as any peer would, applies it here, and sends it to every other member.
   * A failing check stops it here, unless `sendAnyway` is on (the demo's modified app).
   */
  private async change(body: { kind: OpKind; itemId: string; text?: string; sealed?: SealedText; readers?: string[] }, readable?: string): Promise<void> {
    if (!this.list || !this.membership) throw new Refusal("permissionDenied", "not a member");
    const op = signOp(this.identity, this.clock, { list: this.list.did, membershipId: this.membership.id, ...body });
    const verdict = await this.check_(op, this.membership, this.did);
    if (verdict.ok) this.state.apply(op, readable);
    else if (!this.sendAnyway) throw new Refusal("permissionDenied", verdict.reason);
    for (const [did, m] of this.members) {
      if (did === this.did || (await this.isRevoked(m.membership))) continue;
      await this.sendTo(did, OP, { op, membership: this.membership } satisfies OpMessage);
    }
    if (!verdict.ok) this.lastError = `sent anyway: ${verdict.reason}`;
  }

  // ---------------------------------------------------------------- receiving

  private async onOp(msg: OpMessage, sender: string): Promise<void> {
    await this.receiveOp(msg, msg.forwarded ? undefined : sender, msg.forwarded ? sender : undefined);
  }

  /** Design 4.5. `directSender` is the authenticated TSP sender when the op came straight from its author. */
  private async receiveOp(msg: OpMessage, directSender: string | undefined, via: string | undefined): Promise<void> {
    const { op } = msg;
    const membership = msg.membership ?? this.members.get(op?.issuer)?.membership;
    const verdict = await this.check_(op, membership, directSender);
    if (!verdict.ok) {
      this.rejected.push({
        at: this.clock.iso(),
        opId: op?.id,
        author: op?.issuer,
        ...(via ? { via } : {}),
        reason: verdict.reason,
        summary: summarize(op),
      });
      this.changed();
      return;
    }
    if (verdict.duplicate) return;
    let readable: string | undefined;
    if (op.sealed) {
      const opened = await openItem(op.sealed, this.identity);
      if (opened) {
        readable = opened.text;
        this.itemKeys.set(op.itemId, { key: opened.key, sealed: op.sealed });
      }
    }
    this.state.apply(op, readable);
    if (membership && !this.members.has(op.issuer)) {
      this.members.set(op.issuer, { name: shortDid(op.issuer), role: membership.credentialSubject.role as Role, membership });
    }
    this.changed();
  }

  private check_(op: Op, membership: Credential | undefined, directSender: string | undefined) {
    if (!this.list || !this.status) return Promise.resolve({ ok: false as const, reason: "not a member" });
    return checkOp({ op, membership, directSender, listDid: this.list.did, status: this.status, state: this.state, policies: this.policies, clock: this.clock });
  }

  private async onStatus(msg: StatusMessage): Promise<void> {
    if (!this.list) return;
    const st = await checkStatus(msg.status, 0, this.list.did, this.clock);
    if (!st.signatureValid) return;
    if (!this.status || msg.status.issuedAt >= this.status.issuedAt) this.status = msg.status;
    if (msg.members) await this.mergeMembers(msg.members);
    this.changed();
  }

  private async onSync(sender: string): Promise<{ ops: OpMessage[] } | Refusal> {
    const m = this.members.get(sender);
    if (!m || (await this.isRevoked(m.membership))) return new Refusal("permissionDenied", "not a member");
    return { ops: this.opMessages() };
  }

  private opMessages(): OpMessage[] {
    return this.state.allOps().map((op) => ({ op, membership: this.members.get(op.issuer)?.membership }));
  }

  async isRevoked(membership: Credential): Promise<boolean> {
    if (!this.status || !this.list) return false;
    const index = membership.credentialStatus?.statusListIndex;
    if (index === undefined) return true;
    return (await checkStatus(this.status, index, this.list.did, this.clock)).revoked;
  }

  // ---------------------------------------------------------------- connectivity

  /** Going offline stops delivery. Coming back collects whatever the relay holds for this device. */
  async setOnline(on: boolean): Promise<void> {
    this.online = on;
    this.bus.setOnline(this.did, on);
    this.changed();
    if (!on) return;
    await this.act(async () => {
      const res = await this.endpoint.request<Record<string, never>, { wires: string[] }>(this.relayDid, COLLECT, {});
      for (const w of res.payload.wires) await this.endpoint.ingest(fromB64u(w));
    });
  }

  /** Asks another member for every op it has accepted, and checks each one as forwarded. */
  async syncFrom(memberDid: string): Promise<void> {
    await this.act(async () => {
      const res = await this.endpoint.request<Record<string, never>, { ops: OpMessage[] }>(memberDid, SYNC, {});
      for (const msg of res.payload.ops) await this.receiveOp(msg, undefined, memberDid);
    });
  }

  /** Sends directly, or leaves the sealed message at the relay when `to` is offline (design 4.4a). */
  private async sendTo(to: string, spec: typeof OP, payload: unknown): Promise<void> {
    if ((await this.endpoint.notify(to, spec, payload)) === "delivered") return;
    const wire = await this.endpoint.seal(to, spec, payload);
    try {
      await this.endpoint.request(this.relayDid, DEPOSIT, { to, wire: toB64u(wire) });
    } catch (e) {
      this.lastError = `${this.nameOf(to)} is offline and the relay is unreachable`;
      this.changed();
      void e;
    }
  }

  // ---------------------------------------------------------------- free play

  /** Forwards a copy of a held op with its text changed, as an ex-member might. */
  async forwardTampered(opId: string, text: string, to: string): Promise<void> {
    await this.act(async () => {
      const op = this.state.seen(opId);
      if (!op) throw new Refusal("malformedRequest", "no such operation");
      const membership = this.members.get(op.issuer)?.membership;
      await this.endpoint.notify(to, OP, { op: tamperOp(op, text), membership, forwarded: true } satisfies OpMessage);
    });
  }

  /** Mallory's attempt: an op signed by her own key, carrying someone else's membership. */
  async sneakIn(p: { list: string; targets: string[]; membership: Credential; text: string }): Promise<void> {
    await this.act(async () => {
      const op = signOp(this.identity, this.clock, { list: p.list, kind: "add", itemId: shortId(), text: p.text, membershipId: p.membership.id });
      for (const t of p.targets) await this.endpoint.notify(t, OP, { op, membership: p.membership } satisfies OpMessage);
    });
  }

  // ---------------------------------------------------------------- view

  nameOf(did: string): string {
    if (did === this.did) return this.name;
    return this.members.get(did)?.name ?? shortDid(did);
  }

  /** Everything this device holds, for the UI and the disclosure tests. Never includes key material. */
  snapshot() {
    return {
      name: this.name,
      did: this.did,
      online: this.online,
      list: this.list,
      role: this.role,
      membership: this.membership,
      acknowledgement: this.acknowledgement,
      items: this.state.items(),
      ops: this.state.allOps(),
      rejected: this.rejected,
      members: [...this.members].map(([did, m]) => ({ did, ...m })),
      status: this.status,
      lastError: this.lastError,
      invites: [...this.invites.keys()],
    };
  }

  private async act(fn: () => Promise<void>): Promise<void> {
    this.lastError = null;
    try {
      await fn();
    } catch (e) {
      this.lastError = e instanceof Refusal || e instanceof TaskError || e instanceof Error ? e.message : String(e);
    } finally {
      this.changed();
    }
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }
}

export function shortDid(did: string): string {
  return `${did.slice(0, 12)}…${did.slice(-4)}`;
}

function summarize(op: Op | undefined): string {
  if (!op) return "(unreadable)";
  const text = op.text !== undefined ? ` "${op.text}"` : op.sealed ? " 🔒" : "";
  return `${op.kind}${text}`;
}
