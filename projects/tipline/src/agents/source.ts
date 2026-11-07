/**
 * The source's side (design §7.4). Nothing here stores anything: the membership code and the tip
 * code are passed in and kept in memory only. Used by the source web app and by the tests.
 *
 *   1. loadDescriptor, checkGroup: the drop box and the group, from the outlet's mirror, cross-checked
 *      against the organization's own log if the source agrees.
 *   2. findMembership: the membership code's leaf, in the newest root that holds it.
 *   3. buildTip: proves membership, bound to this tip, and seals the submit and chunks for the relay,
 *      every message the same size.
 *   4. deliver: sends them as the tip DID.
 *   5. TipConversation: comes back with the tip code alone, reads replies, answers.
 */
import {
  checkRootLog,
  commitmentOf,
  dayOf,
  decodeMembershipCode,
  groupFieldOf,
  leafHash,
  membershipInputs,
  plainLeaf,
  treeFromRoot,
  type Field,
  type GroupRoot,
  type GroupTree,
  type MembershipProof,
  type ProveProgress,
  type Statement,
  type Witness,
} from "@zk-toip/anon-membership";
import { CoarseClock, Endpoint, RelayTransport, type Clock, type Identity } from "@zk-toip/trust-core";
import { tipKeys } from "../protocol/codes";
import { storyOf, verifyDescriptor, type Descriptor, type Story, type StoryGroup } from "../protocol/descriptor";
import {
  CHUNK,
  FRESHNESS,
  MESSAGE,
  PROOF_PRESENT,
  PROOF_REQUEST,
  RECEIPT,
  SUBMIT,
  THREAD_REQUEST,
  hexSha256,
  presentSignal,
  tipScope,
  tipSignal,
  type AttachmentInfo,
  type ChunkPayload,
  type MessagePayload,
  type ProofRequestPayload,
  type ReceiptPayload,
  type SubmitPayload,
  type TipBody,
} from "../protocol/messages";
import { chunksFor, padChunk, paddedChunkCount, sealPadded, sourceSize, splitAttachment } from "../protocol/padding";
import { extensionOf } from "../sanitize/metadata";
import { compareLogs, joinUrl, type Fetcher } from "./logs";

/** MembershipProver in Node, MembershipWorkerClient in a browser. */
export interface Prover {
  prove(statement: Statement, witness: Witness, onProgress?: (p: ProveProgress) => void): Promise<MembershipProof>;
}

export async function loadDescriptor(outletUrl: string, slug: string, fetcher: Fetcher, clock: Clock): Promise<Descriptor> {
  const d = await fetcher.json(joinUrl(outletUrl, `dropbox/${encodeURIComponent(slug)}/descriptor.json`));
  const v = await verifyDescriptor(d, clock);
  if (!v.ok) throw new Error(`the drop box's descriptor doesn't check out: ${v.why}`);
  if (v.descriptor.slug !== slug) throw new Error("the descriptor is for another drop box");
  return v.descriptor;
}

export interface GroupView {
  group: StoryGroup;
  log: GroupRoot[];
  head: GroupRoot;
  tree: GroupTree;
  /** Whether the organization's own copy of the log was fetched and matched the mirror's. */
  checkedOrganization: boolean;
}

export type GroupCheck = { ok: true; view: GroupView } | { ok: false; why: string; evidence?: [GroupRoot, GroupRoot] };

const mirrorUrl = (outletUrl: string, g: StoryGroup, path: string) => joinUrl(outletUrl, g.mirror + path);

/** Loads the group from the outlet's mirror and checks it: signatures, chain, snapshot, size, and the organization's own copy if asked. */
export async function checkGroup(o: { outletUrl: string; group: StoryGroup; fetcher: Fetcher; clock: Clock; alsoOrganization: boolean; organization?: string }): Promise<GroupCheck> {
  const g = o.group;
  let log: GroupRoot[];
  try {
    log = (await o.fetcher.json(mirrorUrl(o.outletUrl, g, "log.json"))) as GroupRoot[];
  } catch (e) {
    return { ok: false, why: `couldn't load the group from the outlet: ${e instanceof Error ? e.message : String(e)}` };
  }
  let head: GroupRoot;
  if (o.alsoOrganization) {
    let theirs: unknown;
    try {
      theirs = await o.fetcher.json(g.log);
    } catch (e) {
      return { ok: false, why: `couldn't load ${o.organization ?? "the organization"}'s own copy of the log: ${e instanceof Error ? e.message : String(e)}` };
    }
    const cmp = await compareLogs(log, theirs, g.issuer, o.clock, ["The outlet's mirror", o.organization ?? "The organization"]);
    if (!cmp.ok) return { ok: false, why: cmp.why, evidence: cmp.evidence };
    head = cmp.head;
  } else {
    const c = await checkRootLog(log, g.issuer, o.clock);
    if (!c.ok) return { ok: false, why: `the group's root log doesn't check out (${c.reason})`, evidence: c.evidence };
    head = c.head;
  }
  let tree: GroupTree;
  try {
    tree = treeFromRoot(head, await o.fetcher.bytes(mirrorUrl(o.outletUrl, g, `snapshot/${head.epoch}.bin`)));
  } catch (e) {
    return { ok: false, why: `the group's member list doesn't match its signed root: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (head.size < g.minSize) {
    return { ok: false, why: `the group has only ${head.size} members, and this drop box needs at least ${g.minSize}. In a group that small you would be easy to pick out.` };
  }
  return { ok: true, view: { group: g, log, head, tree, checkedOrganization: o.alsoOrganization } };
}

export interface Membership {
  secret: Field;
  /** The root the proof will use: the newest one holding the leaf. */
  root: GroupRoot;
  tree: GroupTree;
  /** False when the leaf is only in an older root: the member was removed since. */
  newest: boolean;
}

export type MembershipLookup = { ok: true; membership: Membership } | { ok: false; why: string };

/** Decodes the membership code and finds its leaf, searching the whole snapshot so no request names an index. */
export async function findMembership(o: { code: string; view: GroupView; outletUrl: string; fetcher: Fetcher; lookBack?: number }): Promise<MembershipLookup> {
  const g = o.view.group;
  const secret = decodeMembershipCode(o.code, g.group);
  if (secret === null) return { ok: false, why: "That code has a typo, or it is for another group. Check it against your wallet." };
  const leaf = leafHash(plainLeaf(commitmentOf(secret, groupFieldOf(g.group))));
  if (o.view.tree.indexOf(leaf) >= 0) return { ok: true, membership: { secret, root: o.view.head, tree: o.view.tree, newest: true } };
  const older = o.view.log.slice(0, -1).reverse().slice(0, o.lookBack ?? 8);
  for (const doc of older) {
    try {
      const tree = treeFromRoot(doc, await o.fetcher.bytes(mirrorUrl(o.outletUrl, g, `snapshot/${doc.epoch}.bin`)));
      if (tree.indexOf(leaf) >= 0) return { ok: true, membership: { secret, root: doc, tree, newest: false } };
    } catch {
      // The mirror keeps recent snapshots only.
    }
  }
  return { ok: false, why: `This code isn't in the group's recent roots. Only members of ${g.label} can send a tip here that proves membership.` };
}

export interface DraftFile {
  bytes: Uint8Array;
  mediaType: string;
  cleaned: "reencoded" | "none";
}

export interface BuiltTip {
  code: string;
  tipId: string;
  identity: Identity;
  dropbox: string;
  wires: Uint8Array[];
  proveMs: number;
  nullifier: string;
}

/** Proves membership for this tip and seals every message it needs, ready to send. */
export async function buildTip(o: {
  code: string;
  descriptor: Descriptor;
  story: Story;
  membership: Membership;
  body: TipBody;
  files: DraftFile[];
  prover: Prover;
  clock: Clock;
  onProgress?: (p: ProveProgress) => void;
}): Promise<BuiltTip> {
  const { identity, tipId, code } = tipKeys(o.code);
  const dropbox = o.descriptor.issuer;
  if (o.files.length > o.descriptor.limits.maxAttachments) throw new Error(`at most ${o.descriptor.limits.maxAttachments} files per tip`);
  const total = o.files.reduce((n, f) => n + f.bytes.length, 0);
  if (total > o.descriptor.limits.maxAttachmentBytes) throw new Error(`at most ${Math.round(o.descriptor.limits.maxAttachmentBytes / 1048576)} MB of files per tip`);
  const attachments: AttachmentInfo[] = o.files.map((f, i) => ({
    id: `a${i + 1}`,
    name: `attachment-${i + 1}.${extensionOf(f.mediaType)}`,
    mediaType: f.mediaType,
    bytes: f.bytes.length,
    sha256: hexSha256(f.bytes),
    chunks: chunksFor(f.bytes.length),
    cleaned: f.cleaned,
  }));
  const scope = tipScope(dropbox, o.story.id);
  const signal = tipSignal({ dropbox, story: o.story.id, tipId, replyTo: identity.did, body: o.body, attachments });
  const { statement, witness } = membershipInputs({
    secret: o.membership.secret,
    groups: [{ group: o.story.groups[0].group, tree: o.membership.tree }],
    scope,
    signal,
    today: dayOf(o.clock.now()),
  });
  const t0 = Date.now();
  const membership = await o.prover.prove(statement, witness, o.onProgress);
  const proveMs = Date.now() - t0;

  const endpoint = sealingEndpoint(identity, o.clock);
  const real: ChunkPayload[] = o.files.flatMap((f, i) => splitAttachment(tipId, attachments[i].id, f.bytes));
  const count = paddedChunkCount(real.length);
  const chunks = [...real, ...Array.from({ length: count - real.length }, (_, i) => padChunk(tipId, i, count))];
  const submit: Omit<SubmitPayload, "padding"> = { v: 1, tipId, story: o.story.id, body: o.body, attachments, chunks: count, membership };
  const wires = [await sealPadded(endpoint, dropbox, SUBMIT, submit, sourceSize)];
  for (const c of chunks) wires.push(await sealPadded(endpoint, dropbox, CHUNK, c, sourceSize));
  endpoint.close();
  return { code, tipId, identity, dropbox, wires, proveMs, nullifier: membership.nullifier };
}

/** An Endpoint that only seals. Its clock is coarse, so documents carry the hour, not the minute. */
function sealingEndpoint(identity: Identity, clock: Clock): Endpoint {
  const none = { attach() {}, detach() {}, post: async () => "undelivered" as const };
  return new Endpoint({ identity, transport: none, clock: new CoarseClock(clock), freshness: FRESHNESS });
}

async function connected(t: RelayTransport, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (t.status !== "connected") {
    if (Date.now() > end) throw new Error("couldn't reach the relay");
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function drained(t: RelayTransport, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (t.pending() > 0) {
    if (Date.now() > end) throw new Error("the relay didn't take every message");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Sends a built tip as its tip DID. The outbox is in memory only. */
export async function deliver(tip: BuiltTip, o: { relayUrl: string; webSocket?: typeof WebSocket; onSent?: (n: number, of: number) => void }): Promise<void> {
  const t = new RelayTransport({ url: o.relayUrl, identity: tip.identity, webSocket: o.webSocket });
  t.start();
  try {
    await connected(t);
    for (let i = 0; i < tip.wires.length; i++) {
      if ((await t.post(tip.identity.did, tip.dropbox, tip.wires[i])) === "undelivered") throw new Error("the relay refused a message");
      o.onSent?.(i + 1, tip.wires.length);
    }
    await drained(t);
  } finally {
    t.stop();
  }
}

export interface SourceMessage {
  id: string;
  from: "source" | "dropbox";
  text: string;
  at: string;
}

/**
 * A source back with a tip code: the same tip DID, so the same relay mailbox. It asks the drop box to
 * resend the thread, since nothing was kept from before.
 */
export class TipConversation {
  readonly tipId: string;
  readonly did: string;
  readonly messages: SourceMessage[] = [];
  receipt?: ReceiptPayload;
  proofRequest?: ProofRequestPayload;
  private readonly identity: Identity;
  private readonly transport: RelayTransport;
  private readonly endpoint: Endpoint;
  private readonly coarse: Clock;

  constructor(
    private readonly o: { code: string; descriptor: Descriptor; relayUrl: string; clock: Clock; onChange?: () => void; webSocket?: typeof WebSocket },
  ) {
    const k = tipKeys(o.code);
    this.tipId = k.tipId;
    this.identity = k.identity;
    this.did = k.identity.did;
    this.coarse = new CoarseClock(o.clock);
    this.transport = new RelayTransport({ url: o.relayUrl, identity: k.identity, webSocket: o.webSocket });
    this.endpoint = new Endpoint({ identity: k.identity, transport: this.transport, clock: this.coarse, freshness: FRESHNESS, timeoutMs: 15_000 });
    const fromDropbox = (ctx: { sender: string }) => ctx.sender === o.descriptor.issuer;
    this.endpoint.handle<ReceiptPayload, never>(RECEIPT, (doc, ctx) => {
      if (!fromDropbox(ctx) || doc.payload?.tipId !== this.tipId) return;
      this.receipt = { tipId: doc.payload.tipId, status: doc.payload.status, reason: doc.payload.reason };
      this.changed();
    });
    this.endpoint.handle<MessagePayload, never>(MESSAGE, (doc, ctx) => {
      const p = doc.payload;
      if (!fromDropbox(ctx) || p?.tipId !== this.tipId || typeof p.text !== "string" || typeof p.id !== "string") return;
      if (this.messages.some((m) => m.id === p.id)) return;
      this.messages.push({ id: p.id, from: p.from === "source" ? "source" : "dropbox", text: p.text, at: typeof p.at === "string" ? p.at : doc.issuedAt ?? "" });
      this.messages.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
      this.changed();
    });
    this.endpoint.handle<ProofRequestPayload, never>(PROOF_REQUEST, (doc, ctx) => {
      const p = doc.payload;
      if (!fromDropbox(ctx) || p?.tipId !== this.tipId || typeof p.challenge !== "string") return;
      this.proofRequest = { tipId: p.tipId, challenge: p.challenge, story: String(p.story ?? "") };
      this.changed();
    });
  }

  get status() {
    return this.transport.status;
  }

  async start(): Promise<void> {
    this.transport.start();
    await connected(this.transport);
    await this.post(THREAD_REQUEST, { tipId: this.tipId });
  }

  async send(text: string): Promise<void> {
    const t = text.trim();
    if (!t) throw new Error("write something first");
    const id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
    this.messages.push({ id, from: "source", text: t, at: this.coarse.iso() });
    this.changed();
    await this.post(MESSAGE, { tipId: this.tipId, id, text: t } satisfies MessagePayload);
  }

  /** Answers a proof request: a fresh proof for the same story, with the same nullifier, bound to the challenge. */
  async present(o: { membership: Membership; prover: Prover; onProgress?: (p: ProveProgress) => void }): Promise<void> {
    const req = this.proofRequest;
    if (!req) throw new Error("nobody asked for a proof");
    const story = storyOf(this.o.descriptor, req.story);
    if (!story) throw new Error("the drop box no longer lists that story");
    const dropbox = this.o.descriptor.issuer;
    const { statement, witness } = membershipInputs({
      secret: o.membership.secret,
      groups: [{ group: story.groups[0].group, tree: o.membership.tree }],
      scope: tipScope(dropbox, story.id),
      signal: presentSignal({ dropbox, story: story.id, tipId: this.tipId, replyTo: this.did, challenge: req.challenge }),
      today: dayOf(this.o.clock.now()),
    });
    const membership = await o.prover.prove(statement, witness, o.onProgress);
    await this.post(PROOF_PRESENT, { tipId: this.tipId, challenge: req.challenge, membership });
    this.proofRequest = undefined;
    this.changed();
  }

  /** Waits until everything sent has reached the relay. */
  flushed(): Promise<void> {
    return drained(this.transport);
  }

  close(): void {
    this.endpoint.close();
    this.transport.stop();
  }

  private async post(spec: typeof MESSAGE, payload: object): Promise<void> {
    const wire = await sealPadded(this.endpoint, this.o.descriptor.issuer, spec, payload, sourceSize);
    if ((await this.transport.post(this.did, this.o.descriptor.issuer, wire)) === "undelivered") throw new Error("the relay refused the message");
  }

  private changed(): void {
    this.o.onChange?.();
  }
}
