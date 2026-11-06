/**
 * One person's device (design v2): their keys, their lists, and every decision about what to accept.
 * Everything it knows is in its Store; everything it says goes out as sealed TSP through the relay.
 */
import type { TrustTaskDocument } from "@openvtc/trust-tasks/runtime";
import {
  Endpoint,
  RelayTransport,
  fromB64u,
  identityFromSeed,
  issueCredential,
  openItem,
  resealText,
  resolveDidKey,
  sealItem,
  toB64u,
  verifyCredential,
  type Clock,
  type Credential,
  type Identity,
  type OutboxItem,
  type Policies,
  type RelayStatus,
  type SealedText,
  type Traffic,
} from "@zk-toip/trust-core";
import { authorize, checkOp, type CheckResult, type Role } from "./checks";
import { ListModel, type Item } from "./model";
import { opKey, signOp, tamperOp, type Op, type OpKind } from "./ops";
import { acceptRoster, currentMembers, rosterMember, signRoster, type RosterDoc, type RosterMember } from "./roster";
import { ACK, JOIN, JOIN_REFUSED, LEAVE, OP, ROSTER, SPEC_NAMES, SYNC, SYNC_REQUEST, WELCOME } from "./specs";
import type { Store } from "./store";

export const INVITATION_TTL_MS = 7 * 24 * 3600_000;
const FRESHNESS = { skewMs: 5 * 60_000, maxAgeMs: 31 * 24 * 3600_000 };
const INSPECTOR_LIMIT = 500;

export interface Invitation {
  v: 1;
  relay: string;
  inviter: string;
  inviterName: string;
  list: string;
  listName: string;
  code: string;
  role: Role;
}

export interface OpMessage {
  op: Op;
  membership?: Credential;
}

export interface Refusal {
  at: string;
  opId: string;
  author: string;
  authorName: string;
  via?: string;
  viaName?: string;
  reason: string;
  summary: string;
}

export type InspectorEntry =
  | { kind: "traffic"; at: string; direction: "in" | "out"; peer: string; peerName: string; type: string; bytes: number; delivery?: string; payload: unknown }
  | { kind: "check"; at: string; list: string; author: string; authorName: string; via?: string; summary: string; result: string };

interface IssuedInvite {
  code: string;
  role: Role;
  expiresAt: string;
  usedBy?: string;
}

interface ListRecord {
  did: string;
  name: string;
  role?: Role;
  membership?: Credential;
  acknowledgement?: Credential;
  roster?: RosterDoc;
  ops: Op[];
  memberships: Record<string, Credential>;
  held: { msg: OpMessage; directSender?: string; via?: string }[];
  refused: Refusal[];
  acks: Record<string, true>;
  pending?: { inviter: string; inviterName: string; code: string; role: Role; requestedAt: string; refused?: string };
  admin?: { seed: string; invites: IssuedInvite[] };
  left?: boolean;
}

interface ProfileRecord {
  seed: string;
  name: string;
  createdAt: string;
}

export interface ListView {
  did: string;
  name: string;
  role?: Role;
  removed: boolean;
  isAdmin: boolean;
  membership?: Credential;
  acknowledgement?: Credential;
  roster?: RosterDoc;
  rosterVersion: number;
  items: (Item & { authorName: string; readerNames?: string[] })[];
  members: { did: string; name: string; role: Role; removed: boolean; acknowledged?: boolean; isMe: boolean }[];
  refused: Refusal[];
  pending?: ListRecord["pending"];
  openInvites: { code: string; role: Role; expiresAt: string }[];
}

export interface DeviceOptions {
  store: Store;
  relayUrl: string;
  policies: Policies;
  clock: Clock;
  /** Required the first time, to create this device's identity. */
  name?: string;
}

const randomSeed = () => crypto.getRandomValues(new Uint8Array(32));
const shortCode = () => toB64u(crypto.getRandomValues(new Uint8Array(12)));
const summarize = (op: Partial<Op> | undefined): string => {
  if (!op || typeof op !== "object") return "(unreadable change)";
  const text = typeof op.text === "string" ? ` "${op.text}"` : op.sealed ? " (private)" : "";
  return `${op.kind ?? "change"}${text}`;
};

export class Device {
  readonly did: string;
  readonly name: string;
  private readonly identity: Identity;
  private readonly endpoint: Endpoint;
  private readonly transport: RelayTransport;
  private readonly lists_ = new Map<string, ListRecord>();
  private readonly models = new Map<string, ListModel>();
  private readonly listKeys = new Map<string, Identity>();
  private readonly itemKeys = new Map<string, { key: Uint8Array; sealed: SealedText }>();
  private readonly listeners = new Set<() => void>();
  private inspectorLog: InspectorEntry[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private syncTurn = 0;

  private constructor(
    private readonly opts: DeviceOptions,
    profile: ProfileRecord,
  ) {
    this.identity = identityFromSeed(fromB64u(profile.seed));
    this.did = this.identity.did;
    this.name = profile.name;
    const store = opts.store;
    this.transport = new RelayTransport({
      url: opts.relayUrl,
      identity: this.identity,
      outbox: {
        load: async () => (await store.get<OutboxItem[]>("outbox")) ?? [],
        save: (items) => store.put("outbox", items),
      },
    });
    this.endpoint = new Endpoint({
      identity: this.identity,
      transport: this.transport,
      clock: opts.clock,
      freshness: FRESHNESS,
      onTraffic: (t) => this.logTraffic(t),
    });
    const on = <P>(spec: Parameters<Endpoint["handle"]>[0], fn: (p: P, sender: string) => Promise<void>) =>
      this.endpoint.handle<P, void>(spec, (doc: TrustTaskDocument<P>, ctx) => this.serial(() => fn(doc.payload, ctx.sender)));
    on(JOIN, (p: { code: string; list: string; name: string }, s) => this.onJoin(p, s));
    on(WELCOME, (p: { listName: string; membership: Credential; roster: RosterDoc; ops: OpMessage[] }, s) => this.onWelcome(p, s));
    on(JOIN_REFUSED, (p: { list: string; reason: string }, s) => this.onJoinRefused(p, s));
    on(ACK, (p: { acknowledgement: Credential }, s) => this.onAck(p, s));
    on(OP, (p: OpMessage, s) => this.onOp(p, s));
    on(ROSTER, (p: { roster: RosterDoc }, s) => this.onRoster(p, s));
    on(SYNC_REQUEST, (p: { list: string }, s) => this.onSyncRequest(p, s));
    on(SYNC, (p: { list: string; roster: RosterDoc; ops: OpMessage[] }, s) => this.onSync(p, s));
    on(LEAVE, (p: { list: string }, s) => this.onLeave(p, s));
    this.transport.onStatus((status) => {
      this.changed();
      if (status === "connected") void this.syncNow();
    });
  }

  /** Opens this device from its store, creating its identity on first run. Returns null if it has none and no name was given. */
  static async open(opts: DeviceOptions): Promise<Device | null> {
    let profile = await opts.store.get<ProfileRecord>("profile");
    if (!profile) {
      if (!opts.name?.trim()) return null;
      profile = { seed: toB64u(randomSeed()), name: opts.name.trim(), createdAt: opts.clock.iso() };
      await opts.store.put("profile", profile);
    }
    const d = new Device(opts, profile);
    await d.load();
    d.transport.start();
    return d;
  }

  async close(): Promise<void> {
    await this.queue.catch(() => {});
    this.transport.stop();
    this.endpoint.close();
  }

  // ------------------------------------------------------------------ status

  connection(): RelayStatus {
    return this.transport.status;
  }

  pendingSends(): number {
    return this.transport.pending();
  }

  goOffline(): void {
    this.transport.stop();
  }

  goOnline(): void {
    this.transport.start();
  }

  get relayUrl(): string {
    return this.opts.relayUrl;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  inspector(): readonly InspectorEntry[] {
    return this.inspectorLog;
  }

  // ------------------------------------------------------------------ reading

  lists(): { did: string; name: string; role?: Role; pending: boolean; removed: boolean; open: number }[] {
    return [...this.lists_.values()]
      .filter((r) => !r.left)
      .map((r) => ({
        did: r.did,
        name: r.name,
        role: r.role,
        pending: !!r.pending,
        removed: this.amRemoved(r),
        open: this.models.get(r.did)?.items().filter((i) => !i.checked).length ?? 0,
      }));
  }

  view(listDid: string): ListView | undefined {
    const r = this.lists_.get(listDid);
    if (!r) return undefined;
    const model = this.model(listDid);
    const members = (r.roster?.members ?? []).map((m) => ({
      did: m.did,
      name: m.name,
      role: m.role,
      removed: !!m.removedAt,
      acknowledged: r.admin ? (r.acks[m.did] ?? m.did === this.did) : undefined,
      isMe: m.did === this.did,
    }));
    return {
      did: r.did,
      name: r.roster?.name ?? r.name,
      role: r.role,
      removed: this.amRemoved(r),
      isAdmin: !!r.admin && r.role === "admin",
      membership: r.membership,
      acknowledgement: r.acknowledgement,
      roster: r.roster,
      rosterVersion: r.roster?.version ?? 0,
      items: model.items().map((i) => ({ ...i, authorName: this.nameIn(r, i.author), readerNames: i.readers?.map((d) => this.nameIn(r, d)) })),
      members,
      refused: r.refused,
      pending: r.pending,
      openInvites: (r.admin?.invites ?? [])
        .filter((i) => !i.usedBy && Date.parse(i.expiresAt) > this.opts.clock.now())
        .map(({ code, role, expiresAt }) => ({ code, role, expiresAt })),
    };
  }

  nameOf(did: string): string {
    if (did === this.did) return this.name;
    for (const r of this.lists_.values()) {
      const m = rosterMember(r.roster, did);
      if (m) return m.name;
    }
    return `an unknown key (${did.slice(8, 16)}…)`;
  }

  // ------------------------------------------------------------------ lists and membership

  createList(name: string): Promise<string> {
    return this.serial(async () => {
      const seed = randomSeed();
      const list = identityFromSeed(seed);
      this.listKeys.set(list.did, list);
      const r: ListRecord = { did: list.did, name, ops: [], memberships: {}, held: [], refused: [], acks: {}, admin: { seed: toB64u(seed), invites: [] } };
      r.membership = this.issueMembership(list, this.did, "admin");
      r.role = "admin";
      r.memberships[this.did] = r.membership;
      r.roster = signRoster(list, this.opts.clock, {
        name,
        version: 1,
        members: [{ did: this.did, name: this.name, role: "admin", membershipId: r.membership.id, joinedAt: this.opts.clock.iso() }],
      });
      this.lists_.set(list.did, r);
      this.models.set(list.did, new ListModel());
      await this.save(r);
      return list.did;
    });
  }

  /** An invitation as text to put in a link: the base64url JSON of an Invitation. */
  invite(listDid: string, role: Role): string {
    const r = this.requireList(listDid);
    if (!r.admin || r.role !== "admin") throw new Error("Only this list's admin can invite people.");
    const d = authorize(this.opts.policies, { role: r.role, kind: "invite", isItemAuthor: false, itemPrivate: false, isReader: false });
    if (!d.allow) throw new Error(d.reasons[0]);
    const code = shortCode();
    r.admin.invites.push({ code, role, expiresAt: new Date(this.opts.clock.now() + INVITATION_TTL_MS).toISOString() });
    void this.save(r);
    this.changed();
    const inv: Invitation = { v: 1, relay: this.opts.relayUrl, inviter: this.did, inviterName: this.name, list: listDid, listName: r.roster?.name ?? r.name, code, role };
    return toB64u(new TextEncoder().encode(JSON.stringify(inv)));
  }

  static decodeInvitation(text: string): Invitation {
    const token = text.includes("invite=") ? text.slice(text.indexOf("invite=") + 7).split("&")[0] : text.trim();
    let inv: Invitation;
    try {
      inv = JSON.parse(new TextDecoder().decode(fromB64u(token)));
    } catch {
      throw new Error("That isn't an invitation link.");
    }
    if (inv?.v !== 1 || typeof inv.inviter !== "string" || typeof inv.list !== "string" || typeof inv.code !== "string") {
      throw new Error("That isn't an invitation link.");
    }
    return inv;
  }

  join(invitationText: string): Promise<void> {
    return this.serial(async () => {
      const inv = Device.decodeInvitation(invitationText);
      if (inv.relay !== this.opts.relayUrl) throw new Error(`This list uses another relay (${inv.relay}).`);
      if (inv.inviter === this.did) throw new Error("This is your own invitation.");
      const existing = this.lists_.get(inv.list);
      if (existing && !existing.left && !existing.pending && !this.amRemoved(existing)) throw new Error("You're already in this list.");
      const r: ListRecord = existing && !existing.left ? existing : { did: inv.list, name: inv.listName, ops: [], memberships: {}, held: [], refused: [], acks: {} };
      r.left = false;
      r.pending = { inviter: inv.inviter, inviterName: inv.inviterName, code: inv.code, role: inv.role, requestedAt: this.opts.clock.iso() };
      this.lists_.set(r.did, r);
      if (!this.models.has(r.did)) this.models.set(r.did, new ListModel());
      await this.save(r);
      await this.endpoint.notify(inv.inviter, JOIN, { code: inv.code, list: inv.list, name: this.name });
    });
  }

  removeMember(listDid: string, memberDid: string): Promise<void> {
    return this.serial(async () => {
      const r = this.requireList(listDid);
      const list = this.listKeys.get(listDid);
      if (!r.admin || !list || r.role !== "admin") throw new Error("Only this list's admin can remove people.");
      const d = authorize(this.opts.policies, { role: r.role, kind: "revoke", isItemAuthor: false, itemPrivate: false, isReader: false });
      if (!d.allow) throw new Error(d.reasons[0]);
      if (memberDid === this.did) throw new Error("You can't remove yourself as admin.");
      await this.removeFromRoster(r, list, memberDid);
    });
  }

  leave(listDid: string): Promise<void> {
    return this.serial(async () => {
      const r = this.requireList(listDid);
      if (r.admin && r.role === "admin") throw new Error("You're this list's admin, so you can't leave it.");
      const admins = currentMembers(r.roster).filter((m) => m.role === "admin");
      if (!this.amRemoved(r)) for (const a of admins) await this.endpoint.notify(a.did, LEAVE, { list: listDid });
      r.left = true;
      await this.save(r);
    });
  }

  // ------------------------------------------------------------------ items

  add(listDid: string, text: string, readers?: string[], opts: { sendAnyway?: boolean } = {}): Promise<string> {
    return this.serial(async () => {
      const itemId = shortCode();
      if (readers) {
        const all = [...new Set([this.did, ...readers])];
        const { key, sealed } = await sealItem(
          text,
          all.map((did) => ({ did, encryptionPublic: resolveDidKey(did).encryptionKey })),
        );
        this.itemKeys.set(`${listDid}|${itemId}`, { key, sealed });
        await this.change(listDid, { kind: "add", itemId, sealed, readers: all }, text, opts);
      } else {
        await this.change(listDid, { kind: "add", itemId, text }, text, opts);
      }
      return itemId;
    });
  }

  setChecked(listDid: string, itemId: string, checked: boolean, opts: { sendAnyway?: boolean } = {}): Promise<void> {
    return this.serial(() => this.change(listDid, { kind: checked ? "check" : "uncheck", itemId }, undefined, opts));
  }

  edit(listDid: string, itemId: string, text: string, opts: { sendAnyway?: boolean } = {}): Promise<void> {
    return this.serial(async () => {
      const item = this.model(listDid).item(itemId);
      if (item?.private) {
        const k = this.itemKeys.get(`${listDid}|${itemId}`);
        if (!k) throw new Error("not a reader of this item");
        const sealed = resealText(text, k.key, k.sealed);
        this.itemKeys.set(`${listDid}|${itemId}`, { key: k.key, sealed });
        await this.change(listDid, { kind: "edit", itemId, sealed }, text, opts);
      } else {
        await this.change(listDid, { kind: "edit", itemId, text }, text, opts);
      }
    });
  }

  remove(listDid: string, itemId: string, opts: { sendAnyway?: boolean } = {}): Promise<void> {
    return this.serial(() => this.change(listDid, { kind: "delete", itemId }, undefined, opts));
  }

  /** Asks one other current member of each list for everything they have (design v2 §4.9). */
  syncNow(): Promise<void> {
    return this.serial(async () => {
      this.syncTurn++;
      for (const r of this.lists_.values()) {
        if (r.left || r.pending || this.amRemoved(r)) continue;
        const others = currentMembers(r.roster).filter((m) => m.did !== this.did);
        if (others.length === 0) continue;
        const peer = others[this.syncTurn % others.length];
        await this.endpoint.notify(peer.did, SYNC_REQUEST, { list: r.did });
      }
    });
  }

  // ------------------------------------------------------------------ for trying attacks from a real device

  /** Sends an op signed by this device but carrying someone else's membership credential. */
  forgeWithCredential(listDid: string, membership: Credential, targets: string[], text: string): Promise<void> {
    return this.serial(async () => {
      const op = signOp(this.identity, this.opts.clock, { list: listDid, kind: "add", itemId: shortCode(), text, membershipId: membership.id });
      for (const t of targets) await this.endpoint.notify(t, OP, { op, membership } satisfies OpMessage);
    });
  }

  /** Re-sends an old roster to someone, as an attacker trying to undo a removal would. */
  replayRoster(listDid: string, roster: RosterDoc, to: string): Promise<void> {
    void listDid;
    return this.serial(async () => {
      await this.endpoint.notify(to, ROSTER, { roster });
    });
  }

  /** Forwards a copy of a held op with its text changed. */
  forwardTampered(listDid: string, opId: string, author: string, text: string, to: string): Promise<void> {
    return this.serial(async () => {
      const r = this.requireList(listDid);
      const op = this.model(listDid).get(`${author}|${opId}`);
      if (!op) throw new Error("No such change.");
      await this.endpoint.notify(to, SYNC, { list: listDid, roster: r.roster, ops: [{ op: tamperOp(op, text), membership: r.memberships[author] }] });
    });
  }

  // ------------------------------------------------------------------ inbound

  private async onJoin(p: { code: string; list: string; name: string }, sender: string): Promise<void> {
    const r = this.lists_.get(p.list);
    const list = this.listKeys.get(p.list);
    const refuse = (reason: string) => this.endpoint.notify(sender, JOIN_REFUSED, { list: p.list, reason });
    if (!r || !list || !r.admin || r.role !== "admin") return void (await refuse("This invitation isn't for a list this device runs."));
    const invite = r.admin.invites.find((i) => i.code === p.code);
    if (!invite) return void (await refuse("This invitation isn't valid."));
    if (invite.usedBy && invite.usedBy !== sender) return void (await refuse("This invitation has already been used."));
    if (!invite.usedBy && Date.parse(invite.expiresAt) <= this.opts.clock.now()) return void (await refuse("This invitation has expired."));
    const existing = rosterMember(r.roster, sender);
    if (existing?.removedAt) return void (await refuse("You were removed from this list."));
    if (!invite.usedBy) {
      invite.usedBy = sender;
      const name = String(p.name ?? "").trim().slice(0, 60) || "Someone";
      const membership = this.issueMembership(list, sender, invite.role);
      r.memberships[sender] = membership;
      r.roster = signRoster(list, this.opts.clock, {
        name: r.roster!.name,
        version: r.roster!.version + 1,
        members: [...r.roster!.members, { did: sender, name, role: invite.role, membershipId: membership.id, joinedAt: this.opts.clock.iso() }],
      });
      await this.save(r);
      for (const m of currentMembers(r.roster)) {
        if (m.did !== this.did && m.did !== sender) await this.endpoint.notify(m.did, ROSTER, { roster: r.roster });
      }
    }
    await this.endpoint.notify(sender, WELCOME, { listName: r.roster!.name, membership: r.memberships[sender], roster: r.roster, ops: this.opMessages(r) });
  }

  private async onWelcome(p: { listName: string; membership: Credential; roster: RosterDoc; ops: OpMessage[] }, sender: string): Promise<void> {
    const r = [...this.lists_.values()].find((x) => x.pending && x.pending.inviter === sender && x.did === p.roster?.list);
    if (!r) return;
    const m = p.membership;
    if (!m || !(await verifyCredential(m, this.opts.clock)).ok || m.issuer !== r.did || m.credentialSubject.id !== this.did) return;
    const verdict = await acceptRoster(undefined, p.roster, r.did, this.opts.clock);
    if (!verdict.ok) return;
    const inviter = rosterMember(verdict.roster, sender);
    if (!inviter || inviter.role !== "admin" || inviter.removedAt) return;
    r.roster = verdict.roster;
    r.membership = m;
    r.role = m.credentialSubject.role as Role;
    r.memberships[this.did] = m;
    r.name = p.listName;
    r.pending = undefined;
    for (const msg of p.ops ?? []) await this.receiveOp(r, msg, undefined, sender);
    this.refuseUnresolved(r);
    r.acknowledgement = issueCredential(this.identity, this.opts.clock, {
      type: ["VerifiableCredential", "TodoListMembershipAcknowledgement"],
      credentialSubject: { id: r.did, member: this.did, role: r.role },
    });
    await this.save(r);
    await this.endpoint.notify(sender, ACK, { acknowledgement: r.acknowledgement });
  }

  private async onJoinRefused(p: { list: string; reason: string }, sender: string): Promise<void> {
    const r = this.lists_.get(p.list);
    if (!r?.pending || r.pending.inviter !== sender) return;
    r.pending.refused = String(p.reason).slice(0, 200);
    await this.save(r);
  }

  private async onAck(p: { acknowledgement: Credential }, sender: string): Promise<void> {
    const ack = p.acknowledgement;
    const r = ack ? this.lists_.get(String(ack.credentialSubject?.id)) : undefined;
    if (!r?.admin || ack.issuer !== sender || !rosterMember(r.roster, sender)) return;
    if (!(await verifyCredential(ack, this.opts.clock)).ok) return;
    r.acks[sender] = true;
    await this.save(r);
  }

  private async onOp(p: OpMessage, sender: string): Promise<void> {
    const r = this.lists_.get(String(p?.op?.list));
    if (!r || r.left || r.pending) return;
    await this.receiveOp(r, p, sender, undefined);
    await this.save(r);
  }

  private async onRoster(p: { roster: RosterDoc }, _sender: string): Promise<void> {
    const r = this.lists_.get(String(p?.roster?.list));
    if (!r || r.pending) return;
    if (await this.adoptRoster(r, p.roster)) await this.save(r);
  }

  private async onSyncRequest(p: { list: string }, sender: string): Promise<void> {
    const r = this.lists_.get(p.list);
    if (!r || r.left || r.pending) return;
    const m = rosterMember(r.roster, sender);
    if (!m || m.removedAt) return;
    await this.endpoint.notify(sender, SYNC, { list: r.did, roster: r.roster, ops: this.opMessages(r) });
  }

  private async onSync(p: { list: string; roster: RosterDoc; ops: OpMessage[] }, sender: string): Promise<void> {
    const r = this.lists_.get(p.list);
    if (!r || r.left || r.pending) return;
    await this.adoptRoster(r, p.roster);
    const from = rosterMember(r.roster, sender);
    if (!from || from.removedAt) {
      for (const msg of p.ops ?? []) this.refuse(r, msg.op, "not from a current member", undefined, sender);
    } else {
      for (const msg of p.ops ?? []) await this.receiveOp(r, msg, undefined, sender);
      this.refuseUnresolved(r);
    }
    await this.save(r);
  }

  private async onLeave(p: { list: string }, sender: string): Promise<void> {
    const r = this.lists_.get(p.list);
    const list = this.listKeys.get(p.list);
    if (!r?.admin || !list) return;
    const m = rosterMember(r.roster, sender);
    if (!m || m.removedAt) return;
    await this.removeFromRoster(r, list, sender);
  }

  // ------------------------------------------------------------------ the core rules

  /** Checks and applies one op (design v2 §4.5). `directSender` when it came from someone directly; `via` when forwarded. */
  private async receiveOp(r: ListRecord, msg: OpMessage, directSender: string | undefined, via: string | undefined, retry = false): Promise<CheckResult> {
    const model = this.model(r.did);
    const verdict = await checkOp({
      op: msg?.op,
      membership: msg?.membership ?? r.memberships[String(msg?.op?.issuer)],
      roster: r.roster,
      directSender,
      forwarded: via !== undefined,
      listDid: r.did,
      model,
      policies: this.opts.policies,
      clock: this.opts.clock,
    });
    if (!verdict.ok) {
      if (verdict.holdable) {
        if (!retry && !r.held.some((h) => opKey(h.msg.op) === opKey(msg.op))) r.held.push({ msg, directSender, via });
        return verdict;
      }
      this.refuse(r, msg?.op, verdict.reason, msg?.op?.issuer, via);
      return verdict;
    }
    if (verdict.duplicate) return verdict;
    this.logCheck(r, msg.op, via, "accepted");
    const op = msg.op;
    let readable: string | undefined;
    if (op.sealed) {
      const opened = await openItem(op.sealed, this.identity);
      if (opened) {
        readable = opened.text;
        this.itemKeys.set(`${r.did}|${op.itemId}`, { key: opened.key, sealed: op.sealed });
      }
    }
    model.insert(op, readable);
    r.ops.push(op);
    if (msg.membership && !r.memberships[op.issuer]) r.memberships[op.issuer] = msg.membership;
    if (!retry) await this.retryHeld(r);
    this.changed();
    return verdict;
  }

  private async retryHeld(r: ListRecord): Promise<void> {
    let progress = true;
    while (progress && r.held.length > 0) {
      progress = false;
      for (const h of [...r.held]) {
        const v = await this.receiveOp(r, h.msg, h.directSender, h.via, true);
        if (v.ok || !("holdable" in v && v.holdable)) {
          r.held.splice(r.held.indexOf(h), 1);
          progress = true;
        }
      }
    }
  }

  /** After catching up, ops still waiting for an item that never came are refused. */
  private refuseUnresolved(r: ListRecord): void {
    for (const h of r.held.splice(0)) this.refuse(r, h.msg.op, "no such item", h.msg.op?.issuer, h.via);
  }

  private refuse(r: ListRecord, op: Partial<Op> | undefined, reason: string, author?: string, via?: string): void {
    const a = typeof author === "string" ? author : String(op?.issuer ?? "");
    r.refused.push({
      at: this.opts.clock.iso(),
      opId: String(op?.id ?? ""),
      author: a,
      authorName: this.nameIn(r, a),
      ...(via ? { via, viaName: this.nameIn(r, via) } : {}),
      reason,
      summary: summarize(op),
    });
    if (r.refused.length > 200) r.refused.splice(0, r.refused.length - 200);
    this.logCheck(r, op, via, `refused: ${reason}`);
    this.changed();
  }

  private async adoptRoster(r: ListRecord, incoming: unknown): Promise<boolean> {
    const v = await acceptRoster(r.roster, incoming, r.did, this.opts.clock);
    if (!v.ok) {
      this.inspect({ kind: "check", at: this.opts.clock.iso(), list: r.did, author: r.did, authorName: "the list", summary: "roster", result: `ignored: ${v.reason}` });
      return false;
    }
    r.roster = v.roster;
    const me = rosterMember(r.roster, this.did);
    if (me) r.role = me.role;
    this.inspect({ kind: "check", at: this.opts.clock.iso(), list: r.did, author: r.did, authorName: "the list", summary: `roster version ${v.roster.version}`, result: "accepted" });
    this.changed();
    return true;
  }

  private async removeFromRoster(r: ListRecord, list: Identity, memberDid: string): Promise<void> {
    const target = rosterMember(r.roster, memberDid);
    if (!target || target.removedAt) throw new Error("They're not a current member.");
    const removedAt = this.opts.clock.iso();
    r.roster = signRoster(list, this.opts.clock, {
      name: r.roster!.name,
      version: r.roster!.version + 1,
      members: r.roster!.members.map((m): RosterMember => (m.did === memberDid ? { ...m, removedAt } : m)),
    });
    await this.save(r);
    // The removed member gets this one roster, so their app knows; later ones go to current members only.
    for (const m of [...currentMembers(r.roster), target]) {
      if (m.did !== this.did) await this.endpoint.notify(m.did, ROSTER, { roster: r.roster });
    }
  }

  /** Signs an op, checks it as any peer would, applies it, and sends it to every other current member. */
  private async change(
    listDid: string,
    body: { kind: OpKind; itemId: string; text?: string; sealed?: SealedText; readers?: string[] },
    readable: string | undefined,
    opts: { sendAnyway?: boolean },
  ): Promise<void> {
    const r = this.requireList(listDid);
    if (r.pending || !r.membership) throw new Error("not a member");
    const op = signOp(this.identity, this.opts.clock, { list: listDid, membershipId: r.membership.id, ...body });
    const verdict = await checkOp({
      op,
      membership: r.membership,
      roster: r.roster,
      directSender: this.did,
      forwarded: false,
      listDid,
      model: this.model(listDid),
      policies: this.opts.policies,
      clock: this.opts.clock,
    });
    if (!verdict.ok && !opts.sendAnyway) throw new Error(verdict.reason);
    if (verdict.ok) {
      this.model(listDid).insert(op, readable);
      r.ops.push(op);
      await this.save(r);
    }
    for (const m of currentMembers(r.roster)) {
      if (m.did !== this.did) await this.endpoint.notify(m.did, OP, { op, membership: r.membership } satisfies OpMessage);
    }
    this.changed();
  }

  // ------------------------------------------------------------------ helpers

  private issueMembership(list: Identity, subject: string, role: Role): Credential {
    return issueCredential(list, this.opts.clock, {
      type: ["VerifiableCredential", "TodoListMembership"],
      credentialSubject: { id: subject, list: list.did, role },
    });
  }

  private opMessages(r: ListRecord): OpMessage[] {
    return r.ops.map((op) => ({ op, membership: r.memberships[op.issuer] }));
  }

  private amRemoved(r: ListRecord): boolean {
    return !!rosterMember(r.roster, this.did)?.removedAt;
  }

  private nameIn(r: ListRecord, did: string): string {
    if (did === this.did) return this.name;
    return rosterMember(r.roster, did)?.name ?? this.nameOf(did);
  }

  private requireList(listDid: string): ListRecord {
    const r = this.lists_.get(listDid);
    if (!r || r.left) throw new Error("No such list.");
    return r;
  }

  private model(listDid: string): ListModel {
    let m = this.models.get(listDid);
    if (!m) {
      m = new ListModel();
      this.models.set(listDid, m);
    }
    return m;
  }

  /** Runs inbound handling and local actions one at a time, so state never interleaves. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run.finally(() => this.changed());
  }

  private logTraffic(t: Traffic): void {
    this.inspect({
      kind: "traffic",
      at: t.at,
      direction: t.direction,
      peer: t.peer,
      peerName: this.nameOf(t.peer),
      type: SPEC_NAMES[t.document.type.split("#")[0]] ?? t.document.type,
      bytes: t.bytes,
      ...(t.delivery ? { delivery: t.delivery } : {}),
      payload: t.document.payload,
    });
  }

  private logCheck(r: ListRecord, op: Partial<Op> | undefined, via: string | undefined, result: string): void {
    const author = String(op?.issuer ?? "");
    this.inspect({ kind: "check", at: this.opts.clock.iso(), list: r.did, author, authorName: this.nameIn(r, author), ...(via ? { via } : {}), summary: summarize(op), result });
  }

  private inspect(e: InspectorEntry): void {
    this.inspectorLog.push(e);
    if (this.inspectorLog.length > INSPECTOR_LIMIT) this.inspectorLog.splice(0, this.inspectorLog.length - INSPECTOR_LIMIT);
    void this.opts.store.put("inspector", this.inspectorLog);
    this.changed();
  }

  private async save(r: ListRecord): Promise<void> {
    await this.opts.store.put(`list/${r.did}`, r);
    this.changed();
  }

  private async load(): Promise<void> {
    this.inspectorLog = (await this.opts.store.get<InspectorEntry[]>("inspector")) ?? [];
    for (const key of await this.opts.store.keys("list/")) {
      const r = await this.opts.store.get<ListRecord>(key);
      if (!r) continue;
      this.lists_.set(r.did, r);
      if (r.admin) this.listKeys.set(r.did, identityFromSeed(fromB64u(r.admin.seed)));
      const model = new ListModel();
      for (const op of r.ops) {
        let readable: string | undefined;
        if (op.sealed) {
          const opened = await openItem(op.sealed, this.identity);
          if (opened) {
            readable = opened.text;
            this.itemKeys.set(`${r.did}|${op.itemId}`, { key: opened.key, sealed: op.sealed });
          }
        }
        model.insert(op, readable);
      }
      this.models.set(r.did, model);
    }
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }
}
