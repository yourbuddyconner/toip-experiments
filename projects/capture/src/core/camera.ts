/**
 * The camera's side (design §7.4, §8.3, §15.1): enroll with the owner, keep the device key log, sign each
 * photo, and anchor batches of manifest ids in interaction events that the witnesses receipt.
 * Browser-safe; the key pair is a WebCrypto pair whose private key can't be exported.
 */
import { webCryptoSigner as coseSigner } from "@zk-toip/cose";
import { Controller, httpWitnessClient, keyQb64, MemoryStore, verifyKel, webCryptoSigner, type StoreData, type WitnessClient } from "@zk-toip/eventlog";
import { SystemClock, type Clock, type Credential, type StatusListDoc } from "@zk-toip/trust-core";
import { fromHex, utf8 } from "./bytes";
import { batchAnchors, makeCapture, type CaptureInput } from "./capture";
import { compactFromStream, deviceDid, digestSealOf } from "./keylog";
import { kidOf, type Beacon } from "./manifest";
import type { Store } from "./store";

export interface SavedCamera {
  aid: string;
  did: string;
  label: string;
  log: StoreData;
  credentials: Credential[];
  mandate?: Record<string, unknown>;
  statusList?: StatusListDoc;
  witnesses: { aid: string; url: string }[];
}

export interface CameraOptions {
  /** The capture server, e.g. http://localhost:4350 ("" for the page's own origin). */
  base: string;
  pair: CryptoKeyPair;
  clock?: Clock;
  fetch?: typeof fetch;
}

async function call<T>(f: typeof fetch, url: string, body?: unknown): Promise<T> {
  const r = await f(url, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${r.status}`);
  return j as T;
}

export class CameraDevice {
  private constructor(
    private readonly o: Required<Pick<CameraOptions, "base" | "pair">> & { clock: Clock; fetch: typeof fetch },
    public saved: SavedCamera,
    private controller: Controller,
    private readonly store: MemoryStore,
    private readonly clients: WitnessClient[],
  ) {}

  static async enroll(label: string, opts: CameraOptions): Promise<CameraDevice> {
    const f = opts.fetch ?? ((...a) => fetch(...a));
    const clock = opts.clock ?? new SystemClock();
    const e = await call<{ nonce: string; next: string; witnesses: { aid: string; url: string }[]; bt: number }>(f, `${opts.base}/api/devices/enroll`, { label, kind: "camera" });
    const witnesses = e.witnesses.map((w) => ({ aid: w.aid, url: w.url.startsWith("/") ? `${opts.base}${w.url}` : w.url }));
    const store = new MemoryStore();
    const controller = await Controller.incept({
      hot: [await webCryptoSigner(opts.pair)],
      next: [e.next],
      witnesses: witnesses.map((w) => w.aid),
      bt: e.bt,
      data: { keyClass: "B", device: "camera" },
      store,
      clock,
    });
    const clients = witnesses.map((w) => httpWitnessClient(w.url, w.aid, { fetch: f }));
    const report = await controller.publish(clients);
    if (report.receipted.length === 0) throw new Error(`the witnesses didn't receipt the camera's key log: ${report.missing.map((m) => m.error).join("; ")}`);
    const reg = await call<{ record: { credentials: Credential[]; mandate?: Record<string, unknown> }; statusList: StatusListDoc }>(f, `${opts.base}/api/devices/${controller.aid}`, { action: "incepted" });
    const saved: SavedCamera = { aid: controller.aid, did: deviceDid(controller.aid), label, log: store.dump(), credentials: reg.record.credentials, mandate: reg.record.mandate, statusList: reg.statusList, witnesses };
    return new CameraDevice({ base: opts.base, pair: opts.pair, clock, fetch: f }, saved, controller, store, clients);
  }

  static async restore(saved: SavedCamera, opts: CameraOptions): Promise<CameraDevice> {
    const f = opts.fetch ?? ((...a) => fetch(...a));
    const clock = opts.clock ?? new SystemClock();
    const store = new MemoryStore(saved.log);
    const controller = await Controller.load(saved.aid, { hot: [await webCryptoSigner(opts.pair)], store, clock });
    const clients = saved.witnesses.map((w) => httpWitnessClient(w.url, w.aid, { fetch: f }));
    return new CameraDevice({ base: opts.base, pair: opts.pair, clock, fetch: f }, saved, controller, store, clients);
  }

  get did(): string {
    return this.saved.did;
  }

  /** The establishment event that made this camera's key current. */
  get keyRef(): number {
    return this.controller.state().estSn;
  }

  private save(): SavedCamera {
    this.saved = { ...this.saved, log: this.store.dump() };
    return this.saved;
  }

  /** The latest beacon, from the server (the verifier checks its signature later, so this needn't be trusted). */
  async beacon(): Promise<{ beacon: Beacon; sigs: Record<string, Uint8Array>; at: number } | null> {
    try {
      const b = await call<{ kind: Beacon["kind"]; round: number; randomness: string; signature: string }>(this.o.fetch, `${this.o.base}/api/drand/latest`);
      return { beacon: { kind: b.kind, round: b.round, prefix: fromHex(b.randomness).slice(0, 8) }, sigs: { [`${b.kind}:${b.round}`]: fromHex(b.signature) }, at: this.o.clock.now() };
    } catch {
      return null;
    }
  }

  /** Is this camera's key still the current one in its log (as the witnesses have it)? */
  async status(): Promise<{ current: boolean; rotatedAt?: number; events: number }> {
    const stream = await this.clients[0].query({ logId: this.saved.aid });
    const kel = await verifyKel(stream, { allowUnwitnessed: true });
    const mine = keyQb64(await webCryptoSigner(this.o.pair));
    const latest = kel.states[kel.states.length - 1];
    const current = !!latest?.keys.includes(mine);
    return { current, events: kel.events.length, ...(current ? {} : { rotatedAt: latest?.estSn }) };
  }

  async shoot(file: Uint8Array, i: Omit<CaptureInput, "file" | "signer" | "device" | "deviceTime"> & { deviceTime?: number; beacon?: Awaited<ReturnType<CameraDevice["beacon"]>> }) {
    const b = i.beacon === undefined ? await this.beacon() : i.beacon;
    const signer = await coseSigner(this.o.pair, utf8(kidOf(this.did, this.keyRef)));
    const cap = await makeCapture({ ...i, file, signer, device: this.did, deviceTime: i.deviceTime ?? this.o.clock.now(), beacons: b ? [b.beacon] : [], beaconSigs: b?.sigs ?? {} });
    cap.store.credentials.push(...this.saved.credentials);
    if (this.saved.statusList) cap.store.statusLists.push(this.saved.statusList);
    if (this.saved.mandate) cap.store.mandates.push(this.saved.mandate);
    return cap;
  }

  /** Anchors a batch of captures in one interaction event; adds each store's anchor and the fresh key log. */
  async anchor(items: { id: Uint8Array; store: Store }[]): Promise<{ event: number; witnessed: number }> {
    if (!items.length) return { event: -1, witnessed: 0 };
    const st = this.controller.state();
    const { root, anchors } = batchAnchors(
      items.map((x) => x.id),
      this.did,
      st.sn + 1,
    );
    const ixn = await this.controller.interact([digestSealOf(root)]);
    const report = await this.controller.publish(this.clients);
    this.save();
    const witnessed = report.receipted.find((r) => r.s === ixn.s)?.witnesses.length ?? 0;
    const log = await this.keyLog();
    // only a batch the witnesses took is an anchor; they refuse one signed by a key the owner retired
    const bt = this.controller.state().bt;
    items.forEach((x, k) => {
      if (witnessed >= bt) x.store.anchors[x.store.active] = [...(x.store.anchors[x.store.active] ?? []), anchors[k]];
      x.store.keyLogs[this.did] = log;
    });
    return { event: ixn.s, witnessed };
  }

  /** The key log as the witnesses hold it, in compact form with timed receipts. */
  async keyLog(): Promise<Uint8Array> {
    const stream = await this.clients[0].query({ logId: this.saved.aid });
    return (await compactFromStream(stream)).bytes;
  }

  savedState(): SavedCamera {
    return this.save();
  }
}

/** Publishes a store to the registry, so a stripped copy of the file can be found by its fingerprint. */
export async function publishStore(base: string, bytes: Uint8Array, f: typeof fetch = (...a) => fetch(...a)): Promise<{ hash: string; id: string }> {
  const r = await f(`${base}/api/stores`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: bytes as BodyInit });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}
