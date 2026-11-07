/**
 * Watches a simulated world and writes its Trace: every frame on the air and who heard it, every hop over
 * the internet or by hand, the mesh's own events (packets built, retries, receipts), and the narration.
 * For each Trust Task message it also measures three sizes: sealed as standard JSON TSP, sealed with the
 * CTT1 body, and as the radio packet. It can, because in the simulator it holds everyone's keys.
 */
import { pack, unpack } from "@openvtc/vti-tsp-js";
import { decodeFrame, estimate, type MeshEvent } from "@zk-toip/mesh-transport";
import type { SimMedium } from "@zk-toip/mesh-transport/sim";
import { decodeBody, encodeBody, jsonBody, resolveDidKey, type Identity, type Transport } from "@zk-toip/trust-core";
import { fmtBytes, fmtMs, type MessageSizes, type Tone, type Trace, type TraceFrame, type TraceHop, type TraceLog, type TraceNode } from "./trace";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const KINDS = ["", "pair", "intro", "via", "down", "receipt", "raw", "public"];

/** "https://zk-toip.example/spec/mesh-demo/door/open/0.1#response" → "door/open response". */
export function shortType(type: string): string {
  const [base, frag] = type.split("#");
  const m = /\/spec\/(?:mesh-demo\/)?(.+)\/\d+\.\d+$/.exec(base);
  const name = m ? m[1] : base.split("/").slice(-2).join("/");
  return frag === "response" ? `${name} response` : frag ? `${name} ${frag}` : name;
}

export interface RecorderHooks {
  onLog?: (l: TraceLog) => void;
  onFrame?: (f: TraceFrame) => void;
  onHop?: (h: TraceHop) => void;
}

interface Pending {
  from: string;
  to: string;
  wireBytes: number;
  sizes: MessageSizes;
}

export class Recorder {
  readonly nodes: TraceNode[] = [];
  readonly links: [string, string][] = [];
  readonly frames: TraceFrame[] = [];
  readonly hops: TraceHop[] = [];
  readonly log: TraceLog[] = [];
  retries = 0;
  readonly t0: number;
  private readonly byDid = new Map<string, { node: string; identity: Identity }>();
  private readonly pending: Pending[] = [];
  private attackers = new Set<string>();
  private seenRecords = 0;
  private medium?: SimMedium;

  constructor(
    private readonly clock: { now(): number },
    private readonly hooks: RecorderHooks = {},
  ) {
    this.t0 = clock.now();
  }

  get now(): number {
    return this.clock.now() - this.t0;
  }

  node(n: TraceNode, identity?: Identity): void {
    this.nodes.push(n);
    if (identity) this.byDid.set(identity.did, { node: n.id, identity });
  }

  /** Someone known to the recorder but not on the air (a party online at home). */
  identity(nodeId: string, identity: Identity): void {
    this.byDid.set(identity.did, { node: nodeId, identity });
  }

  link(a: string, b: string): void {
    this.links.push([a, b]);
  }

  nodeOf(did: string): string | undefined {
    return this.byDid.get(did)?.node;
  }

  /** Frames from these nodes are marked as an attacker's. */
  attacker(nodeId: string): void {
    this.attackers.add(nodeId);
  }

  watch(medium: SimMedium): void {
    this.medium = medium;
    medium.subscribe(() => this.drain());
  }

  private drain(): void {
    const recs = this.medium!.records();
    for (; this.seenRecords < recs.length; this.seenRecords++) {
      const r = recs[this.seenRecords];
      const f = decodeFrame(r.bytes);
      const base = { at: r.atMs - this.t0, from: r.from, airtimeMs: r.airtimeMs, bytes: r.bytes.length, heard: r.results.map((x) => ({ ...x })), ...(this.attackers.has(r.from) ? { attack: true } : {}) };
      let tf: TraceFrame;
      if (!f) tf = { ...base, type: "junk", label: "junk" };
      else if (f.type === "data") {
        const kind = f.index === 0 ? KINDS[f.chunk[0]] : undefined;
        tf = { ...base, type: "data", label: `DATA ${f.index + 1}/${f.count}`, pid: hex(f.pid), index: f.index, count: f.count, ...(kind ? { packet: kind } : {}) };
      } else if (f.type === "ack") {
        const got = Array.from({ length: f.count }, (_, i) => (f.bitmap[i >> 3] >> (i & 7)) & 1).reduce((a, b) => a + b, 0);
        tf = { ...base, type: "ack", label: got === f.count ? `ACK all ${f.count}` : `ACK ${got} of ${f.count}`, pid: hex(f.pid), count: f.count };
      } else tf = { ...base, type: "beacon", label: `BEACON ${f.role === "verifier" ? "door" : "gateway"}${f.hops ? " (repeated)" : ""}` };
      this.frames.push(tf);
      this.hooks.onFrame?.(tf);
    }
  }

  say(who: string, text: string, tone: Tone = "info", sizes?: MessageSizes): TraceLog {
    const l: TraceLog = { at: this.now, who, text, tone, ...(sizes ? { sizes } : {}) };
    this.log.push(l);
    this.hooks.onLog?.(l);
    return l;
  }

  hop(from: string, to: string, via: TraceHop["via"], bytes: number, label: string): void {
    const h: TraceHop = { at: this.now, from, to, via, bytes, label };
    this.hops.push(h);
    this.hooks.onHop?.(h);
  }

  /** Wraps a node's transport: every message it posts is measured before it goes. */
  tap(t: Transport): Transport {
    return {
      attach: (vid, fn) => t.attach(vid, fn),
      detach: (vid) => t.detach(vid),
      post: async (from, to, wire) => {
        const sizes = await this.measure(from, to, wire);
        if (sizes) this.pending.push({ from, to, wireBytes: wire.length, sizes });
        return t.post(from, to, wire);
      },
    };
  }

  /** The mesh's events for one node. */
  events(nodeId: string, mtu = 250, airtimeMs?: (n: number) => number): (e: MeshEvent) => void {
    return (e) => {
      switch (e.type) {
        case "packet-out": {
          const i = this.pending.findIndex((p) => p.from === e.from && p.to === e.to && p.wireBytes === e.wireBytes);
          const p = i >= 0 ? this.pending.splice(i, 1)[0] : undefined;
          const sizes: MessageSizes | undefined = p
            ? {
                ...p.sizes,
                packet: { kind: e.kind, bytes: e.bytes, frames: e.frames, route: e.route },
                jsonFrames: estimate(e.bytes + (p.sizes.jsonSealed - p.sizes.compactSealed), { mtu, airtimeMs: airtimeMs ?? (() => 0) }).frames,
              }
            : undefined;
          const what = sizes?.what ?? "a message";
          this.say(
            nodeId,
            `${what} → ${this.nodeOf(e.to) ?? "?"}: ${e.kind.toUpperCase()} packet, ${fmtBytes(e.bytes)} in ${e.frames} frames, pid ${e.pid}${e.route === "gateway" ? ", for the gateway" : e.route === "flood" ? ", flooded" : ""}`,
            "info",
            sizes,
          );
          return;
        }
        case "retry":
          this.retries++;
          this.say(nodeId, `resends ${e.missing.length === 1 ? `fragment ${e.missing[0] + 1}` : `fragments ${e.missing.map((m) => m + 1).join(", ")}`} of pid ${e.pid} (round ${e.round + 1})`, "warn");
          return;
        case "custody":
          this.say(nodeId, `custody receipt for pid ${e.pid}, signed by ${this.nodeOf(e.gateway) ?? "the gateway"}: post() → "queued"`, "ok");
          return;
        case "queued":
          if (e.reason === "no-route") {
            const i = this.pending.findIndex((p) => this.byDid.get(p.from)?.node === nodeId);
            const p = i >= 0 ? this.pending.splice(i, 1)[0] : undefined;
            this.say(nodeId, `${p ? `${p.sizes.what} → ${this.nodeOf(p.to) ?? "?"}: ` : ""}no route (no gateway heard), so it waits in the outbox`, "warn", p?.sizes);
          }
          else if (e.reason === "no-airtime") this.say(nodeId, "waiting for airtime within the budget", "warn");
          else this.say(nodeId, `no answer yet for pid ${e.pid}: kept in the outbox`, "warn");
          return;
        case "budget":
          if (e.warning) this.say(nodeId, e.warning, "warn");
          return;
        default:
          return;
      }
    };
  }

  /** The message sealed both ways. Undefined if we don't hold the receiver's key. */
  private async measure(from: string, to: string, wire: Uint8Array): Promise<MessageSizes | undefined> {
    const sender = this.byDid.get(from)?.identity;
    const receiver = this.byDid.get(to)?.identity;
    if (!sender || !receiver) return undefined;
    try {
      const s = resolveDidKey(from);
      const m = await unpack(wire, { receiverDecryptionKey: receiver.encryptionSecret, senderEncryptionKey: s.encryptionKey, senderSigningKey: s.signingKey });
      const ctx = { sender: from, receiver: to };
      const doc = decodeBody(m.payload, ctx);
      const asJson = await pack(encodeBody(doc, ctx, jsonBody), from, to, {
        senderSigningKey: sender.signingSecret,
        senderEncryptionKey: sender.encryptionSecret,
        receiverEncryptionKey: receiver.encryptionPublic,
      });
      return { what: shortType(doc.type), jsonSealed: asJson.bytes.length, compactSealed: wire.length };
    } catch {
      return undefined;
    }
  }

  airtime(): number {
    return this.frames.reduce((s, f) => s + f.airtimeMs, 0);
  }

  trace(meta: Omit<Trace, "nodes" | "links" | "frames" | "hops" | "log" | "durationMs" | "summary"> & { ok: boolean; facts: Trace["summary"]["facts"] }): Trace {
    this.drain();
    const { ok, facts, ...rest } = meta;
    return {
      ...rest,
      durationMs: this.now,
      nodes: this.nodes,
      links: this.links,
      frames: this.frames,
      hops: this.hops,
      log: this.log,
      summary: { ok, airtimeMs: this.airtime(), frames: this.frames.length, retries: this.retries, bytesOnAir: this.frames.reduce((s, f) => s + f.bytes, 0), facts },
    };
  }
}

export { fmtBytes, fmtMs };
