import {
  InMemoryReplayGuard,
  TRUST_TASK_ERROR_TYPE_URI,
  rejectWith,
  respondWith,
  type ErrorPayload,
  type FreshnessPolicy,
  type SpecPolicy,
  type TrustTaskDocument,
} from "@openvtc/trust-tasks/runtime";
import { TspConsumer, advertisedSender, newUrnUuid, packTrustTask, unpackTrustTask } from "@openvtc/trust-tasks-tsp";
import { DataIntegrityProofVerifier, signTrustTask } from "@openvtc/trust-tasks-proof";
import type { Bus, WireRecord } from "./bus";
import type { DemoClock } from "./clock";
import { resolveDidKey, type Identity } from "./identity";

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

export const OUR_SPEC_BASE = "https://zk-toip.example/spec/";

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
  private readonly bus: Bus;
  private readonly clock: DemoClock;
  private readonly timeoutMs: number;
  private readonly consumer: TspConsumer;
  private readonly verifier: DataIntegrityProofVerifier;
  private readonly handlers = new Map<string, { spec: SpecPolicy; handler: Handler<any, any> }>();
  private readonly pending = new Map<string, Pending>();

  constructor(opts: { identity: Identity; bus: Bus; clock: DemoClock; timeoutMs?: number; freshness?: FreshnessPolicy }) {
    this.identity = opts.identity;
    this.vid = opts.identity.did;
    this.bus = opts.bus;
    this.clock = opts.clock;
    this.timeoutMs = opts.timeoutMs ?? 3000;
    this.verifier = new DataIntegrityProofVerifier({ now: () => this.clock.now() });
    this.consumer = new TspConsumer({
      recipientVid: this.vid,
      decryptionKey: this.identity.encryptionSecret,
      signingKey: this.identity.signingSecret,
      resolveSender: (vid) => resolveDidKey(vid),
      guard: new InMemoryReplayGuard(),
      proofVerifier: this.verifier,
      now: () => this.clock.now(),
      ...(opts.freshness ? { freshness: opts.freshness } : {}),
    });
    this.bus.attach(this.vid, (wire, rec) => this.receive(wire, rec));
  }

  handle<P, R>(spec: SpecPolicy, handler: Handler<P, R>): void {
    this.handlers.set(spec.typeUri, { spec, handler });
  }

  /** Builds, signs and seals a request document for `to`. */
  async seal(to: string, spec: SpecPolicy, payload: unknown): Promise<Uint8Array> {
    return (await this.build(to, spec, payload)).wire;
  }

  /** Sends a one-way message. No reply is expected. */
  async notify(to: string, spec: SpecPolicy, payload: unknown): Promise<"delivered" | "undelivered"> {
    if (!this.bus.isOnline(to)) return "undelivered";
    const { wire } = await this.build(to, spec, payload);
    const rec = this.bus.send(this.vid, to, wire);
    return rec.undelivered ? "undelivered" : "delivered";
  }

  async request<P, R>(to: string, spec: SpecPolicy, payload: P): Promise<TrustTaskDocument<R>> {
    if (!this.bus.isOnline(to)) throw new TaskError("undelivered", `${to} is not reachable`);
    const { doc, wire } = await this.build(to, spec, payload);
    const answer = new Promise<TrustTaskDocument<unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(doc.id);
        reject(new TaskError("timeout", `no reply to ${spec.typeUri}`));
      }, this.timeoutMs);
      this.pending.set(doc.id, { to, resolve, reject, timer });
    });
    const rec = this.bus.send(this.vid, to, wire);
    if (rec.undelivered) {
      this.settle(doc.id, (p) => p.reject(new TaskError("undelivered", `${to} is not reachable`)));
    }
    return answer as Promise<TrustTaskDocument<R>>;
  }

  /** Processes a sealed message that arrived some other way, e.g. collected from a relay. */
  async ingest(wire: Uint8Array): Promise<void> {
    await this.receive(wire, undefined);
  }

  close(): void {
    this.bus.detach(this.vid);
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

  private pack(doc: TrustTaskDocument<unknown>, to: string): Promise<Uint8Array> {
    return packTrustTask(doc as Record<string, unknown>, {
      senderVid: this.vid,
      receiverVid: to,
      keys: {
        senderSigningKey: this.identity.signingSecret,
        senderEncryptionKey: this.identity.encryptionSecret,
        receiverEncryptionKey: resolveDidKey(to).encryptionKey,
      },
    });
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
      unpacked = await unpackTrustTask(wire, {
        recipientVid: this.vid,
        keys: {
          receiverDecryptionKey: this.identity.encryptionSecret,
          senderEncryptionKey: keys.encryptionKey,
          senderSigningKey: keys.signingKey,
        },
      });
    } catch (e) {
      if (rec) {
        rec.refused = e instanceof Error ? e.message : String(e);
        this.bus.changed();
      }
      return;
    }
    const doc = unpacked.document as unknown as TrustTaskDocument<unknown>;
    if (rec) {
      rec.opened = { by: this.vid, document: doc };
      this.bus.changed();
    }
    if (isResponseType(doc.type)) return this.onResponse(doc, sender);

    const entry = this.handlers.get(doc.type);
    if (!entry) {
      const err = rejectWith(doc, newUrnUuid(), { code: "unsupportedType", message: `no handler for ${doc.type}`, retryable: false }, () =>
        this.clock.iso(),
      );
      this.bus.send(this.vid, sender, await this.pack(this.sign(err), sender));
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
      this.bus.send(this.vid, sender, await this.consumer.packReply(received));
    }
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
