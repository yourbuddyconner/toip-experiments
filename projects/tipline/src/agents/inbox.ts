/**
 * The journalist's inbox (design §5.1, §7.5). It runs on the journalist's device: the drop box DID is
 * its own did:key, and no server holds tips in the clear. It collects sealed messages from the relay,
 * checks each tip's membership proof against the organization's signed root log, labels sources by
 * nullifier (Source A, Source B, … per story), reassembles attachments, and replies.
 *
 * Runs in a browser page and in Node. Its state is plain JSON; attachments go to a FileStore.
 */
import {
  NullifierBook,
  acceptMembership,
  epochOf,
  fieldToHex,
  type AcceptPolicy,
  type GroupRoot,
  type MembershipVerifier,
  type NullifierBookState,
} from "@zk-toip/anon-membership";
import { CoarseClock, Endpoint, fromB64u, type Clock, type Delivery, type Identity, type Transport } from "@zk-toip/trust-core";
import { storyOf, storyOpen, type Descriptor, type Story, type StoryGroup } from "../protocol/descriptor";
import {
  CHUNK,
  FRESHNESS,
  MESSAGE,
  PROOF_PRESENT,
  PROOF_REQUEST,
  RECEIPT,
  SUBMIT,
  THREAD_REQUEST,
  REASON_TEXT,
  hexSha256,
  presentSignal,
  tipScope,
  tipSignal,
  type AttachmentInfo,
  type ChunkPayload,
  type MessagePayload,
  type ProofPresentPayload,
  type ReceiptPayload,
  type ReceiptReason,
  type SubmitPayload,
  type ThreadRequestPayload,
} from "../protocol/messages";
import { CHUNK_BYTES, chunksFor, dropboxSize, joinChunks, paddedChunkCount, sealPadded } from "../protocol/padding";
import { findMetadata, type Finding } from "../sanitize/metadata";
import { equivocation, joinUrl, type Fetcher } from "./logs";

export interface ThreadMessage {
  id: string;
  from: "source" | "dropbox";
  text: string;
  /** To the hour. */
  at: string;
}

export interface AttachmentRecord extends AttachmentInfo {
  received: number;
  status: "receiving" | "ok" | "bad";
  /** Metadata the inbox found in the file as it arrived. Empty for a clean image. */
  findings?: Finding[];
}

export interface FreshProof {
  at: string;
  ok: boolean;
  epoch?: string;
  size?: number;
  reason?: string;
}

export interface TipRecord {
  tipId: string;
  story: string;
  /** The tip DID: fresh for each tip, and where replies go. */
  from: string;
  /** The group (or groups, joined with "+") the proof was checked against. */
  group: string;
  label: string;
  /** The first tip from this source on this story. */
  firstFromSource: boolean;
  nullifier: string;
  /** The epoch of the root the proof used: "a member as of …". */
  epoch: string;
  size: number;
  receivedAt: string;
  subject: string;
  text: string;
  attachments: AttachmentRecord[];
  chunksExpected: number;
  chunksReceived: number;
  status: "receiving" | "complete";
  thread: ThreadMessage[];
  proofs: FreshProof[];
  pendingChallenge?: string;
}

export interface Refused {
  at: string;
  from: string;
  story?: string;
  tipId?: string;
  reason: ReceiptReason;
}

export interface InboxState {
  v: 1;
  descriptor?: Descriptor;
  tips: TipRecord[];
  book: NullifierBookState;
  refused: Refused[];
  /** Two signed roots for one epoch, per group, once seen. The group is refused from then on. */
  evidence: Record<string, [GroupRoot, GroupRoot]>;
}

export interface GroupStatus {
  group: string;
  label: string;
  issuer: string;
  ok: boolean;
  head?: { epoch: string; size: number; root: string; seq: number };
  why?: string;
  evidence?: [GroupRoot, GroupRoot];
}

export interface FileStore {
  put(tipId: string, attachment: string, bytes: Uint8Array): Promise<void>;
  get(tipId: string, attachment: string): Promise<Uint8Array | null>;
}

export class MemoryFiles implements FileStore {
  private readonly files = new Map<string, Uint8Array>();
  async put(tipId: string, a: string, b: Uint8Array) {
    this.files.set(`${tipId}/${a}`, b);
  }
  async get(tipId: string, a: string) {
    return this.files.get(`${tipId}/${a}`) ?? null;
  }
}

const HOLD_MS = 3_600_000;
const MAX_HELD = 512;
const MAX_TEXT = 100_000;
const TIP_ID = /^urn:tipline:[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export { REASON_TEXT };

export class InboxAgent {
  readonly endpoint: Endpoint;
  readonly did: string;
  private readonly clock: Clock;
  private readonly coarse: Clock;
  private readonly transport: Transport;
  private readonly verifier: MembershipVerifier;
  private readonly fetcher: Fetcher;
  private readonly outletUrl: string;
  private readonly files: FileStore;
  private readonly onChange?: () => void;
  private descriptor?: Descriptor;
  private readonly tips = new Map<string, TipRecord>();
  private readonly book: NullifierBook;
  private refused: Refused[];
  private readonly evidence: Record<string, [GroupRoot, GroupRoot]>;
  private readonly parts = new Map<string, Map<string, Uint8Array[]>>();
  private readonly seenChunks = new Map<string, Set<string>>();
  private held: { at: number; from: string; chunk: ChunkPayload }[] = [];
  private work: Promise<void> = Promise.resolve();

  constructor(opts: {
    identity: Identity;
    transport: Transport;
    clock: Clock;
    verifier: MembershipVerifier;
    fetcher: Fetcher;
    /** The outlet site, which serves the mirrors named in the descriptor. */
    outletUrl: string;
    state?: InboxState;
    files?: FileStore;
    onChange?: () => void;
  }) {
    this.did = opts.identity.did;
    this.clock = opts.clock;
    this.coarse = new CoarseClock(opts.clock);
    this.transport = opts.transport;
    this.verifier = opts.verifier;
    this.fetcher = opts.fetcher;
    this.outletUrl = opts.outletUrl;
    this.files = opts.files ?? new MemoryFiles();
    this.onChange = opts.onChange;
    const s = opts.state;
    this.descriptor = s?.descriptor;
    for (const t of s?.tips ?? []) this.tips.set(t.tipId, t);
    this.book = new NullifierBook(s?.book);
    this.refused = s?.refused ?? [];
    this.evidence = s?.evidence ?? {};
    this.endpoint = new Endpoint({ identity: opts.identity, transport: opts.transport, clock: this.coarse, freshness: FRESHNESS, timeoutMs: 15_000 });
    // Handlers run one at a time, so a tip's chunks never race its verification.
    const serial =
      <P>(fn: (p: P, sender: string) => Promise<void>) =>
      (doc: { payload: P; issuer?: string }, ctx: { sender: string }) => {
        const run = this.work.then(() => (doc.issuer === ctx.sender ? fn(doc.payload, ctx.sender) : this.refuse(ctx.sender, "sender")));
        this.work = run.catch(() => {});
        return run.then(() => undefined);
      };
    this.endpoint.handle(SUBMIT, serial((p: SubmitPayload, s) => this.onSubmit(p, s)));
    this.endpoint.handle(CHUNK, serial((p: ChunkPayload, s) => this.onChunk(p, s)));
    this.endpoint.handle(MESSAGE, serial((p: MessagePayload, s) => this.onMessage(p, s)));
    this.endpoint.handle(THREAD_REQUEST, serial((p: ThreadRequestPayload, s) => this.onThreadRequest(p, s)));
    this.endpoint.handle(PROOF_PRESENT, serial((p: ProofPresentPayload, s) => this.onPresent(p, s)));
  }

  // ── Reading ───────────────────────────────────────────────────────

  getDescriptor(): Descriptor | undefined {
    return this.descriptor;
  }

  setDescriptor(d: Descriptor): void {
    if (d.issuer !== this.did) throw new Error("that descriptor is another drop box's");
    this.descriptor = d;
    this.changed();
  }

  list(): TipRecord[] {
    return [...this.tips.values()].sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : 0));
  }

  tip(tipId: string): TipRecord | undefined {
    return this.tips.get(tipId);
  }

  refusals(): Refused[] {
    return [...this.refused];
  }

  file(tipId: string, attachment: string): Promise<Uint8Array | null> {
    return this.files.get(tipId, attachment);
  }

  /** Distinct members seen on a story. */
  sources(storyId: string): number {
    const story = this.descriptor && storyOf(this.descriptor, storyId);
    if (!story) return 0;
    return this.book.count(groupKey(story), tipScope(this.did, storyId));
  }

  knownEvidence(): Record<string, [GroupRoot, GroupRoot]> {
    return { ...this.evidence };
  }

  /** Fetches each open story's group logs (the organization's and the mirror's) and reports on them. */
  async groupStatus(): Promise<GroupStatus[]> {
    const groups = new Map<string, StoryGroup>();
    for (const s of this.descriptor?.stories ?? []) for (const g of s.groups) groups.set(g.group, g);
    const out: GroupStatus[] = [];
    for (const g of groups.values()) {
      const r = await this.loadLog(g);
      const head = r.log?.at(-1);
      out.push({
        group: g.group,
        label: g.label,
        issuer: g.issuer,
        ok: !!r.log && !r.evidence,
        why: r.why ?? (r.evidence ? "the organization signed two different roots for one day" : undefined),
        evidence: r.evidence,
        head: head ? { epoch: head.epoch, size: head.size, root: head.root, seq: head.seq } : undefined,
      });
    }
    return out;
  }

  state(): InboxState {
    return { v: 1, descriptor: this.descriptor, tips: this.list(), book: this.book.state(), refused: this.refused.slice(-200), evidence: this.evidence };
  }

  /** Resolves when every message received so far has been handled. */
  async idle(): Promise<void> {
    let w: Promise<void>;
    do {
      w = this.work;
      await w;
    } while (w !== this.work);
  }

  // ── Acting ────────────────────────────────────────────────────────

  async reply(tipId: string, text: string): Promise<Delivery> {
    const tip = this.mustTip(tipId);
    const t = text.trim();
    if (!t) throw new Error("write a reply first");
    const m: ThreadMessage = { id: randomId(), from: "dropbox", text: t.slice(0, MAX_TEXT), at: this.coarse.iso() };
    tip.thread.push(m);
    this.changed();
    return this.send(tip.from, MESSAGE, { tipId, id: m.id, text: m.text } satisfies MessagePayload);
  }

  /** Asks the source for a fresh proof against a newer root, with the same nullifier. */
  async requestProof(tipId: string): Promise<Delivery> {
    const tip = this.mustTip(tipId);
    tip.pendingChallenge = randomId();
    this.changed();
    return this.send(tip.from, PROOF_REQUEST, { tipId, challenge: tip.pendingChallenge, story: tip.story });
  }

  // ── Handlers ──────────────────────────────────────────────────────

  private async onSubmit(p: SubmitPayload, sender: string): Promise<void> {
    if (!p || p.v !== 1 || typeof p.tipId !== "string" || !TIP_ID.test(p.tipId)) return this.refuse(sender, "malformed");
    const tipId = p.tipId;
    if (this.tips.has(tipId)) return this.refuse(sender, "duplicate", { tipId });
    if (!p.body || typeof p.body.subject !== "string" || typeof p.body.text !== "string" || p.body.subject.length + p.body.text.length > MAX_TEXT) {
      return this.refuse(sender, "malformed", { tipId });
    }
    const d = this.descriptor;
    const story = d ? storyOf(d, p.story) : undefined;
    if (!d || !story || !storyOpen(story, epochOf(this.clock.now()))) return this.refuse(sender, "story", { tipId });
    const atts = this.checkAttachments(p, d);
    if (!atts) return this.refuse(sender, "malformed", { tipId, story: story.id });

    const logs: Record<string, GroupRoot[]> = {};
    for (const g of story.groups) {
      const r = await this.loadLog(g);
      if (r.evidence) return this.refuse(sender, "equivocation", { tipId, story: story.id });
      if (!r.log) return this.refuse(sender, "log", { tipId, story: story.id });
      logs[g.group] = r.log;
    }
    const scope = tipScope(this.did, story.id);
    const signal = tipSignal({ dropbox: this.did, story: story.id, tipId, replyTo: sender, body: p.body, attachments: atts });
    const r = await acceptMembership(p.membership, { policy: policyOf(story, d), logs, verifier: this.verifier, scope, signal, clock: this.clock });
    if (!r.ok) {
      if (r.evidence) this.evidence[story.groups[0].group] = r.evidence;
      return this.refuse(sender, r.reason, { tipId, story: story.id });
    }
    const key = groupKey(story);
    const { label, first } = this.book.label(key, scope, r.nullifier);
    const tip: TipRecord = {
      tipId,
      story: story.id,
      from: sender,
      group: key,
      label,
      firstFromSource: first,
      nullifier: fieldToHex(r.nullifier),
      epoch: r.roots[0].epoch,
      size: r.size,
      receivedAt: this.coarse.iso(),
      subject: p.body.subject,
      text: p.body.text,
      attachments: atts.map((a) => ({ ...a, received: 0, status: "receiving" })),
      chunksExpected: p.chunks,
      chunksReceived: 0,
      status: "receiving",
      thread: [],
      proofs: [],
    };
    this.tips.set(tipId, tip);
    this.changed();
    const now = this.clock.now();
    const mine = this.held.filter((h) => h.chunk.tipId === tipId && h.from === sender && now - h.at < HOLD_MS);
    this.held = this.held.filter((h) => h.chunk.tipId !== tipId && now - h.at < HOLD_MS);
    for (const h of mine) await this.addChunk(tip, h.chunk);
  }

  private checkAttachments(p: SubmitPayload, d: Descriptor): AttachmentInfo[] | null {
    if (!Array.isArray(p.attachments) || p.attachments.length > d.limits.maxAttachments) return null;
    const ids = new Set<string>();
    let chunks = 0;
    let total = 0;
    for (const a of p.attachments) {
      if (!a || typeof a.id !== "string" || !/^a\d{1,3}$/.test(a.id) || ids.has(a.id)) return null;
      if (!Number.isInteger(a.bytes) || a.bytes < 0 || a.bytes > d.limits.maxAttachmentBytes || typeof a.sha256 !== "string" || !HEX64.test(a.sha256)) return null;
      if (a.chunks !== chunksFor(a.bytes) || typeof a.mediaType !== "string" || typeof a.name !== "string") return null;
      ids.add(a.id);
      chunks += a.chunks;
      total += a.bytes;
    }
    if (total > d.limits.maxAttachmentBytes) return null;
    if (!Number.isInteger(p.chunks) || p.chunks !== paddedChunkCount(chunks)) return null;
    return p.attachments.map((a) => ({
      id: a.id,
      name: `attachment-${a.id.slice(1)}${/\.[a-z0-9]{1,5}$/.exec(a.name)?.[0] ?? ""}`,
      mediaType: a.mediaType.slice(0, 100),
      bytes: a.bytes,
      sha256: a.sha256,
      chunks: a.chunks,
      cleaned: a.cleaned === "reencoded" ? "reencoded" : "none",
    }));
  }

  private async onChunk(c: ChunkPayload, sender: string): Promise<void> {
    if (!c || typeof c.tipId !== "string" || typeof c.attachment !== "string" || !Number.isInteger(c.index) || typeof c.data !== "string") return;
    const tip = this.tips.get(c.tipId);
    if (!tip) {
      // A chunk ahead of its submit, or for a tip that was refused: held for an hour, then dropped.
      const now = this.clock.now();
      this.held = this.held.filter((h) => now - h.at < HOLD_MS).slice(-(MAX_HELD - 1));
      this.held.push({ at: now, from: sender, chunk: c });
      return;
    }
    if (tip.from !== sender) return;
    await this.addChunk(tip, c);
  }

  private async addChunk(tip: TipRecord, c: ChunkPayload): Promise<void> {
    const seen = this.seenChunks.get(tip.tipId) ?? new Set<string>();
    this.seenChunks.set(tip.tipId, seen);
    const key = `${c.attachment}/${c.index}`;
    if (seen.has(key) || tip.status === "complete") return;
    let data: Uint8Array;
    try {
      data = fromB64u(c.data);
    } catch {
      return;
    }
    if (data.length !== CHUNK_BYTES) return;
    if (c.attachment !== "pad") {
      const a = tip.attachments.find((x) => x.id === c.attachment);
      if (!a || c.index < 0 || c.index >= a.chunks || c.count !== a.chunks || a.status !== "receiving") return;
      const byAtt = this.parts.get(tip.tipId) ?? new Map<string, Uint8Array[]>();
      this.parts.set(tip.tipId, byAtt);
      const pieces = byAtt.get(a.id) ?? new Array<Uint8Array>(a.chunks);
      byAtt.set(a.id, pieces);
      pieces[c.index] = data;
      a.received++;
      if (a.received === a.chunks) {
        const bytes = joinChunks(pieces, a.bytes);
        byAtt.delete(a.id);
        a.status = hexSha256(bytes) === a.sha256 ? "ok" : "bad";
        if (a.status === "ok") {
          a.findings = findMetadata(bytes);
          await this.files.put(tip.tipId, a.id, bytes);
        }
      }
    } else if (c.index < 0 || c.index >= tip.chunksExpected) return;
    seen.add(key);
    tip.chunksReceived++;
    if (tip.chunksReceived >= tip.chunksExpected) {
      tip.status = "complete";
      this.seenChunks.delete(tip.tipId);
      this.parts.delete(tip.tipId);
      await this.sendReceipt(tip);
    }
    this.changed();
  }

  private async sendReceipt(tip: TipRecord): Promise<void> {
    const bad = tip.attachments.filter((a) => a.status !== "ok");
    const receipt: ReceiptPayload = bad.length
      ? { tipId: tip.tipId, status: "rejected", reason: "attachment", missing: bad.map((a) => ({ attachment: a.id, index: 0 })) }
      : { tipId: tip.tipId, status: "verified" };
    await this.send(tip.from, RECEIPT, receipt);
  }

  private async onMessage(p: MessagePayload, sender: string): Promise<void> {
    const tip = p && typeof p.tipId === "string" ? this.tips.get(p.tipId) : undefined;
    if (!tip || tip.from !== sender || typeof p.text !== "string" || typeof p.id !== "string") return;
    if (tip.thread.some((m) => m.id === p.id)) return;
    tip.thread.push({ id: p.id.slice(0, 64), from: "source", text: p.text.slice(0, MAX_TEXT), at: this.coarse.iso() });
    this.changed();
  }

  /** A source who came back with nothing stored asks for the thread again. */
  private async onThreadRequest(p: ThreadRequestPayload, sender: string): Promise<void> {
    const tip = p && typeof p.tipId === "string" ? this.tips.get(p.tipId) : undefined;
    if (!tip || tip.from !== sender) return;
    if (tip.status === "complete") await this.sendReceipt(tip);
    const all: ThreadMessage[] = [{ id: tip.tipId, from: "source", text: tip.subject ? `${tip.subject}\n\n${tip.text}` : tip.text, at: tip.receivedAt }, ...tip.thread];
    for (const m of all) await this.send(tip.from, MESSAGE, { tipId: tip.tipId, id: m.id, text: m.text, from: m.from, at: m.at } satisfies MessagePayload);
    if (tip.pendingChallenge) await this.send(tip.from, PROOF_REQUEST, { tipId: tip.tipId, challenge: tip.pendingChallenge, story: tip.story });
  }

  private async onPresent(p: ProofPresentPayload, sender: string): Promise<void> {
    const tip = p && typeof p.tipId === "string" ? this.tips.get(p.tipId) : undefined;
    if (!tip || tip.from !== sender || !tip.pendingChallenge || p.challenge !== tip.pendingChallenge) return;
    const d = this.descriptor!;
    const story = storyOf(d, tip.story);
    const record = (f: Omit<FreshProof, "at">) => {
      tip.proofs.push({ at: this.coarse.iso(), ...f });
      if (f.ok) tip.pendingChallenge = undefined;
      this.changed();
    };
    if (!story) return record({ ok: false, reason: REASON_TEXT.story });
    const logs: Record<string, GroupRoot[]> = {};
    for (const g of story.groups) {
      const r = await this.loadLog(g);
      if (r.evidence) return record({ ok: false, reason: REASON_TEXT.equivocation });
      if (!r.log) return record({ ok: false, reason: REASON_TEXT.log });
      logs[g.group] = r.log;
    }
    const scope = tipScope(this.did, story.id);
    const signal = presentSignal({ dropbox: this.did, story: story.id, tipId: tip.tipId, replyTo: sender, challenge: p.challenge });
    const r = await acceptMembership(p.membership, { policy: policyOf(story, d), logs, verifier: this.verifier, scope, signal, clock: this.clock });
    if (!r.ok) return record({ ok: false, reason: REASON_TEXT[r.reason] });
    if (fieldToHex(r.nullifier) !== tip.nullifier) return record({ ok: false, reason: "the fresh proof is from a different member" });
    record({ ok: true, epoch: r.roots[0].epoch, size: r.size });
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private async loadLog(g: StoryGroup): Promise<{ log?: GroupRoot[]; evidence?: [GroupRoot, GroupRoot]; why?: string }> {
    let log: GroupRoot[] | undefined;
    let why: string | undefined;
    try {
      log = (await this.fetcher.json(g.log)) as GroupRoot[];
      if (!Array.isArray(log)) throw new Error("not a log");
    } catch (e) {
      why = `couldn't fetch the organization's log: ${e instanceof Error ? e.message : String(e)}`;
      log = undefined;
    }
    const mirror = (await this.fetcher.json(joinUrl(this.outletUrl, g.mirror + "log.json")).catch(() => null)) as GroupRoot[] | null;
    const ev = await equivocation([...(log ?? []), ...(Array.isArray(mirror) ? mirror : [])], g.issuer, this.clock);
    if (ev && !this.evidence[g.group]) {
      this.evidence[g.group] = ev;
      this.changed();
    }
    return { log, evidence: this.evidence[g.group], why };
  }

  private async refuse(from: string, reason: ReceiptReason, x: { tipId?: string; story?: string } = {}): Promise<void> {
    this.refused.push({ at: this.coarse.iso(), from, reason, ...x });
    this.refused = this.refused.slice(-200);
    this.changed();
    if (x.tipId) await this.send(from, RECEIPT, { tipId: x.tipId, status: "rejected", reason } satisfies ReceiptPayload).catch(() => {});
  }

  private async send(to: string, spec: typeof MESSAGE, payload: object): Promise<Delivery> {
    const wire = await sealPadded(this.endpoint, to, spec, payload, dropboxSize);
    return this.transport.post(this.did, to, wire);
  }

  private mustTip(tipId: string): TipRecord {
    const t = this.tips.get(tipId);
    if (!t) throw new Error("no such tip");
    return t;
  }

  private changed(): void {
    this.onChange?.();
  }
}

function groupKey(story: Story): string {
  return story.groups.map((g) => g.group).join("+");
}

/** The acceptance policy for a story: its groups, pinned circuits, the strictest window and size. */
export function policyOf(story: Story, d: Descriptor): AcceptPolicy {
  return {
    groups: story.groups.map((g) => ({ group: g.group, issuer: g.issuer })),
    vkHashes: d.circuits.map((c) => c.vkHash),
    maxEpochAge: Math.min(...story.groups.map((g) => g.maxEpochAge)),
    minSize: Math.max(...story.groups.map((g) => g.minSize)),
  };
}

function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
}
