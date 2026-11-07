/**
 * AgoraClient: a member's side (design §6.2 `src/client`). It holds the wallet (a did:key, credentials,
 * the identity secret, group receipts, session keys), syncs groups, proves nym passes and votes, and
 * signs posts. The web app and the tests both use it. Proving is injected: a Web Worker in a browser,
 * the prover in place in Node.
 *
 * One identity secret `s` per account, derived from the seed, so a member's nym in a forum is the same
 * whichever of their groups they prove from, and their backup code restores it. A rotation moves to the
 * next generation of `s`.
 */
import {
  checkRootLog,
  commitmentOf,
  dayOf,
  decodeLeaf,
  deriveSecret,
  encodeLeaf,
  enroll,
  fieldToHex,
  groupFieldOf,
  leafHash,
  membershipInputs,
  nullifierOf,
  sameStatement,
  treeFromRoot,
  type Field,
  type GroupRoot,
  type GroupTree,
  type LeafJson,
  type MembershipProof,
  type ProveProgress,
  type Statement,
  type Witness,
} from "@zk-toip/anon-membership";
import { identityFromSeed, signDocument, toB64u, fromB64u, verifyCredential, type Clock, type Credential, type Endpoint, type Identity } from "@zk-toip/trust-core";
import {
  PASS_MAX_MS,
  docHash,
  newId,
  type DeleteDoc,
  type ForumPolicy,
  type Gate,
  type GatePredicate,
  type GroupDescriptor,
  type GroupReceipt,
  type Moderation,
  type ModerationAction,
  type NymPass,
  type Poll,
  type Post,
  type ReportDoc,
  type Vote,
} from "../protocol/documents";
import { eligibility, type Eligibility, type MembershipView } from "../protocol/describe";
import { anonymityEstimate, compileGate, leafFieldsFromCredential, passScope, passSignal, pollScope, voteSignal } from "../protocol/gate";
import { nymName } from "../protocol/names";
import { DEMO_ISSUE, GROUP_RECEIPT, type DemoIssueRequest } from "../protocol/specs";
import { AgoraError, type HostApi, type RegistrarApi, type ForumInfo } from "./http";

export interface ProverLike {
  prove(statement: Statement, witness: Witness, onProgress?: (p: ProveProgress) => void): Promise<MembershipProof>;
}

/** Where the wallet is kept: the passkey vault in a browser, memory in tests. */
export interface WalletStore {
  load(): Promise<WalletState | null>;
  save(state: WalletState): Promise<void>;
}

export interface Membership {
  group: string;
  registrar: string;
  index: number;
  leaf: LeafJson;
  values: Record<string, string>;
  /** Which generation of the identity secret the leaf commits to. */
  gen: number;
}

export interface SessionRec {
  forum: string;
  thread: string | null;
  seed: string;
  pass: NymPass;
  hash: string;
  gen: number;
}

export interface WalletState {
  v: 1;
  gen: number;
  credentials: Credential[];
  memberships: Membership[];
  sessions: SessionRec[];
}

export class MemoryWallet implements WalletStore {
  constructor(private s: WalletState | null = null) {}
  async load() {
    return this.s ? structuredClone(this.s) : null;
  }
  async save(s: WalletState) {
    this.s = structuredClone(s);
  }
}

export interface GroupCopy {
  desc: GroupDescriptor;
  log: GroupRoot[];
  head: GroupRoot;
  tree: GroupTree;
}

const emptyState = (): WalletState => ({ v: 1, gen: 0, credentials: [], memberships: [], sessions: [] });

export class AgoraClient {
  readonly identity: Identity;
  private state: WalletState = emptyState();
  private readonly groups = new Map<string, GroupCopy>();
  private descCache = new Map<string, GroupDescriptor>();

  private constructor(
    private readonly seed: Uint8Array,
    readonly clock: Clock,
    readonly host: HostApi,
    readonly registrar: RegistrarApi,
    private readonly prover: ProverLike,
    private readonly wallet: WalletStore,
    private readonly endpoint?: Endpoint,
  ) {
    this.identity = identityFromSeed(seed);
  }

  static async open(o: { seed: Uint8Array; clock: Clock; host: HostApi; registrar: RegistrarApi; prover: ProverLike; wallet: WalletStore; endpoint?: Endpoint }): Promise<AgoraClient> {
    const c = new AgoraClient(o.seed, o.clock, o.host, o.registrar, o.prover, o.wallet, o.endpoint);
    c.state = (await o.wallet.load()) ?? emptyState();
    return c;
  }

  get did(): string {
    return this.identity.did;
  }

  /** The identity secret of a generation. Generation 0 is what a new account starts with. */
  secret(gen = this.state.gen): Field {
    return deriveSecret(this.seed, gen === 0 ? "agora/v1/identity-secret" : `agora/v1/identity-secret/${gen}`);
  }

  private async save(): Promise<void> {
    await this.wallet.save(this.state);
  }

  private tsp(): Endpoint {
    if (!this.endpoint) throw new AgoraError("offline", "this client has no TSP connection");
    return this.endpoint;
  }

  credentials(): Credential[] {
    return [...this.state.credentials];
  }

  memberships(): Membership[] {
    return [...this.state.memberships];
  }

  generation(): number {
    return this.state.gen;
  }

  // ── Credentials and groups ────────────────────────────────────────

  /** Asks a demo issuer for a credential over TSP, checks it, and keeps it. */
  async requestCredential(issuerDid: string, req: DemoIssueRequest): Promise<Credential> {
    const res = await this.tsp().request<DemoIssueRequest, { credential: Credential }>(issuerDid, DEMO_ISSUE, req);
    const vc = res.payload.credential;
    const check = await verifyCredential(vc, this.clock);
    if (!check.ok || vc.issuer !== issuerDid || vc.credentialSubject.id !== this.did) throw new AgoraError("credentialInvalid", "the issuer sent a credential that doesn't check out");
    this.state.credentials.push(vc);
    await this.save();
    return vc;
  }

  async descriptor(group: string): Promise<GroupDescriptor> {
    let d = this.descCache.get(group);
    if (!d) {
      d = await this.registrar.group(group);
      this.descCache.set(group, d);
    }
    return d;
  }

  async allGroups(): Promise<GroupDescriptor[]> {
    const { groups } = await this.registrar.groups();
    for (const g of groups) this.descCache.set(g.id, g);
    return groups;
  }

  /** A credential this group admits: the right issuer and type, issued to this account, current. */
  credentialFor(desc: GroupDescriptor): Credential | undefined {
    return this.state.credentials
      .filter((vc) => vc.issuer === desc.source.issuer && vc.type.includes(desc.source.credentialType) && vc.credentialSubject.id === this.did)
      .filter((vc) => !vc.validUntil || Date.parse(vc.validUntil) > this.clock.now())
      .at(-1);
  }

  /** Joins a group over TSP with a credential it admits (anon-membership/enroll). The registrar learns the DID and a commitment. */
  async join(group: string, opts: { credential?: Credential } = {}): Promise<Membership> {
    const desc = await this.descriptor(group);
    const vc = opts.credential ?? this.credentialFor(desc);
    if (!vc) throw new AgoraError("noCredential", `you need a ${desc.credentialLabel} from ${desc.title} to join`);
    const gen = this.state.gen;
    const e = await enroll(this.tsp(), desc.issuer, group, this.secret(gen), { credential: vc });
    const { values } = leafFieldsFromCredential(desc, vc, e.leaf.registeredDay);
    const m: Membership = { group, registrar: desc.issuer, index: e.index, leaf: encodeLeaf(e.leaf), values, gen };
    this.state.memberships = [...this.state.memberships.filter((x) => x.group !== group), m];
    await this.save();
    return m;
  }

  /**
   * Rotates: a new identity secret, and a new leaf in every group this account is in. The new leaves
   * have a new registeredDay, so a forum's minRegisteredDays applies again. Every old nym is left behind.
   */
  async rotate(): Promise<Membership[]> {
    const gen = this.state.gen + 1;
    const out: Membership[] = [];
    for (const m of this.state.memberships) {
      const desc = await this.descriptor(m.group);
      const vc = this.credentialFor(desc);
      const e = await enroll(this.tsp(), desc.issuer, m.group, this.secret(gen), { credential: vc, replace: true });
      out.push({ ...m, index: e.index, leaf: encodeLeaf(e.leaf), gen, values: vc ? leafFieldsFromCredential(desc, vc, e.leaf.registeredDay).values : m.values });
    }
    this.state = { ...this.state, gen, memberships: out, sessions: [] };
    await this.save();
    return out;
  }

  /** After restoring from a backup code: asks each registrar for this account's receipt, and finds the secret's generation. */
  async recover(): Promise<Membership[]> {
    const found: Membership[] = [];
    let maxGen = this.state.gen;
    for (const d of await this.allGroups()) {
      let r: GroupReceipt;
      try {
        r = (await this.tsp().request<{ group: string }, GroupReceipt>(d.issuer, GROUP_RECEIPT, { group: d.id })).payload;
      } catch {
        continue;
      }
      if (r.issuer !== d.issuer || r.subject !== this.did || r.group !== d.id) continue;
      const gf = groupFieldOf(d.id);
      const leaf = decodeLeaf(r.leaf as LeafJson);
      for (let gen = 0; gen < 16; gen++) {
        if (commitmentOf(this.secret(gen), gf) !== leaf.commitment) continue;
        found.push({ group: d.id, registrar: d.issuer, index: r.index, leaf: r.leaf as LeafJson, values: r.values, gen });
        maxGen = Math.max(maxGen, gen);
        break;
      }
    }
    this.state = { ...this.state, gen: maxGen, memberships: found };
    await this.save();
    return found;
  }

  /** Fetches a group's signed root log and the newest snapshot, and checks them. The registrar learns only that someone synced. */
  async syncGroup(group: string): Promise<GroupCopy> {
    const desc = await this.descriptor(group);
    const { roots } = await this.registrar.roots(group);
    const check = await checkRootLog(roots, desc.issuer, this.clock);
    if (!check.ok) throw new AgoraError("badRootLog", `${desc.title}'s root log doesn't verify (${check.reason})`);
    const cached = this.groups.get(group);
    if (cached && cached.head.id === check.head.id) return cached;
    const snapshot = await this.registrar.snapshot(group, check.head.epoch);
    const copy = { desc, log: roots, head: check.head, tree: treeFromRoot(check.head, snapshot) };
    this.groups.set(group, copy);
    return copy;
  }

  /** The member's groups, as eligibility checks need them. */
  async membershipViews(groups?: string[]): Promise<MembershipView[]> {
    const out: MembershipView[] = [];
    for (const m of this.state.memberships) {
      if (m.gen !== this.state.gen || (groups && !groups.includes(m.group))) continue;
      let inRoot = false;
      try {
        inRoot = (await this.syncGroup(m.group)).tree.indexOf(leafHash(decodeLeaf(m.leaf))) >= 0;
      } catch {
        inRoot = false;
      }
      out.push({ group: m.group, values: m.values, registeredDay: m.leaf.registeredDay, validUntilDay: m.leaf.validUntilDay, inRoot });
    }
    return out;
  }

  today(): number {
    return dayOf(this.clock.now());
  }

  async eligibility(gate: Gate, purpose?: string): Promise<Eligibility> {
    const descs = await Promise.all(gate.anyOf.map((g) => this.descriptor(g.group).catch(() => undefined)));
    return eligibility(gate, descs, await this.membershipViews(gate.anyOf.map((g) => g.group)), this.today(), purpose);
  }

  /** About how many people could have written a post under this gate, from the latest roots. */
  async anonymitySet(gate: Gate): Promise<number> {
    const descs = await Promise.all(gate.anyOf.map((g) => this.descriptor(g.group)));
    const heads = await Promise.all(gate.anyOf.map(async (g) => (await this.syncGroup(g.group)).head));
    return anonymityEstimate(gate, descs, heads);
  }

  /** This account's nym in a forum (or a thread), computed locally before any proof. */
  nymFor(forumId: string, thread: string | null = null): string {
    return fieldToHex(nullifierOf(this.secret(), passScope(forumId, thread), 0));
  }

  nameFor(forumId: string, thread: string | null = null): string {
    return nymName(this.nymFor(forumId, thread));
  }

  // ── Proving ───────────────────────────────────────────────────────

  /** The statement and witness for a gate against the given roots: one leaf in one of the groups. */
  private async inputs(gate: Gate, roots: Map<string, string>, scope: Field, signal: Field) {
    const descs = await Promise.all(gate.anyOf.map((g) => this.descriptor(g.group)));
    const trees: GroupTree[] = [];
    for (const g of gate.anyOf) {
      const copy = await this.syncGroup(g.group);
      const want = roots.get(g.group);
      if (!want) throw new AgoraError("rootNotAccepted", "no root to prove against");
      if (copy.head.root === want) {
        trees.push(copy.tree);
        continue;
      }
      // An older root (a poll's pinned one): rebuild its tree from its snapshot.
      const doc = copy.log.find((r) => r.root === want);
      if (!doc) throw new AgoraError("rootNotAccepted", `the root isn't in ${copy.desc.title}'s signed log: refusing to prove against it`);
      trees.push(treeFromRoot(doc, await this.registrar.snapshot(g.group, doc.epoch)));
    }
    const expected = compileGate({ gate, descs, roots: trees.map((t) => t.root()), today: this.today(), scope, signal });
    const el = await this.eligibility(gate);
    const order = el.ok ? [el.group] : [];
    const mine = this.state.memberships.filter((m) => m.gen === this.state.gen && gate.anyOf.some((g) => g.group === m.group));
    mine.sort((a, b) => order.indexOf(b.group) - order.indexOf(a.group));
    for (const m of mine) {
      const { commitment: _c, ...leaf } = decodeLeaf(m.leaf);
      try {
        const { statement, witness } = membershipInputs({
          secret: this.secret(),
          groups: gate.anyOf.map((g, i) => ({ group: g.group, tree: trees[i] })),
          leaf,
          scope,
          signal,
          today: expected.today,
          registeredBy: expected.registeredBy,
          schemaId: expected.schemaId,
          predicates: expected.predicates,
        });
        if (!sameStatement(statement, expected)) throw new Error("the statement differs from the gate's");
        return { statement, witness };
      } catch {
        continue;
      }
    }
    throw new AgoraError("notMember", el.ok ? "your leaf isn't in the group's latest root yet" : el.reason);
  }

  /** The roots the host accepts now, and that this client also finds in each registrar's log: the latest ones. */
  private async passRoots(info: ForumInfo): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const g of info.policy.gate.anyOf) {
      const copy = await this.syncGroup(g.group);
      if (!info.acceptedRoots.some((r) => r.group === g.group && r.root === copy.head.root)) {
        throw new AgoraError("rootNotAccepted", `the host doesn't accept ${copy.desc.title}'s latest root: it may be behind, or showing you a different view`);
      }
      out.set(g.group, copy.head.root);
    }
    return out;
  }

  /** Whether the wallet holds a live pass for this forum (or thread) under this policy. */
  hasLivePass(forumId: string, thread: string | null, policyHash: string): boolean {
    return this.state.sessions.some(
      (s) => s.forum === forumId && s.thread === thread && s.gen === this.state.gen && s.pass.policy === policyHash && Date.parse(s.pass.validUntil) > this.clock.now() + 10 * 60_000,
    );
  }

  /** A live pass for this forum (or thread), from the wallet, or proved now. */
  async ensurePass(forumId: string, thread: string | null, onProgress?: (p: ProveProgress) => void): Promise<SessionRec> {
    const info = await this.host.forum(forumId);
    const live = this.state.sessions.find(
      (s) => s.forum === forumId && s.thread === thread && s.gen === this.state.gen && s.pass.policy === info.policyHash && Date.parse(s.pass.validUntil) > this.clock.now() + 10 * 60_000,
    );
    if (live) return live;
    return this.provePass(info, thread, onProgress);
  }

  /** Proves a nym pass for a fresh session key, and sends it. */
  async provePass(info: ForumInfo, thread: string | null, onProgress?: (p: ProveProgress) => void, opts: { send?: boolean } = {}): Promise<SessionRec> {
    const forumId = info.policy.forum.id;
    const el = await this.eligibility(info.policy.gate);
    if (!el.ok) throw new AgoraError("notEligible", el.reason);
    const sessionSeed = crypto.getRandomValues(new Uint8Array(32));
    const session = identityFromSeed(sessionSeed);
    const now = this.clock.now();
    const draft: Omit<NymPass, "zk" | "proof"> = {
      type: "agora/nym-pass",
      version: 1,
      id: newId(),
      issuer: session.did,
      issuedAt: new Date(now).toISOString(),
      forum: forumId,
      policy: info.policyHash,
      thread,
      nym: this.nymFor(forumId, thread),
      validUntil: new Date(now + PASS_MAX_MS).toISOString(),
    };
    const { statement, witness } = await this.inputs(info.policy.gate, await this.passRoots(info), passScope(forumId, thread), passSignal(draft));
    const zk = await this.prover.prove(statement, witness, onProgress);
    const pass = signDocument<NymPass>({ ...draft, zk }, session, this.clock);
    if (opts.send !== false) await this.host.pass(forumId, pass);
    const rec: SessionRec = { forum: forumId, thread, seed: toB64u(sessionSeed), pass, hash: docHash(pass), gen: this.state.gen };
    if (opts.send !== false) {
      this.state.sessions = [...this.state.sessions.filter((s) => !(s.forum === forumId && s.thread === thread)), rec];
      await this.save();
    }
    return rec;
  }

  private sessionIdentity(s: SessionRec): Identity {
    return identityFromSeed(fromB64u(s.seed));
  }

  // ── Writing ───────────────────────────────────────────────────────

  async startThread(o: { forum: string; title: string; body: string; nymScope?: "forum" | "thread"; onProgress?: (p: ProveProgress) => void }): Promise<Post> {
    const info = await this.host.forum(o.forum);
    const id = newId();
    const scope = info.policy.nyms === "thread" ? "thread" : (o.nymScope ?? "forum");
    const s = await this.ensurePass(o.forum, scope === "thread" ? id : null, o.onProgress);
    return this.send(s, { id, thread: id, parent: null, title: o.title, body: o.body, ...(scope === "thread" && info.policy.nyms !== "thread" ? { nymScope: "thread" as const } : {}) });
  }

  async reply(o: { forum: string; thread: string; threadScope: "forum" | "thread"; parent?: string | null; body: string; onProgress?: (p: ProveProgress) => void }): Promise<Post> {
    const s = await this.ensurePass(o.forum, o.threadScope === "thread" ? o.thread : null, o.onProgress);
    return this.send(s, { id: newId(), thread: o.thread, parent: o.parent ?? null, body: o.body });
  }

  private async send(s: SessionRec, p: Pick<Post, "id" | "thread" | "parent" | "body" | "title" | "nymScope">): Promise<Post> {
    const session = this.sessionIdentity(s);
    const post = signDocument<Post>(
      { type: "agora/post", version: 1, issuer: session.did, issuedAt: this.clock.iso(), forum: s.forum, nym: s.pass.nym, pass: s.hash, ...p },
      session,
      this.clock,
    );
    await this.host.post(s.forum, post);
    return post;
  }

  /** A session of this account for this forum that holds the nym, to sign deletes and reports with. */
  private async sessionFor(forum: string, thread: string | null): Promise<SessionRec> {
    return this.ensurePass(forum, thread);
  }

  async deletePost(forum: string, postId: string, thread: string | null = null): Promise<void> {
    const s = await this.sessionFor(forum, thread);
    const id = this.sessionIdentity(s);
    const d = signDocument<DeleteDoc>({ type: "agora/delete", version: 1, id: newId(), issuer: id.did, issuedAt: this.clock.iso(), forum, target: postId, nym: s.pass.nym }, id, this.clock);
    await this.host.delete(forum, d);
  }

  async report(forum: string, postId: string, reason: string, thread: string | null = null): Promise<void> {
    const s = await this.sessionFor(forum, thread);
    const id = this.sessionIdentity(s);
    const r = signDocument<ReportDoc>({ type: "agora/report", version: 1, id: newId(), issuer: id.did, issuedAt: this.clock.iso(), forum, target: postId, reason, nym: s.pass.nym }, id, this.clock);
    await this.host.report(forum, r);
  }

  // ── Owners and moderators: they act under their own DIDs ─────────

  async createForum(o: { title: string; slug: string; description: string; gate: Gate; nyms?: "forum" | "thread"; moderators?: string[]; rules?: string[]; rate?: { posts: number; perSeconds: number } }): Promise<ForumPolicy> {
    const policy = signDocument<ForumPolicy>(
      {
        type: "agora/forum-policy",
        version: 1,
        id: newId(),
        issuer: this.did,
        issuedAt: this.clock.iso(),
        forum: { id: newId(), slug: o.slug, title: o.title, description: o.description, hosts: [this.host.url] },
        previous: null,
        gate: o.gate,
        nyms: o.nyms ?? "forum",
        posting: { rate: o.rate ?? { posts: 30, perSeconds: 86400 }, maxBodyBytes: 20000, polls: "moderators" },
        rootGraceSeconds: 3600,
        moderators: o.moderators ?? [this.did],
        rules: o.rules ?? [],
      },
      this.identity,
      this.clock,
    );
    await this.host.createForum(policy);
    return policy;
  }

  async moderate(forum: string, action: ModerationAction, target: string, reason: string, extra: { until?: string | null; rate?: { posts: number; perSeconds: number } } = {}): Promise<Moderation> {
    const m = signDocument<Moderation>(
      { type: "agora/moderation", version: 1, id: newId(), issuer: this.did, issuedAt: this.clock.iso(), forum, action, target, reason, ...extra },
      this.identity,
      this.clock,
    );
    await this.host.moderate(forum, m);
    return m;
  }

  /** Opens a poll. Its gate is the forum's, with extra predicates; the host's latest roots are pinned. */
  async openPoll(o: { forum: string; question: string; choices: string[]; closesAt: string; where?: GatePredicate[]; thread?: string | null }): Promise<Poll> {
    const info = await this.host.forum(o.forum);
    const base = info.policy.gate;
    const where = [...base.where.filter((w) => !o.where?.some((x) => x.attr === w.attr)), ...(o.where ?? [])];
    const gate: Gate = { ...base, where };
    const { pinned } = await this.host.pin(o.forum, gate);
    // Check what the host pinned against the registrars' own logs.
    for (const p of pinned) {
      const copy = await this.syncGroup(p.group);
      if (copy.log[p.seq]?.root !== p.root) throw new AgoraError("rootNotAccepted", "the host pinned a root that isn't in the registrar's log");
    }
    const poll = signDocument<Poll>(
      { type: "agora/poll", version: 1, id: newId(), issuer: this.did, issuedAt: this.clock.iso(), forum: o.forum, thread: o.thread ?? null, question: o.question, choices: o.choices, opensAt: this.clock.iso(), closesAt: o.closesAt, gate, pinned },
      this.identity,
      this.clock,
    );
    await this.host.openPoll(o.forum, poll);
    return poll;
  }

  /** Proves a vote against the poll's pinned roots. Nothing is sent: see sendVote. */
  async prepareVote(poll: Poll, choice: number, onProgress?: (p: ProveProgress) => void): Promise<Vote> {
    const el = await this.eligibility(poll.gate, "This poll");
    if (!el.ok) throw new AgoraError("notEligible", el.reason);
    const roots = new Map(poll.pinned.map((p) => [p.group, p.root]));
    const { statement, witness } = await this.inputs(poll.gate, roots, pollScope(poll.id), voteSignal(poll.id, choice));
    const zk = await this.prover.prove(statement, witness, onProgress);
    return { type: "agora/vote", version: 1, poll: poll.id, choice, nullifier: zk.nullifier, zk };
  }

  sendVote(forum: string, vote: Vote) {
    return this.host.vote(forum, vote.poll, vote);
  }
}

