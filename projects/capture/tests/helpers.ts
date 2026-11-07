/** A small world for tests: three witnesses, an owner, a maker, a dev drand chain, and cameras. */
import { webCryptoSigner as coseWebCrypto, seedSigner } from "@zk-toip/cose";
import { Controller, ed25519Signer, localWitnessClient, MemoryStore, webCryptoSigner, Witness, exportBundle } from "@zk-toip/eventlog";
import { DemoClock, identityFromSeed, seedFrom, type Identity } from "@zk-toip/trust-core";
import { StatusRegistry } from "@zk-toip/mandates";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  batchAnchors,
  compactFromStream,
  devChain,
  deviceDid,
  deviceModelCredential,
  deviceOwnerCredential,
  digestSealOf,
  editorCredential,
  encodeJpegRgba,
  kidOf,
  makeCapture,
  recoveryKeys,
  roundAt,
  roundTime,
  utf8,
  type Beacon,
  type Rgba,
  type Store,
  type TrustEntry,
  type VerifyContext,
} from "../src/core";

export const T0 = "2026-11-06T10:00:00.000Z";

/** A synthetic photo: smooth gradients with some texture, so tiles differ. */
export function photo(width = 320, height = 192, seed = 1): Rgba {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      data[p] = (x * 3 + seed * 17) & 255;
      data[p + 1] = (y * 5 + ((x * y) >> 6)) & 255;
      data[p + 2] = ((x ^ y) * 7 + seed) & 255;
      data[p + 3] = 255;
    }
  return { width, height, data };
}

export const jpegPhoto = (w?: number, h?: number, seed?: number) => encodeJpegRgba(photo(w, h, seed), 92);

export async function testWorld() {
  const clock = new DemoClock(T0);
  const witnesses = [0, 1, 2].map((i) => new Witness({ signer: ed25519Signer(seedFrom(`test-witness/${i}`)), store: new MemoryStore(), clock }));
  const clients = witnesses.map(localWitnessClient);
  const ownerSeed = seedFrom("owner: Daily Planet photo desk");
  const owner = identityFromSeed(ownerSeed);
  const maker = identityFromSeed(seedFrom("maker: Capture Labs"));
  const status = new StatusRegistry(owner, clock);
  const drandKey = sha256(utf8("test drand key")).slice(0, 32);
  const drand = devChain(drandKey, Math.floor(clock.now() / 1000) - 600, 3);
  const trust: TrustEntry[] = [
    { did: maker.did, name: "Capture Labs (demo)", trustedFor: ["maker"] },
    { did: owner.did, name: "Daily Planet photo desk", trustedFor: ["owner", "editor"] },
  ];

  /** The latest dev-drand beacon at the clock's time, as the camera would fetch it. */
  const beacon = (): { beacon: Beacon; sigs: Record<string, Uint8Array> } => {
    const round = roundAt(drand.chain, clock.now());
    const r = drand.sign(round);
    return { beacon: { kind: "drand-dev", round, prefix: r.randomness.slice(0, 8) }, sigs: { [`drand-dev:${round}`]: r.signature } };
  };

  const ctx = (extra: Partial<VerifyContext> = {}): VerifyContext => ({ now: clock.now(), trust, drand: [drand.chain], ...extra });

  async function camera(label = "Dana's laptop camera", nonce = "n1") {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
    const rec = recoveryKeys(ownerSeed, nonce);
    const store = new MemoryStore();
    const controller = await Controller.incept({
      hot: [await webCryptoSigner(pair)],
      next: [rec.digest(0)],
      witnesses: witnesses.map((w) => w.aid),
      bt: 2,
      data: { messagingDid: identityFromSeed(seedFrom(`msg/${label}`)).did, keyClass: "B", device: "camera" },
      store,
      clock,
    });
    await controller.publish(clients);
    const did = deviceDid(controller.aid);
    const entry = status.allocate();
    const credentials = [
      deviceModelCredential(maker, clock, { id: did, maker: "Capture Labs (demo)", model: "Capture Web Camera 0.1", keyClass: "B", keyClassEvidence: "self-reported" }),
      deviceOwnerCredential(owner, clock, { id: did, ownerName: "Daily Planet photo desk", label, scope: ["photo"], validUntil: "2027-11-06T00:00:00Z" }, entry),
    ];
    const cam = {
      did,
      aid: controller.aid,
      controller,
      store,
      pair,
      rec,
      statusEntry: entry,
      credentials,
      label,
      signer: async (keyRef = controller.state().estSn) => coseWebCrypto(pair, utf8(kidOf(did, keyRef))),
      /** The key log as a witness has it. */
      async keyLog(): Promise<Uint8Array> {
        const stream = await clients[0].query({ logId: controller.aid });
        return (await compactFromStream(stream)).bytes;
      },
      /** Takes a photo and signs it, with a beacon; doesn't anchor. */
      async shoot(file = jpegPhoto(), opts: { deviceTime?: number; beacon?: boolean; keyRef?: number } = {}) {
        const b = opts.beacon === false ? undefined : beacon();
        const cap = await makeCapture({
          file,
          signer: await cam.signer(opts.keyRef),
          device: did,
          deviceTime: opts.deviceTime ?? clock.now(),
          beacons: b ? [b.beacon] : [],
          beaconSigs: b?.sigs,
          sensor: { type: "camera", pipeline: "getUserMedia+canvas", trackLabel: "FaceTime HD Camera" },
          app: { name: "capture-camera", version: "0.1.0", origin: "http://localhost:4350" },
        });
        cap.store.credentials.push(...credentials);
        cap.store.statusLists.push(status.sign());
        return { ...cap, file };
      },
      /** Anchors a batch of manifest ids in an interaction event and gets witness receipts. */
      async anchor(stores: Store[], ids: Uint8Array[]) {
        const st = controller.state();
        const { root, anchors } = batchAnchors(ids, did, st.sn + 1);
        await controller.interact([digestSealOf(root)]);
        clock.advance(2000);
        await controller.publish(clients);
        const log = await cam.keyLog();
        stores.forEach((s, i) => {
          s.anchors[s.active] = [...(s.anchors[s.active] ?? []), anchors[i]];
          s.keyLogs[did] = log;
        });
      },
    };
    return cam;
  }

  async function editor(name = "M. Chen", vouchedBy: Identity = owner) {
    const seed = seedFrom(`editor/${name}`);
    const id = identityFromSeed(seed);
    return {
      id,
      signer: seedSigner(seed, utf8(id.did)),
      credential: editorCredential(vouchedBy, clock, { id: id.did, name, role: "photo editor", ownerName: vouchedBy === owner ? "Daily Planet photo desk" : "Someone else" }),
    };
  }

  return { clock, witnesses, clients, owner, ownerSeed, maker, status, drand, trust, beacon, ctx, camera, editor, roundTime: (r: number) => roundTime(drand.chain, r), exportBundle };
}

export const codes = (r: { findings: { level: string; code: string }[] }, level?: string) => r.findings.filter((f) => !level || f.level === level).map((f) => f.code);
