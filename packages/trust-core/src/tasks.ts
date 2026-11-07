import {
  InMemoryReplayGuard,
  type ReplayGuard,
  TRUST_TASK_ERROR_TYPE_URI,
  rejectWith,
  respondWith,
  type ErrorPayload,
  type FreshnessPolicy,
  type SpecPolicy,
  type TrustTaskDocument,
} from "@openvtc/trust-tasks/runtime";
import { TspConsumer, TspEnvelopeError, TspTransport, advertisedSender, newUrnUuid, packTrustTask, type Unpacked } from "@openvtc/trust-tasks-tsp";
import { pack as packTsp, unpack as unpackTsp, type UnpackKeys } from "@openvtc/vti-tsp-js";
import { DataIntegrityProofVerifier, signTrustTask } from "@openvtc/trust-tasks-proof";
import type { WireRecord } from "./bus.js";
import type { Clock } from "./clock.js";
import type { Delivery, Transport } from "./transport.js";
import { resolveDidKey, type Identity } from "./identity.js";
import { BodyError, decodeBody, encodeBody, type BodyCodec } from "./compact.js";

/** A handler returns this to refuse a request. It becomes a signed trust-task-error. */
export class Refusal {
  constructor(
    readonly code: string,
    readonly message: string,
  ) {}
}

export class TaskError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TaskError";
  }
}

export type Handler<P, R> = (
  doc: TrustTaskDocument<P>,
  ctx: { sender: string },
) => Promise<R | Refusal | void> | R | Refusal | void;

export const OUR_SPEC_BASE = "https://toip.tools/spec/";

/** A spec in our own namespace. `name` may include a family, e.g. "todo/op". */
export function ourSpec(name: string): SpecPolicy {
  return {
    typeUri: `${OUR_SPEC_BASE}${name}/0.1`,
    isBearer: false,
    isProofRequired: true,
    isRecipientRequired: true,
    isIssuedAtRequired: true,
  };
}

/** One message this endpoint sent or received, for an inspector. */
export interface Traffic {
  direction: "in" | "out";
  peer: string;
  document: TrustTaskDocument<unknown>;
  bytes: number;
  at: string;
  delivery?: Delivery;
}

interface Pending {
  to: string;
  resolve: (doc: TrustTaskDocument<unknown>) => void;
  reject: (e: TaskError) => void;
  timer: ReturnType<typeof setTimeout>;
}

const isResponseType = (t: string) => t.endsWith("#response") || t.split("#")[0] === TRUST_TASK_ERROR_TYPE_URI;

/**
 * Sends and receives Trust Task documents as real TSP Direct messages.
 * Every document it sends carries a Data Integrity proof by its identity, responses included.
 */
export class Endpoint {
  readonly vid: string;
  private readonly identity: Identity;
  private readonly transport: Transport;
  private readonly clock: Clock;
  private readonly onTraffic?: (t: Traffic) => void;
  private readonly timeoutMs: number;
  private readonly consumer: TspConsumer;
  private readonly verifier: DataIntegrityProofVerifier;
  private readonly handlers = new Map<string, { spec: SpecPolicy; handler: Handler<any, any> }>();
  private readonly pending = new Map<string, Pending>();
  private readonly bodyCodecFor?: (to: string) => BodyCodec | undefined;

  constructor(opts: {
    identity: Identity;
    transport: Transport;
    clock: Clock;
    timeoutMs?: number;
    freshness?: FreshnessPolicy;
    onTraffic?: (t: Traffic) => void;
    /** The body format to seal for `to`. Undefined (the default) means the standard JSON body. Every Endpoint reads both. */
    bodyCodecFor?: (to: string) => BodyCodec | undefined;
    /** The duplicate-execution record. Defaults to one in memory; a PersistentReplayGuard keeps it across restarts. */
    replayGuard?: ReplayGuard;
  }) {
    this.identity = opts.identity;
    this.vid = opts.identity.did;
    this.transport = opts.transport;
    this.onTraffic = opts.onTraffic;
    this.clock = opts.clock;
    this.timeoutMs = opts.timeoutMs ?? 3000;
    this.bodyCodecFor = opts.bodyCodecFor;
    this.verifier = new DataIntegrityProofVerifier({ now: () => this.clock.now() });
    this.consumer = new TspConsumer({
      recipientVid: this.vid,
      decryptionKey: this.identity.encryptionSecret,
      signingKey: this.identity.signingSecret,
      resolveSender: (vid) => resolveDidKey(vid),
      guard: opts.replayGuard ?? new InMemoryReplayGuard(),
      proofVerifier: this.verifier,
      now: () => this.clock.now(),
      ...(opts.freshness ? { freshness: opts.freshness } : {}),
    });
    // The in-memory Bus passes its record as a second argument; other transports pass only the wire.
    this.transport.attach(this.vid, (wire: Uint8Array, rec?: WireRecord) => this.receive(wire, rec));
  }

  handle<P, R>(spec: SpecPolicy, handler: Handler<P, R>): void {
    this.handlers.set(spec.typeUri, { spec, handler });
  }

  /** Builds, signs and seals a request document for `to`. */
  async seal(to: string, spec: SpecPolicy, payload: unknown): Promise<Uint8Array> {
    return (await this.build(to, spec, payload)).wire;
  }

  /** Sends a one-way message. No reply is expected. */
  async notify(to: string, spec: SpecPolicy, payload: unknown): Promise<Delivery> {
    const { doc, wire } = await this.build(to, spec, payload);
    return this.post(to, wire, doc);
  }

  private async post(to: string, wire: Uint8Array, doc: TrustTaskDocument<unknown>): Promise<Delivery> {
    const delivery = await this.transport.post(this.vid, to, wire);
    this.onTraffic?.({ direction: "out", peer: to, document: doc, bytes: wire.length, at: this.clock.iso(), delivery });
    return delivery;
  }

  /** Sends a request and waits for its response. `opts.timeoutMs` overrides the endpoint's default for this call. */
  async request<P, R>(to: string, spec: SpecPolicy, payload: P, opts?: { timeoutMs?: number }): Promise<TrustTaskDocument<R>> {
    const { doc, wire } = await this.build(to, spec, payload);
    const answer = new Promise<TrustTaskDocument<unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(doc.id);
        reject(new TaskError("timeout", `no reply to ${spec.typeUri}`));
      }, opts?.timeoutMs ?? this.timeoutMs);
      this.pending.set(doc.id, { to, resolve, reject, timer });
    });
    if ((await this.post(to, wire, doc)) === "undelivered") {
      this.settle(doc.id, (p) => p.reject(new TaskError("undelivered", `${to} is not reachable`)));
    }
    return answer as Promise<TrustTaskDocument<R>>;
  }

  /** Processes a sealed message that arrived some other way, e.g. collected from a relay. */
  async ingest(wire: Uint8Array): Promise<void> {
    await this.receive(wire, undefined);
  }

  close(): void {
    this.transport.detach(this.vid);
    for (const id of [...this.pending.keys()]) this.settle(id, (p) => p.reject(new TaskError("closed", "endpoint closed")));
  }

  private async build(to: string, spec: SpecPolicy, payload: unknown) {
    const doc: TrustTaskDocument<unknown> = {
      id: newUrnUuid(),
      type: spec.typeUri,
      issuer: this.vid,
      recipient: to,
      issuedAt: this.clock.iso(),
      payload,
    };
    const signed = signTrustTask(doc, this.identity.signer, { created: this.clock.date() });
    const wire = await this.pack(signed, to);
    return { doc: signed, wire };
  }

  private async pack(doc: TrustTaskDocument<unknown>, to: string): Promise<Uint8Array> {
    const codec = this.bodyCodecFor?.(to);
    if (codec) {
      const body = encodeBody(doc, { sender: this.vid, receiver: to }, codec);
      const keys = {
        senderSigningKey: this.identity.signingSecret,
        senderEncryptionKey: this.identity.encryptionSecret,
        receiverEncryptionKey: this.recipientKey(to),
      };
      return (await packTsp(body, this.vid, to, keys)).bytes;
    }
    return packTrustTask(doc as Record<string, unknown>, {
      senderVid: this.vid,
      receiverVid: to,
      keys: {
        senderSigningKey: this.identity.signingSecret,
        senderEncryptionKey: this.identity.encryptionSecret,
        receiverEncryptionKey: this.recipientKey(to),
      },
    });
  }

  private recipientKey(to: string): Uint8Array {
    try {
      return resolveDidKey(to).encryptionKey;
    } catch {
      throw new TaskError("undelivered", `can't resolve ${to}`);
    }
  }

  private settle(id: string, fn: (p: Pending) => void): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    fn(p);
  }

  private async receive(wire: Uint8Array, rec: WireRecord | undefined): Promise<void> {
    const sender = advertisedSender(wire);
    let unpacked;
    try {
      if (!sender) throw new Error("no sender");
      const keys = resolveDidKey(sender);
      unpacked = await this.open(wire, {
        receiverDecryptionKey: this.identity.encryptionSecret,
        senderEncryptionKey: keys.encryptionKey,
        senderSigningKey: keys.signingKey,
      });
    } catch (e) {
      if (rec) {
        rec.refused = e instanceof Error ? e.message : String(e);
        this.touched();
      }
      return;
    }
    const doc = unpacked.document as unknown as TrustTaskDocument<unknown>;
    if (rec) {
      rec.opened = { by: this.vid, document: doc };
      this.touched();
    }
    this.onTraffic?.({ direction: "in", peer: sender, document: doc, bytes: wire.length, at: this.clock.iso() });
    if (isResponseType(doc.type)) return this.onResponse(doc, sender);

    const entry = this.handlers.get(doc.type);
    if (!entry) {
      const err = rejectWith(doc, newUrnUuid(), { code: "unsupportedType", message: `no handler for ${doc.type}`, retryable: false }, () =>
        this.clock.iso(),
      );
      const signed = this.sign(err);
      await this.post(sender, await this.pack(signed, sender), signed);
      return;
    }
    const received = await this.consumer.consume(unpacked, entry.spec, async (d, parties) => {
      const result = await entry.handler(d, { sender: parties.issuer ?? sender });
      if (result === undefined) return undefined;
      if (result instanceof Refusal) {
        const payload: ErrorPayload = { code: result.code, message: result.message, retryable: false };
        return this.sign(rejectWith(d, newUrnUuid(), payload, () => this.clock.iso()));
      }
      return this.sign(respondWith(d, newUrnUuid(), result, () => this.clock.iso()));
    });
    if (received.reply !== undefined) {
      const reply = JSON.parse(new TextDecoder().decode(received.reply)) as TrustTaskDocument<unknown>;
      const replyWire = this.bodyCodecFor?.(sender) ? await this.pack(reply, sender) : await this.consumer.packReply(received);
      await this.post(sender, replyWire, reply);
    }
  }

  /** unpackTrustTask, except that the body may be JSON or CTT1 (chosen by its first byte). The same failures. */
  private async open(wire: Uint8Array, keys: UnpackKeys): Promise<Unpacked<unknown>> {
    let message;
    try {
      message = await unpackTsp(wire, keys);
    } catch (cause) {
      throw new TspEnvelopeError("notForThisReceiver", String(cause), undefined, { cause });
    }
    if (message.messageType !== "direct") {
      throw new TspEnvelopeError("notFinalRecipient", `message is ${message.messageType}, not a Direct Trust Task envelope`, message.sender);
    }
    let document: TrustTaskDocument<unknown>;
    try {
      document = decodeBody(message.payload, { sender: message.sender, receiver: message.receiver });
    } catch (e) {
      if (e instanceof BodyError) throw new TspEnvelopeError(e.failure, e.message, message.sender, { cause: e });
      throw e;
    }
    return { document, transport: new TspTransport(message.receiver || this.vid, message.sender) };
  }

  /** Lets the in-memory Bus tell its listeners that a record it holds was opened or refused. */
  private touched(): void {
    (this.transport as { changed?: () => void }).changed?.();
  }

  private sign<P>(doc: TrustTaskDocument<P>): TrustTaskDocument<P> {
    return signTrustTask(doc, this.identity.signer, { created: this.clock.date() });
  }

  private async onResponse(doc: TrustTaskDocument<unknown>, sender: string): Promise<void> {
    const id = doc.threadId;
    const p = id ? this.pending.get(id) : undefined;
    if (!id || !p || p.to !== sender) return;
    if (doc.proof && !(await this.verifier.verify(doc))) {
      this.settle(id, (q) => q.reject(new TaskError("proofInvalid", "response proof does not verify")));
      return;
    }
    if (doc.type.split("#")[0] === TRUST_TASK_ERROR_TYPE_URI) {
      const e = doc.payload as ErrorPayload;
      this.settle(id, (q) => q.reject(new TaskError(e.code, e.message ?? e.code)));
      return;
    }
    this.settle(id, (q) => q.resolve(doc));
  }
}
