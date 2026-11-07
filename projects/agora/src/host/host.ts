/**
 * The forum host (design §6, §8): checks every write, enforces nullifiers, bans and rate limits, and
 * keeps each forum's feed as a trail in packages/eventlog, signed by the host's AID. Everything the
 * host knows about a forum is replayed from its feed, so the feed is the only state.
 *
 * The host is trusted for availability and for enforcing the gate on writes. It is not trusted for
 * anonymity (it never sees a wallet DID or a secret) or for authenticity (every document is signed by
 * its author, and readers check the proofs themselves). It keeps no addresses or user agents.
 */
import {
  checkRootLog,
  dayOf,
  fieldFromHex,
  parseMembershipProof,
  type Field,
  type GroupRoot,
  type MembershipVerifier,
} from "@toip-tools/anon-membership";
import { Controller, coldKeysFromSeed, signerFromIdentity, toStream, type Body, type DidBinding, type LogStore, type Trail } from "@toip-tools/eventlog";
import { verifyDocument, type Clock, type Identity } from "@toip-tools/trust-core";
import {
  MODERATION_ACTIONS,
  PASS_MAX_MS,
  docHash,
  type DeleteDoc,
  type ForumDoc,
  type ForumPolicy,
  type Gate,
  type GroupDescriptor,
  type Moderation,
  type NymPass,
  type PinnedRoot,
  type Poll,
  type Post,
  type ReportDoc,
  type Vote,
} from "../protocol/documents";
import { GateError, anonymityEstimate, compileGate, gateProblem, passScope, passSignal, pollScope, voteSignal } from "../protocol/gate";

export type ErrorCode =
  | "policyMismatch"
  | "statementMismatch"
  | "proofInvalid"
  | "rootNotAccepted"
  | "anonymitySetTooSmall"
  | "nymBanned"
  | "rateLimited"
  | "nullifierUsed"
  | "passExpired"
  | "passUnknown"
  | "notModerator"
  | "threadLocked"
  | "pollClosed"
  | "tooLarge"
  | "signatureInvalid"
  | "malformed"
  | "notFound"
  | "duplicate"
  | "notOwner";

export class HostError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HostError";
  }
}

const bad = (code: ErrorCode, message: string, status = 400) => new HostError(status, code, message);

/** Where the host gets group descriptors and root logs: the registrars' public reads. */
export interface GroupSource {
  descriptor(group: string): Promise<GroupDescriptor | undefined>;
  log(group: string): Promise<GroupRoot[]>;
}

interface PassRec {
  nym: string;
  thread: string | null;
  validUntil: number;
  hash: string;
  seq: number;
}
interface PostRec {
  seq: number;
  nym: string;
  thread: string;
  deleted: boolean;
  hiddenBy?: string;
}
interface ThreadRec {
  locked: boolean;
  scope: "forum" | "thread";
}
interface PollRec {
  poll: Poll;
  hash: string;
  votes: Map<string, { choice: number; seq: number }>;
}

interface ForumState {
  id: string;
  trail: Trail;
  policy: ForumPolicy;
  policyHash: string;
  passes: Map<string, PassRec>;
  posts: Map<string, PostRec>;
  threads: Map<string, ThreadRec>;
  bans: Map<string, number | null>;
  slow: Map<string, { posts: number; perSeconds: number; until: number | null }>;
  postTimes: Map<string, number[]>;
  polls: Map<string, PollRec>;
  /** Entry seqs whose bodies aren't served, and why. */
  hidden: Map<number, string>;
  docIds: Set<string>;
}

export interface FeedView {
  forum: string;
  host: { did: string; aid: string };
  /** The host's KEL, as a CESR stream. */
  kel: string;
  binding: DidBinding | null;
  /** The forum's trail, as a CESR stream. */
  trail: string;
  /** The bodies the host serves. Hidden and deleted posts' bodies are left out; their headers stay. */
  bodies: Body[];
  /** Entries whose bodies aren't served: the post, its thread, its nym (public before it was hidden), and why. The host vouches for these. */
  hidden: { s: number; reason: string; post: string; thread: string; nym: string }[];
  head: { s: number; d: string };
}

export interface PollView {
  poll: Poll;
  tally: number[];
  votes: number;
  open: boolean;
  closed: boolean;
}

const TRAIL_PREFIX = "agora/forum/";
const isDid = (s: unknown): s is string => typeof s === "string" && /^did:key:z[1-9A-HJ-NP-Za-km-z]+$/.test(s);
const isIso = (s: unknown): s is string => typeof s === "string" && !Number.isNaN(Date.parse(s));
const isNym = (s: unknown): s is string => typeof s === "string" && /^0x[0-9a-f]{64}$/.test(s);
const utf8Len = (s: string) => new TextEncoder().encode(s).length;

export class ForumHost {
  private readonly forums = new Map<string, ForumState>();
  private readonly listeners = new Map<string, Set<(seq: number) => void>>();
  private readonly logCache = new Map<string, { key: string; ok: boolean }>();
  private binding: DidBinding | null = null;

  private constructor(
    readonly identity: Identity,
    private readonly clock: Clock,
    private readonly controller: Controller,
    private readonly store: LogStore,
    private readonly groups: GroupSource,
    private readonly verifier: MembershipVerifier,
  ) {}

  /** Opens the host on its store: incepts its AID the first time, else loads it and replays every forum. */
  static async open(opts: { identity: Identity; rotationSeed: Uint8Array; clock: Clock; store: LogStore; groups: GroupSource; verifier: MembershipVerifier }): Promise<ForumHost> {
    const kel = (await opts.store.logs()).find((l) => l.kind === "kel");
    const hot = [signerFromIdentity(opts.identity)];
    const controller = kel
      ? await Controller.load(kel.logId, { hot, store: opts.store, clock: opts.clock })
      : await Controller.incept({ hot, cold: coldKeysFromSeed(opts.rotationSeed, "agora-host"), store: opts.store, clock: opts.clock, bind: opts.identity });
    const host = new ForumHost(opts.identity, opts.clock, controller, opts.store, opts.groups, opts.verifier);
    await host.findBinding();
    for (const t of controller.trails()) if (t.purpose.startsWith(TRAIL_PREFIX)) await host.replay(t);
    return host;
  }

  get aid(): string {
    return this.controller.aid;
  }

  private async findBinding(): Promise<void> {
    for (const m of this.controller.kelMessages()) {
      for (const a of (m.body.a as { d?: string; i?: string }[] | undefined) ?? []) {
        if (!a || typeof a !== "object" || !a.d || a.i) continue;
        const raw = await this.store.getBody(a.d);
        if (!raw) continue;
        const b = JSON.parse(raw) as DidBinding;
        if (b.type === "trail/did-binding" && b.issuer === this.identity.did) this.binding = b;
      }
    }
  }

  // ── State ─────────────────────────────────────────────────────────

  private async replay(trail: Trail): Promise<void> {
    const msgs = await this.store.range(trail.id);
    let state: ForumState | undefined;
    for (const m of msgs) {
      if (m.t !== "ten") continue;
      const header = JSON.parse(m.raw) as { a: string; dt: string };
      const raw = header.a ? await this.store.getBody(header.a) : undefined;
      if (!raw) continue;
      const doc = (JSON.parse(raw) as { doc: ForumDoc }).doc;
      if (!state) {
        if (doc.type !== "agora/forum-policy") throw new Error(`forum trail ${trail.id} doesn't start with a policy`);
        state = this.newState(trail, doc);
        this.forums.set(state.id, state);
      }
      this.apply(state, doc, m.s, Date.parse(header.dt));
    }
  }

  private newState(trail: Trail, policy: ForumPolicy): ForumState {
    return {
      id: policy.forum.id,
      trail,
      policy,
      policyHash: docHash(policy),
      passes: new Map(),
      posts: new Map(),
      threads: new Map(),
      bans: new Map(),
      slow: new Map(),
      postTimes: new Map(),
      polls: new Map(),
      hidden: new Map(),
      docIds: new Set(),
    };
  }

  /** Applies one accepted document to a forum's state: on write, and on replay. */
  private apply(f: ForumState, doc: ForumDoc, seq: number, at: number): void {
    if ("id" in doc && doc.id) f.docIds.add(doc.id);
    switch (doc.type) {
      case "agora/forum-policy":
        f.policy = doc;
        f.policyHash = docHash(doc);
        return;
      case "agora/nym-pass":
        f.passes.set(doc.issuer, { nym: doc.nym, thread: doc.thread, validUntil: Date.parse(doc.validUntil), hash: docHash(doc), seq });
        return;
      case "agora/post": {
        if (doc.thread === doc.id) f.threads.set(doc.id, { locked: false, scope: f.policy.nyms === "thread" ? "thread" : (doc.nymScope ?? "forum") });
        f.posts.set(doc.id, { seq, nym: doc.nym, thread: doc.thread, deleted: false });
        const times = f.postTimes.get(doc.nym) ?? [];
        times.push(at);
        f.postTimes.set(doc.nym, times.slice(-500));
        return;
      }
      case "agora/delete": {
        const p = f.posts.get(doc.target);
        if (p) {
          p.deleted = true;
          f.hidden.set(p.seq, "Deleted by its author.");
        }
        return;
      }
      case "agora/report":
        return;
      case "agora/moderation": {
        const until = doc.until ? Date.parse(doc.until) : null;
        const p = f.posts.get(doc.target);
        switch (doc.action) {
          case "hide-post":
            if (p) {
              p.hiddenBy = doc.id;
              f.hidden.set(p.seq, `Removed by a moderator: ${doc.reason}`);
            }
            return;
          case "restore-post":
            if (p && p.hiddenBy && !p.deleted) {
              p.hiddenBy = undefined;
              f.hidden.delete(p.seq);
            }
            return;
          case "ban-nym":
            f.bans.set(doc.target, until);
            return;
          case "unban-nym":
            f.bans.delete(doc.target);
            return;
          case "lock-thread":
          case "unlock-thread": {
            const t = f.threads.get(doc.target);
            if (t) t.locked = doc.action === "lock-thread";
            return;
          }
          case "slow-nym":
            if (doc.rate) f.slow.set(doc.target, { ...doc.rate, until });
            return;
        }
        return;
      }
      case "agora/poll":
        f.polls.set(doc.id, { poll: doc, hash: docHash(doc), votes: new Map() });
        return;
      case "agora/vote": {
        // The last vote counts while the poll is open.
        f.polls.get(doc.poll)?.votes.set(doc.nullifier, { choice: doc.choice, seq });
        return;
      }
    }
  }

  private async append(f: ForumState, doc: ForumDoc): Promise<number> {
    const { entry } = await f.trail.append({ kind: doc.type, body: { doc } as unknown as Record<string, unknown> });
    this.apply(f, doc, entry.s, Date.parse(String(entry.body.dt)));
    for (const fn of this.listeners.get(f.id) ?? []) fn(entry.s);
    return entry.s;
  }

  private forum(id: string): ForumState {
    const f = this.forums.get(id);
    if (!f) throw bad("notFound", "no such forum on this host", 404);
    return f;
  }

  private now(): number {
    return this.clock.now();
  }

  // ── Groups and roots ──────────────────────────────────────────────

  private async descriptors(gate: Gate): Promise<GroupDescriptor[]> {
    const descs = await Promise.all(gate.anyOf.map((g) => this.groups.descriptor(g.group)));
    const why = gateProblem(gate, descs);
    if (why) throw bad("malformed", `the gate doesn't work: ${why}`);
    return descs as GroupDescriptor[];
  }

  /** The group's root log, checked: signed by the registrar, chained, no equivocation. */
  private async verifiedLog(group: string, registrar: string): Promise<GroupRoot[]> {
    const log = await this.groups.log(group);
    if (!log.length) throw bad("rootNotAccepted", `${group} has published no root yet`, 409);
    const key = `${log.length} ${log[log.length - 1].id}`;
    const cached = this.logCache.get(group);
    let ok = cached?.key === key ? cached.ok : undefined;
    if (ok === undefined) {
      const r = await checkRootLog(log, registrar, this.clock);
      ok = r.ok && r.head.group === group;
      this.logCache.set(group, { key, ok });
    }
    if (!ok) throw bad("rootNotAccepted", `the root log of ${group} doesn't verify`, 409);
    return log;
  }

  /** A root the host accepts: the latest for its group, or one replaced less than `graceSeconds` ago. */
  private acceptedRoot(log: GroupRoot[], root: Field, graceSeconds: number): GroupRoot | null {
    const head = log[log.length - 1];
    if (fieldFromHex(head.root) === root) return head;
    for (let i = log.length - 2; i >= 0; i--) {
      if (fieldFromHex(log[i].root) !== root) continue;
      const replacedAt = Date.parse(log[i + 1].issuedAt);
      return this.now() - replacedAt <= graceSeconds * 1000 ? log[i] : null;
    }
    return null;
  }

  private checkToday(today: number): void {
    const now = dayOf(this.now());
    if (today !== now && today !== now - 1) throw bad("statementMismatch", "the proof's day is neither today nor yesterday");
  }

  private async verifyZk(zk: unknown, expected: ReturnType<typeof compileGate>): Promise<Field> {
    const r = await this.verifier.verify(zk, expected);
    if (!r.ok) {
      if (r.reason === "statementMismatch") throw bad("statementMismatch", "the proof's statement isn't the one this host computes from the policy");
      throw bad("proofInvalid", `the proof doesn't verify (${r.reason})`);
    }
    return r.nullifier;
  }

  private async signed(doc: object): Promise<void> {
    const issuer = (doc as { issuer?: unknown }).issuer;
    if (!isDid(issuer)) throw bad("malformed", "the issuer must be a did:key");
    let ok = false;
    try {
      ok = (await verifyDocument(doc, this.clock)).valid;
    } catch {
      ok = false;
    }
    if (!ok) throw bad("signatureInvalid", "the signature doesn't check out");
  }

  // ── Forums ────────────────────────────────────────────────────────

  private async checkPolicy(p: ForumPolicy): Promise<void> {
    if (p?.type !== "agora/forum-policy" || p.version !== 1) throw bad("malformed", "expected an agora/forum-policy");
    await this.signed(p);
    const f = p.forum;
    if (!f || typeof f.id !== "string" || !/^urn:uuid:[0-9a-f-]{36}$/.test(f.id)) throw bad("malformed", "forum.id must be a urn:uuid");
    if (typeof f.title !== "string" || !f.title.trim() || f.title.length > 120) throw bad("malformed", "the forum needs a title of up to 120 characters");
    if (typeof f.slug !== "string" || !/^[a-z0-9-]{1,60}$/.test(f.slug)) throw bad("malformed", "the slug is lowercase letters, digits and dashes");
    if (typeof f.description !== "string" || f.description.length > 2000) throw bad("malformed", "the description is at most 2000 characters");
    if (p.nyms !== "forum" && p.nyms !== "thread") throw bad("malformed", "nyms is forum or thread");
    const r = p.posting?.rate;
    if (!r || !Number.isInteger(r.posts) || r.posts < 1 || !Number.isInteger(r.perSeconds) || r.perSeconds < 1) throw bad("malformed", "posting.rate needs whole posts and perSeconds");
    if (!Number.isInteger(p.posting.maxBodyBytes) || p.posting.maxBodyBytes < 100 || p.posting.maxBodyBytes > 100_000) throw bad("malformed", "maxBodyBytes must be 100 to 100000");
    if (p.posting.polls !== "moderators") throw bad("malformed", "in the MVP only moderators open polls");
    if (!Number.isInteger(p.rootGraceSeconds) || p.rootGraceSeconds < 0 || p.rootGraceSeconds > 86400) throw bad("malformed", "rootGraceSeconds must be 0 to 86400");
    if (!Array.isArray(p.moderators) || p.moderators.length > 20 || !p.moderators.every(isDid)) throw bad("malformed", "moderators are did:keys");
    if (!Array.isArray(p.rules) || p.rules.length > 20 || !p.rules.every((x) => typeof x === "string" && x.length <= 500)) throw bad("malformed", "rules are up to 20 short strings");
    await this.descriptors(p.gate);
  }

  async createForum(p: ForumPolicy): Promise<{ forum: string; seq: number }> {
    await this.checkPolicy(p);
    if (p.previous !== null) throw bad("malformed", "a new forum's policy has no previous version");
    if (this.forums.has(p.forum.id)) throw bad("duplicate", "a forum with this id exists", 409);
    const trail = await this.controller.openTrail(TRAIL_PREFIX + p.forum.id);
    const f = this.newState(trail, p);
    this.forums.set(f.id, f);
    const seq = await this.append(f, p);
    return { forum: f.id, seq };
  }

  async updatePolicy(forumId: string, p: ForumPolicy): Promise<{ seq: number }> {
    const f = this.forum(forumId);
    await this.checkPolicy(p);
    if (p.forum.id !== f.id) throw bad("policyMismatch", "the policy is for another forum");
    if (p.issuer !== f.policy.issuer) throw bad("notOwner", "only the forum's owner can change its policy", 403);
    if (p.previous !== f.policyHash) throw bad("policyMismatch", "previous must be the hash of the current policy", 409);
    return { seq: await this.append(f, p) };
  }

  // ── Passes ────────────────────────────────────────────────────────

  async submitPass(forumId: string, pass: NymPass): Promise<{ accepted: true; seq: number; nym: string }> {
    const f = this.forum(forumId);
    if (pass?.type !== "agora/nym-pass" || pass.version !== 1 || typeof pass.id !== "string") throw bad("malformed", "expected an agora/nym-pass");
    await this.signed(pass);
    if (f.docIds.has(pass.id)) throw bad("duplicate", "this pass was already accepted", 409);
    if (pass.forum !== f.id || pass.policy !== f.policyHash) throw bad("policyMismatch", "the pass isn't for this forum's current policy", 409);
    if (!isIso(pass.issuedAt) || !isIso(pass.validUntil)) throw bad("malformed", "issuedAt and validUntil are times");
    const issued = Date.parse(pass.issuedAt);
    const until = Date.parse(pass.validUntil);
    if (until - issued > PASS_MAX_MS || until <= issued) throw bad("passExpired", "a pass lives at most 24 hours");
    if (until <= this.now() || issued > this.now() + 5 * 60_000) throw bad("passExpired", "the pass isn't live");
    if (f.passes.has(pass.issuer)) throw bad("duplicate", "this session already holds a pass; make a new session key", 409);
    if (pass.thread !== null) {
      if (typeof pass.thread !== "string") throw bad("malformed", "thread is a thread id or null");
      const t = f.threads.get(pass.thread);
      if (t && t.scope !== "thread") throw bad("policyMismatch", "this thread uses forum nyms");
    } else if (f.policy.nyms === "thread") throw bad("policyMismatch", "this forum uses thread nyms: a pass names its thread");
    if (!isNym(pass.nym)) throw bad("malformed", "nym is a field");

    const parsed = parseMembershipProof(pass.zk);
    if (!parsed) throw bad("proofInvalid", "the zk proof is malformed");
    const s = parsed.statement;
    this.checkToday(s.today);
    const gate = f.policy.gate;
    const descs = await this.descriptors(gate);
    if (s.groups.length !== gate.anyOf.length) throw bad("statementMismatch", "the proof names other groups than the policy");
    const rootDocs: GroupRoot[] = [];
    for (let i = 0; i < gate.anyOf.length; i++) {
      const log = await this.verifiedLog(gate.anyOf[i].group, gate.anyOf[i].registrar);
      const doc = this.acceptedRoot(log, s.groups[i].root, f.policy.rootGraceSeconds);
      if (!doc) throw bad("rootNotAccepted", `the proof uses a root of ${descs[i].title} this host doesn't accept now`, 409);
      rootDocs.push(doc);
    }
    if (anonymityEstimate(gate, descs, rootDocs) < gate.minAnonymitySet) throw bad("anonymitySetTooSmall", "these groups are too small for this forum's anonymity minimum", 403);
    let expected;
    try {
      expected = compileGate({ gate, descs, roots: s.groups.map((g) => g.root), today: s.today, scope: passScope(f.id, pass.thread), signal: passSignal(pass) });
    } catch (e) {
      if (e instanceof GateError) throw bad("policyMismatch", e.message);
      throw e;
    }
    const nullifier = await this.verifyZk(pass.zk, expected);
    if (fieldFromHex(pass.nym) !== nullifier) throw bad("statementMismatch", "the pass's nym isn't the proof's nullifier");
    this.checkBan(f, pass.nym);
    const seq = await this.append(f, pass);
    return { accepted: true, seq, nym: pass.nym };
  }

  private checkBan(f: ForumState, nym: string): void {
    if (!f.bans.has(nym)) return;
    const until = f.bans.get(nym)!;
    if (until === null || until > this.now()) {
      throw bad("nymBanned", until === null ? "this nym is banned from this forum" : `this nym is banned until ${new Date(until).toISOString()}`, 403);
    }
  }

  /** The live pass a session DID holds in this forum. */
  private livePass(f: ForumState, session: string): PassRec {
    const p = f.passes.get(session);
    if (!p) throw bad("passUnknown", "this session key holds no pass here; prove a nym pass first", 403);
    if (p.validUntil <= this.now()) throw bad("passExpired", "the pass has expired; prove a new one", 403);
    return p;
  }

  // ── Posts ─────────────────────────────────────────────────────────

  async submitPost(forumId: string, post: Post): Promise<{ seq: number }> {
    const f = this.forum(forumId);
    if (post?.type !== "agora/post" || post.version !== 1 || typeof post.id !== "string" || typeof post.thread !== "string") throw bad("malformed", "expected an agora/post");
    await this.signed(post);
    if (post.forum !== f.id) throw bad("policyMismatch", "the post is for another forum");
    if (f.docIds.has(post.id)) throw bad("duplicate", "this post was already accepted", 409);
    const pass = this.livePass(f, post.issuer);
    if (post.pass !== pass.hash || post.nym !== pass.nym) throw bad("passUnknown", "the post doesn't name its session's pass and nym", 403);
    this.checkBan(f, post.nym);
    if (typeof post.body !== "string" || !post.body.trim()) throw bad("malformed", "a post needs a body");
    if (utf8Len(post.body) > f.policy.posting.maxBodyBytes) throw bad("tooLarge", `posts here are at most ${f.policy.posting.maxBodyBytes} bytes`, 413);
    if (post.thread === post.id) {
      if (post.parent !== null) throw bad("malformed", "a thread's first post has no parent");
      if (typeof post.title !== "string" || !post.title.trim() || post.title.length > 200) throw bad("malformed", "a thread needs a title of up to 200 characters");
      const scope = f.policy.nyms === "thread" ? "thread" : (post.nymScope ?? "forum");
      if (scope !== "forum" && scope !== "thread") throw bad("malformed", "nymScope is forum or thread");
      if ((scope === "thread") !== (pass.thread === post.id)) throw bad("policyMismatch", scope === "thread" ? "a thread-nym thread starts with a pass for that thread" : "use your forum pass to start this thread");
    } else {
      const t = f.threads.get(post.thread);
      if (!t) throw bad("notFound", "no such thread", 404);
      if (t.locked) throw bad("threadLocked", "a moderator locked this thread", 403);
      if (t.scope === "thread" ? pass.thread !== post.thread : pass.thread !== null) throw bad("policyMismatch", "this pass isn't for this thread's nym scope");
      if (post.title !== undefined) throw bad("malformed", "only a thread's first post has a title");
      if (post.parent !== null) {
        const parent = f.posts.get(post.parent);
        if (!parent || parent.thread !== post.thread) throw bad("malformed", "the parent isn't in this thread");
      }
    }
    this.checkRate(f, post.nym);
    return { seq: await this.append(f, post) };
  }

  private checkRate(f: ForumState, nym: string): void {
    let rate = f.policy.posting.rate;
    const slow = f.slow.get(nym);
    if (slow && (slow.until === null || slow.until > this.now())) rate = slow;
    const since = this.now() - rate.perSeconds * 1000;
    const recent = (f.postTimes.get(nym) ?? []).filter((t) => t > since).length;
    if (recent >= rate.posts) throw bad("rateLimited", `at most ${rate.posts} posts per ${rate.perSeconds} seconds`, 429);
  }

  async submitDelete(forumId: string, d: DeleteDoc): Promise<{ seq: number }> {
    const f = this.forum(forumId);
    if (d?.type !== "agora/delete" || typeof d.id !== "string") throw bad("malformed", "expected an agora/delete");
    await this.signed(d);
    if (d.forum !== f.id) throw bad("policyMismatch", "for another forum");
    if (f.docIds.has(d.id)) throw bad("duplicate", "already accepted", 409);
    const pass = this.livePass(f, d.issuer);
    const post = f.posts.get(d.target);
    if (!post) throw bad("notFound", "no such post", 404);
    if (post.nym !== pass.nym || d.nym !== pass.nym) throw bad("passUnknown", "only the post's own nym can delete it", 403);
    if (post.deleted) throw bad("duplicate", "already deleted", 409);
    return { seq: await this.append(f, d) };
  }

  async submitReport(forumId: string, r: ReportDoc): Promise<{ seq: number }> {
    const f = this.forum(forumId);
    if (r?.type !== "agora/report" || typeof r.id !== "string") throw bad("malformed", "expected an agora/report");
    await this.signed(r);
    if (r.forum !== f.id) throw bad("policyMismatch", "for another forum");
    if (f.docIds.has(r.id)) throw bad("duplicate", "already accepted", 409);
    const pass = this.livePass(f, r.issuer);
    if (r.nym !== pass.nym) throw bad("passUnknown", "the report doesn't name its session's nym", 403);
    if (!f.posts.has(r.target)) throw bad("notFound", "no such post", 404);
    if (typeof r.reason !== "string" || !r.reason.trim() || r.reason.length > 500) throw bad("malformed", "give a reason of up to 500 characters");
    this.checkBan(f, r.nym);
    this.checkRate(f, r.nym);
    return { seq: await this.append(f, r) };
  }

  // ── Moderation ────────────────────────────────────────────────────

  async moderate(forumId: string, m: Moderation): Promise<{ seq: number }> {
    const f = this.forum(forumId);
    if (m?.type !== "agora/moderation" || typeof m.id !== "string") throw bad("malformed", "expected an agora/moderation");
    await this.signed(m);
    if (m.forum !== f.id) throw bad("policyMismatch", "for another forum");
    if (f.docIds.has(m.id)) throw bad("duplicate", "already accepted", 409);
    if (!f.policy.moderators.includes(m.issuer)) throw bad("notModerator", "the signer isn't a moderator of this forum", 403);
    if (!MODERATION_ACTIONS.includes(m.action)) throw bad("malformed", "unknown action");
    if (typeof m.reason !== "string" || !m.reason.trim() || m.reason.length > 500) throw bad("malformed", "every action needs a reason");
    if (m.until !== undefined && m.until !== null && !isIso(m.until)) throw bad("malformed", "until is a time or null");
    const post = f.posts.get(m.target);
    switch (m.action) {
      case "hide-post":
        if (!post) throw bad("notFound", "no such post", 404);
        if (post.hiddenBy) throw bad("duplicate", "already hidden", 409);
        break;
      case "restore-post":
        if (!post?.hiddenBy) throw bad("notFound", "no hidden post with that id", 404);
        break;
      case "ban-nym":
      case "unban-nym":
      case "slow-nym":
        if (!isNym(m.target)) throw bad("malformed", "the target is a nym");
        if (m.action === "slow-nym" && (!m.rate || !Number.isInteger(m.rate.posts) || m.rate.posts < 1 || !Number.isInteger(m.rate.perSeconds) || m.rate.perSeconds < 1))
          throw bad("malformed", "slow-nym needs a rate");
        break;
      case "lock-thread":
      case "unlock-thread":
        if (!f.threads.has(m.target)) throw bad("notFound", "no such thread", 404);
        break;
    }
    return { seq: await this.append(f, m) };
  }

  // ── Polls and votes ───────────────────────────────────────────────

  /** The latest root of each group, for a poll to pin. */
  async pinFor(forumId: string, gate: Gate): Promise<PinnedRoot[]> {
    this.forum(forumId);
    await this.descriptors(gate);
    const out: PinnedRoot[] = [];
    for (const g of gate.anyOf) {
      const log = await this.verifiedLog(g.group, g.registrar);
      const head = log[log.length - 1];
      out.push({ group: g.group, seq: head.seq, root: head.root });
    }
    return out;
  }

  async openPoll(forumId: string, p: Poll): Promise<{ seq: number }> {
    const f = this.forum(forumId);
    if (p?.type !== "agora/poll" || p.version !== 1 || typeof p.id !== "string") throw bad("malformed", "expected an agora/poll");
    await this.signed(p);
    if (p.forum !== f.id) throw bad("policyMismatch", "for another forum");
    if (f.docIds.has(p.id)) throw bad("duplicate", "already accepted", 409);
    if (!f.policy.moderators.includes(p.issuer)) throw bad("notModerator", "only moderators open polls here", 403);
    if (typeof p.question !== "string" || !p.question.trim() || p.question.length > 300) throw bad("malformed", "a poll needs a question");
    if (!Array.isArray(p.choices) || p.choices.length < 2 || p.choices.length > 8 || !p.choices.every((c) => typeof c === "string" && c.trim() && c.length <= 100)) throw bad("malformed", "2 to 8 choices");
    if (!isIso(p.opensAt) || !isIso(p.closesAt) || Date.parse(p.closesAt) <= Date.parse(p.opensAt) || Date.parse(p.closesAt) <= this.now()) throw bad("malformed", "the poll must close after it opens, in the future");
    if (p.thread !== null && !f.threads.has(p.thread)) throw bad("notFound", "no such thread", 404);
    if (!p.gate.anyOf.every((g) => f.policy.gate.anyOf.some((x) => x.group === g.group))) throw bad("malformed", "a poll's groups must be the forum's");
    const descs = await this.descriptors(p.gate);
    const pins = await this.pinFor(forumId, p.gate);
    if (!Array.isArray(p.pinned) || p.pinned.length !== pins.length || pins.some((x, i) => p.pinned[i]?.group !== x.group || p.pinned[i].root !== x.root || p.pinned[i].seq !== x.seq)) {
      throw bad("rootNotAccepted", "pinned must be each group's latest root", 409);
    }
    const docs = await Promise.all(p.gate.anyOf.map(async (g, i) => (await this.groups.log(g.group))[pins[i].seq]));
    if (anonymityEstimate(p.gate, descs, docs) < p.gate.minAnonymitySet) throw bad("anonymitySetTooSmall", "too few people could vote in this poll to keep ballots secret", 403);
    return { seq: await this.append(f, p) };
  }

  async vote(forumId: string, pollId: string, v: Vote): Promise<{ seq: number; replaced: boolean }> {
    const f = this.forum(forumId);
    const rec = f.polls.get(pollId);
    if (!rec) throw bad("notFound", "no such poll", 404);
    if (v?.type !== "agora/vote" || v.version !== 1 || v.poll !== pollId) throw bad("malformed", "expected an agora/vote for this poll");
    const { poll } = rec;
    const now = this.now();
    if (now < Date.parse(poll.opensAt) || now >= Date.parse(poll.closesAt)) throw bad("pollClosed", "this poll isn't open", 403);
    if (!Number.isInteger(v.choice) || v.choice < 0 || v.choice >= poll.choices.length) throw bad("malformed", "no such choice");
    if (!isNym(v.nullifier)) throw bad("malformed", "nullifier is a field");
    const parsed = parseMembershipProof(v.zk);
    if (!parsed) throw bad("proofInvalid", "the zk proof is malformed");
    this.checkToday(parsed.statement.today);
    const descs = await this.descriptors(poll.gate);
    const expected = compileGate({
      gate: poll.gate,
      descs,
      roots: poll.pinned.map((p) => fieldFromHex(p.root)),
      today: parsed.statement.today,
      scope: pollScope(poll.id),
      signal: voteSignal(poll.id, v.choice),
    });
    const nullifier = await this.verifyZk(v.zk, expected);
    if (fieldFromHex(v.nullifier) !== nullifier) throw bad("statementMismatch", "the vote's nullifier isn't the proof's");
    const prior = rec.votes.get(v.nullifier);
    if (prior && prior.choice === v.choice) throw bad("nullifierUsed", "you already voted for this choice", 409);
    const seq = await this.append(f, v);
    return { seq, replaced: !!prior };
  }

  poll(forumId: string, pollId: string): PollView {
    const f = this.forum(forumId);
    const rec = f.polls.get(pollId);
    if (!rec) throw bad("notFound", "no such poll", 404);
    const tally = rec.poll.choices.map(() => 0);
    for (const v of rec.votes.values()) tally[v.choice]++;
    const now = this.now();
    return { poll: rec.poll, tally, votes: rec.votes.size, open: now >= Date.parse(rec.poll.opensAt) && now < Date.parse(rec.poll.closesAt), closed: now >= Date.parse(rec.poll.closesAt) };
  }

  // ── Reads ─────────────────────────────────────────────────────────

  forumList(): { policy: ForumPolicy; head: { s: number; d: string } }[] {
    return [...this.forums.values()].map((f) => ({ policy: f.policy, head: f.trail.head() }));
  }

  async forumInfo(forumId: string): Promise<{ policy: ForumPolicy; policyHash: string; groups: GroupDescriptor[]; acceptedRoots: GroupRoot[]; head: { s: number; d: string } }> {
    const f = this.forum(forumId);
    const descs = await this.descriptors(f.policy.gate);
    const acceptedRoots: GroupRoot[] = [];
    for (const g of f.policy.gate.anyOf) {
      const log = await this.groups.log(g.group);
      const graceStart = this.now() - f.policy.rootGraceSeconds * 1000;
      for (let i = 0; i < log.length; i++) if (i === log.length - 1 || Date.parse(log[i + 1].issuedAt) >= graceStart) acceptedRoots.push(log[i]);
    }
    return { policy: f.policy, policyHash: f.policyHash, groups: descs, acceptedRoots, head: f.trail.head() };
  }

  async feed(forumId: string): Promise<FeedView> {
    const f = this.forum(forumId);
    const msgs = await this.store.range(f.trail.id);
    const bodies: Body[] = [];
    for (const m of msgs) {
      if (m.t !== "ten" || f.hidden.has(m.s)) continue;
      const a = (JSON.parse(m.raw) as { a: string }).a;
      const raw = a ? await this.store.getBody(a) : undefined;
      if (raw) bodies.push(JSON.parse(raw) as Body);
    }
    return {
      forum: f.id,
      host: { did: this.identity.did, aid: this.aid },
      kel: toStream(this.controller.kelMessages()),
      binding: this.binding,
      trail: msgs.map((m) => m.raw + m.attachments).join(""),
      bodies,
      hidden: [...f.hidden].map(([s, reason]) => {
        const p = [...f.posts].find(([, r]) => r.seq === s);
        return { s, reason, post: p?.[0] ?? "", thread: p?.[1].thread ?? "", nym: p?.[1].nym ?? "" };
      }),
      head: f.trail.head(),
    };
  }

  /** Calls `fn` with the new head seq whenever the forum's feed grows. Returns an unsubscribe function. */
  subscribe(forumId: string, fn: (seq: number) => void): () => void {
    this.forum(forumId);
    let set = this.listeners.get(forumId);
    if (!set) this.listeners.set(forumId, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }
}

