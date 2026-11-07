/**
 * Reading a forum without trusting the host (design §8.2 step 7, §7.5): the host's KEL and DID binding,
 * the forum's trail (signatures, chain, bodies), every document's signature, every pass's zero-knowledge
 * proof (cached by pass hash), every vote's proof, and that the feed extends what this reader saw before.
 * Anyone can read; no account is needed.
 */
import { checkRootLog, fieldFromHex, parseMembershipProof, type GroupRoot, type Statement, type VerifyResult } from "@zk-toip/anon-membership";
import { verifyBinding, verifyKel, verifyTrail, type Body } from "@zk-toip/eventlog";
import { verifyDocument, type Clock } from "@zk-toip/trust-core";
import type { DeleteDoc, ForumDoc, ForumPolicy, GroupDescriptor, Moderation, NymPass, Poll, Post, ReportDoc, Vote } from "../protocol/documents";
import { docHash } from "../protocol/documents";
import { compileGate, gateProblem, passScope, passSignal, pollScope, voteSignal } from "../protocol/gate";
import { gateInWords } from "../protocol/describe";
import { nymName } from "../protocol/names";
import type { HostApi, RegistrarApi } from "./http";

export interface VerifierLike {
  verify(proof: unknown, expected?: Statement): Promise<VerifyResult>;
}

/** Small persistent key-value storage: localStorage in a browser, a Map in tests. */
export interface KeyValue {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export class MemoryKeyValue implements KeyValue {
  private m = new Map<string, string>();
  get(k: string) {
    return this.m.get(k) ?? null;
  }
  set(k: string, v: string) {
    this.m.set(k, v);
  }
}

export type PostStatus = "verified" | "unverified" | "hidden" | "deleted";

export interface PostView {
  id: string;
  seq: number;
  thread: string;
  parent: string | null;
  title?: string;
  body?: string;
  nym: string;
  name: string;
  at: string;
  status: PostStatus;
  /** Why it's hidden or unverified. */
  note?: string;
  reports: number;
}

export interface ThreadView {
  id: string;
  title: string;
  scope: "forum" | "thread";
  locked: boolean;
  posts: PostView[];
  lastAt: string;
}

export interface PollState {
  poll: Poll;
  tally: number[];
  votes: number;
  /** Votes whose proofs didn't verify, left out of the tally. */
  rejected: number;
  open: boolean;
  closed: boolean;
}

export interface ModerationView {
  doc: Moderation;
  seq: number;
  at: string;
  /** The moderator's DID, which is public. */
  by: string;
}

export interface ReportView {
  doc: ReportDoc;
  seq: number;
  at: string;
  reporter: string;
  targetNym?: string;
}

export interface NymSummary {
  nym: string;
  name: string;
  firstAt: string;
  posts: number;
  reports: number;
  banned: { until: string | null } | null;
  slowed: { posts: number; perSeconds: number; until: string | null } | null;
}

export interface ForumView {
  forumId: string;
  policy: ForumPolicy;
  policyHash: string;
  descriptors: GroupDescriptor[];
  /** In words, for "Verified: …". */
  gateWords: string;
  host: { did: string; aid: string };
  head: { s: number; d: string };
  /** Problems found while verifying. Empty when everything checks out. */
  warnings: string[];
  /** True if this host's history differs from what this reader saw before. */
  historyChanged: boolean;
  threads: ThreadView[];
  polls: PollState[];
  moderation: ModerationView[];
  reports: ReportView[];
  nyms: Map<string, NymSummary>;
  entries: number;
}

const DAY = 86_400_000;

export class ForumReader {
  private readonly passCache = new Map<string, boolean>();

  constructor(
    readonly host: HostApi,
    readonly registrar: RegistrarApi,
    private readonly verifier: VerifierLike,
    private readonly clock: Clock,
    private readonly kv: KeyValue = new MemoryKeyValue(),
  ) {}

  private async logs(descs: GroupDescriptor[]): Promise<Map<string, GroupRoot[]>> {
    const out = new Map<string, GroupRoot[]>();
    for (const d of descs) {
      const { roots } = await this.registrar.roots(d.id);
      const check = await checkRootLog(roots, d.issuer, this.clock);
      out.set(d.id, check.ok ? roots : []);
    }
    return out;
  }

  /** Verifies a pass's proof against the policy it names, with roots from the registrar's signed log. */
  private async passOk(pass: NymPass, policies: Map<string, ForumPolicy>, descById: Map<string, GroupDescriptor>, logs: Map<string, GroupRoot[]>): Promise<string | null> {
    const hash = docHash(pass);
    const cached = this.passCache.get(hash) ?? (this.kv.get(`agora.pass-ok.${hash}`) === "1" ? true : undefined);
    if (cached) return null;
    const policy = policies.get(pass.policy);
    if (!policy) return "the pass names a policy this forum never had";
    const parsed = parseMembershipProof(pass.zk);
    if (!parsed) return "the pass's proof is malformed";
    const descs = policy.gate.anyOf.map((g) => descById.get(g.group));
    if (gateProblem(policy.gate, descs)) return "the policy's gate names groups the registrar doesn't list";
    for (let i = 0; i < policy.gate.anyOf.length; i++) {
      const log = logs.get(policy.gate.anyOf[i].group) ?? [];
      const root = parsed.statement.groups[i]?.root;
      if (root === undefined || !log.some((r) => fieldFromHex(r.root) === root)) return "the pass's proof uses a root the registrar never published";
    }
    const expected = compileGate({
      gate: policy.gate,
      descs: descs as GroupDescriptor[],
      roots: parsed.statement.groups.map((g) => g.root),
      today: parsed.statement.today,
      scope: passScope(pass.forum, pass.thread),
      signal: passSignal(pass),
    });
    const r = await this.verifier.verify(pass.zk, expected);
    if (!r.ok) return `the pass's proof doesn't verify (${r.reason})`;
    if (fieldFromHex(pass.nym) !== r.nullifier) return "the pass's nym isn't its proof's nullifier";
    this.passCache.set(hash, true);
    this.kv.set(`agora.pass-ok.${hash}`, "1");
    return null;
  }

  async read(forumId: string): Promise<ForumView> {
    const feed = await this.host.feed(forumId);
    const warnings: string[] = [];

    // The host: its KEL, and the binding between its AID and its did:key, pinned on first sight.
    const kel = await verifyKel(feed.kel, { allowUnwitnessed: true });
    if (!kel.ok) warnings.push("The host's key log doesn't verify.");
    if (kel.aid !== feed.host.aid) warnings.push("The feed is signed by another identifier than the host says.");
    if (!feed.binding || feed.binding.issuer !== feed.host.did || !(await verifyBinding(feed.binding, kel, this.clock)).ok) warnings.push("The host's DID isn't bound to its key log.");
    const pinKey = `agora.host.${this.host.url}`;
    const pinned = this.kv.get(pinKey);
    if (pinned && pinned !== kel.aid) warnings.push("This host's identity changed since you last read it.");
    if (!pinned && kel.ok) this.kv.set(pinKey, kel.aid);

    // The trail: every header signed by the host's key, chained, and every body matching its header.
    const trail = await verifyTrail({ kel, stream: feed.trail, bodies: feed.bodies }, { allowUnwitnessed: true });
    for (const p of trail.problems) warnings.push(`The feed doesn't verify: ${p.message}.`);
    if (trail.purpose !== `agora/forum/${forumId}`) warnings.push("The feed is for another forum.");

    // History: the entry this reader saw last must still be there.
    const headKey = `agora.head.${this.host.url}.${forumId}`;
    let historyChanged = false;
    const last = this.kv.get(headKey);
    if (last) {
      const { s, d } = JSON.parse(last) as { s: number; d: string };
      const at = trail.entries.find((e) => e.s === s && e.status !== "cut");
      if (!at || at.d !== d) historyChanged = true;
    }
    if (historyChanged) warnings.push("This host's history changed since you last read it.");
    else if (trail.ok && trail.head) this.kv.set(headKey, JSON.stringify(trail.head));

    const bodyBySaid = new Map<string, Body>(feed.bodies.map((b) => [b.d, b]));
    const hiddenBySeq = new Map(feed.hidden.map((h) => [h.s, h]));
    const policies = new Map<string, ForumPolicy>();
    let policy: ForumPolicy | undefined;
    const threads = new Map<string, ThreadView>();
    const posts = new Map<string, PostView>();
    const passes = new Map<string, { nym: string; thread: string | null; ok: boolean; why?: string }>();
    const polls = new Map<string, PollState & { byNullifier: Map<string, number> }>();
    const original = new Map<string, { status: PostStatus; body?: string; note?: string }>();
    const moderation: ModerationView[] = [];
    const reports: ReportView[] = [];
    const nyms = new Map<string, NymSummary>();
    const nymOf = (nym: string, at: string) => {
      let n = nyms.get(nym);
      if (!n) nyms.set(nym, (n = { nym, name: nymName(nym), firstAt: at, posts: 0, reports: 0, banned: null, slowed: null }));
      return n;
    };
    let descs: GroupDescriptor[] = [];
    const descById = new Map<string, GroupDescriptor>();
    let logs = new Map<string, GroupRoot[]>();

    const signed = async (doc: object) => {
      try {
        return (await verifyDocument(doc, this.clock)).valid;
      } catch {
        return false;
      }
    };
    const placeholder = (thread: string, id: string, seq: number, at: string, reason: string, nym: string): PostView => {
      let t = threads.get(thread);
      if (!t) threads.set(thread, (t = { id: thread, title: "Removed thread", scope: "forum", locked: false, posts: [], lastAt: at }));
      const deleted = reason.startsWith("Deleted");
      const v: PostView = { id, seq, thread, parent: null, nym, name: nym ? nymName(nym) : "", at, status: deleted ? "deleted" : "hidden", note: reason, reports: 0 };
      if (nym) nymOf(nym, at).posts++;
      t.posts.push(v);
      posts.set(id, v);
      return v;
    };

    for (const e of trail.entries) {
      if (e.t !== "ten" || e.status === "cut" || e.status === "invalid") continue;
      const at = e.dt;
      const body = e.a ? bodyBySaid.get(e.a) : undefined;
      if (!body) {
        const h = hiddenBySeq.get(e.s);
        if (h && e.kind === "agora/post" && h.post) placeholder(h.thread, h.post, e.s, at, h.reason, h.nym);
        continue;
      }
      const doc = (body as unknown as { doc: ForumDoc }).doc;
      if (!doc || doc.type !== e.kind) {
        warnings.push(`Entry ${e.s} isn't what its header says.`);
        continue;
      }
      if (doc.type !== "agora/vote" && !(await signed(doc))) {
        warnings.push(`Entry ${e.s} (${doc.type}) has a bad signature.`);
        continue;
      }
      switch (doc.type) {
        case "agora/forum-policy": {
          if (policy && doc.issuer !== policy.issuer) {
            warnings.push(`Entry ${e.s}: a policy change by someone other than the owner.`);
            break;
          }
          policy = doc;
          policies.set(docHash(doc), doc);
          descs = [];
          for (const g of doc.gate.anyOf) {
            const d = descById.get(g.group) ?? (await this.registrar.group(g.group).catch(() => undefined));
            if (d && (await signed(d)) && d.issuer === g.registrar) {
              descById.set(d.id, d);
              descs.push(d);
            }
          }
          logs = new Map([...logs, ...(await this.logs(descs.filter((d) => !logs.has(d.id))))]);
          break;
        }
        case "agora/nym-pass": {
          const why = await this.passOk(doc, policies, descById, logs);
          passes.set(doc.issuer, { nym: doc.nym, thread: doc.thread, ok: !why, why: why ?? undefined });
          if (why) warnings.push(`A pass for ${nymName(doc.nym)} doesn't verify: ${why}.`);
          break;
        }
        case "agora/post": {
          const p = doc as Post;
          const pass = passes.get(p.issuer);
          const ok = !!pass?.ok && pass.nym === p.nym;
          const hidden = hiddenBySeq.get(e.s);
          if (p.thread === p.id) {
            threads.set(p.id, { id: p.id, title: p.title ?? "Untitled", scope: policy?.nyms === "thread" ? "thread" : (p.nymScope ?? "forum"), locked: false, posts: [], lastAt: at });
          }
          let t = threads.get(p.thread);
          if (!t) threads.set(p.thread, (t = { id: p.thread, title: "Thread", scope: "forum", locked: false, posts: [], lastAt: at }));
          const v: PostView = {
            id: p.id,
            seq: e.s,
            thread: p.thread,
            parent: p.parent,
            title: p.title,
            body: p.body,
            nym: p.nym,
            name: nymName(p.nym),
            at,
            status: hidden ? (hidden.reason.startsWith("Deleted") ? "deleted" : "hidden") : ok ? "verified" : "unverified",
            note: hidden?.reason ?? (ok ? undefined : "Couldn't verify this post's pass."),
            reports: 0,
          };
          original.set(p.id, { status: ok ? "verified" : "unverified", body: p.body, note: v.note && !hidden ? v.note : undefined });
          if (hidden) delete v.body;
          t.posts.push(v);
          t.lastAt = at;
          posts.set(p.id, v);
          nymOf(p.nym, at).posts++;
          break;
        }
        case "agora/delete": {
          const d = doc as DeleteDoc;
          const p = posts.get(d.target);
          if (p && p.nym === d.nym && passes.get(d.issuer)?.nym === d.nym) {
            p.status = "deleted";
            p.note = "Deleted by its author.";
            delete p.body;
          }
          break;
        }
        case "agora/report": {
          const r = doc as ReportDoc;
          const target = posts.get(r.target);
          if (target) target.reports++;
          if (target?.nym) nymOf(target.nym, target.at).reports++;
          reports.push({ doc: r, seq: e.s, at, reporter: nymName(r.nym), targetNym: target?.nym });
          break;
        }
        case "agora/moderation": {
          const m = doc as Moderation;
          if (!policy?.moderators.includes(m.issuer)) {
            warnings.push(`Entry ${e.s}: a moderation action by someone who isn't a moderator.`);
            break;
          }
          moderation.push({ doc: m, seq: e.s, at, by: m.issuer });
          const p = posts.get(m.target);
          if (m.action === "hide-post" && p && p.status !== "deleted") {
            p.status = "hidden";
            p.note = `Removed by a moderator: ${m.reason}`;
            delete p.body;
          }
          const orig = original.get(m.target);
          if (m.action === "restore-post" && p && orig && p.status === "hidden" && !hiddenBySeq.has(p.seq)) {
            p.status = orig.status;
            p.body = orig.body;
            p.note = orig.note;
          }
          const t = threads.get(m.target);
          if (t && m.action === "lock-thread") t.locked = true;
          if (t && m.action === "unlock-thread") t.locked = false;
          if (m.action === "ban-nym") nymOf(m.target, at).banned = { until: m.until ?? null };
          if (m.action === "unban-nym") nymOf(m.target, at).banned = null;
          if (m.action === "slow-nym" && m.rate) nymOf(m.target, at).slowed = { ...m.rate, until: m.until ?? null };
          break;
        }
        case "agora/poll": {
          const p = doc as Poll;
          if (!policy?.moderators.includes(p.issuer)) {
            warnings.push(`Entry ${e.s}: a poll opened by someone who isn't a moderator.`);
            break;
          }
          polls.set(p.id, { poll: p, tally: p.choices.map(() => 0), votes: 0, rejected: 0, open: false, closed: false, byNullifier: new Map() });
          break;
        }
        case "agora/vote": {
          const v = doc as Vote;
          const st = polls.get(v.poll);
          if (!st) break;
          if (Date.parse(at) >= Date.parse(st.poll.closesAt)) {
            st.rejected++;
            break;
          }
          const ok = await this.voteOk(v, st.poll, descById);
          if (!ok) {
            st.rejected++;
            warnings.push(`A vote in "${st.poll.question}" doesn't verify.`);
            break;
          }
          st.byNullifier.set(v.nullifier, v.choice);
          break;
        }
      }
    }
    if (!policy) throw new Error("the feed has no forum policy");
    for (const n of nyms.values()) if (n.banned?.until && Date.parse(n.banned.until) <= this.clock.now()) n.banned = null;
    const now = this.clock.now();
    const pollList: PollState[] = [...polls.values()].map(({ byNullifier, ...st }) => {
      const tally = st.poll.choices.map(() => 0);
      for (const c of byNullifier.values()) tally[c]++;
      return { ...st, tally, votes: byNullifier.size, open: now >= Date.parse(st.poll.opensAt) && now < Date.parse(st.poll.closesAt), closed: now >= Date.parse(st.poll.closesAt) };
    });
    return {
      forumId,
      policy,
      policyHash: docHash(policy),
      descriptors: descs,
      gateWords: gateInWords(policy.gate, descs),
      host: feed.host,
      head: feed.head,
      warnings: [...new Set(warnings)],
      historyChanged,
      threads: [...threads.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt)),
      polls: pollList,
      moderation,
      reports,
      nyms,
      entries: trail.entries.length,
    };
  }

  private readonly voteCache = new Map<string, boolean>();
  private async voteOk(v: Vote, poll: Poll, descById: Map<string, GroupDescriptor>): Promise<boolean> {
    const key = JSON.stringify([v.poll, v.choice, v.nullifier, v.zk?.proof?.slice(0, 64)]);
    const c = this.voteCache.get(key);
    if (c !== undefined) return c;
    const parsed = parseMembershipProof(v.zk);
    const descs = poll.gate.anyOf.map((g) => descById.get(g.group));
    let ok = false;
    if (parsed && !gateProblem(poll.gate, descs)) {
      const expected = compileGate({
        gate: poll.gate,
        descs: descs as GroupDescriptor[],
        roots: poll.pinned.map((p) => fieldFromHex(p.root)),
        today: parsed.statement.today,
        scope: pollScope(poll.id),
        signal: voteSignal(poll.id, v.choice),
      });
      const r = await this.verifier.verify(v.zk, expected);
      ok = r.ok && fieldFromHex(v.nullifier) === r.nullifier;
      // A vote must be made on or after the poll opened, as days go.
      ok &&= parsed.statement.today >= Math.floor(Date.parse(poll.opensAt) / DAY) - 1;
    }
    this.voteCache.set(key, ok);
    return ok;
  }
}
