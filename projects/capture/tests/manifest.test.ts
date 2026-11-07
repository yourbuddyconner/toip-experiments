import { describe, expect, it } from "vitest";
import { encodeCbor, seedSigner, verifyCose1 } from "@toip-tools/cose";
import { identityFromSeed, seedFrom } from "@toip-tools/trust-core";
import {
  contentHash,
  decodeStore,
  embedStore,
  encodePngRgba,
  encodeStore,
  extractStore,
  idText,
  manifestId,
  mergeStores,
  parseManifest,
  signManifest,
  utf8,
  verifyAsset,
  withoutStore,
  emptyStore,
  type CaptureClaim,
} from "../src/core";
import { codes, jpegPhoto, photo, testWorld } from "./helpers";

const claim = (signer: string): CaptureClaim => ({
  v: 1,
  kind: "capture",
  signer,
  content: { alg: "sha-256", hash: new Uint8Array(32).fill(9), size: 10, mime: "image/jpeg", width: 4, height: 4 },
  deviceTime: 1762423333123,
  timeSource: "os-clock",
  beacons: [],
  sensor: { type: "camera", pipeline: "getUserMedia+canvas" },
  app: { name: "capture-camera", version: "0.1.0" },
  nonce: new Uint8Array(16).fill(1),
});

describe("manifests", () => {
  it("sign and verify; the id is SHA-256 of the COSE_Sign1; the claim is deterministic CBOR", async () => {
    const id = identityFromSeed(seedFrom("signer"));
    const signer = seedSigner(seedFrom("signer"), utf8(`${id.did}`));
    const { id: mid, cose } = await signManifest(claim(id.did), signer);
    expect(mid).toEqual(manifestId(cose));
    expect(idText(mid)).toMatch(/^cm1_[A-Za-z0-9_-]{43}$/);
    const p = parseManifest(cose);
    if ("error" in p) throw new Error(p.error);
    expect(p.kid).toBe(id.did);
    expect(p.claim.signer).toBe(id.did);
    expect(encodeCbor(p.claim)).toEqual(encodeCbor(claim(id.did)));
    const ok = await verifyCose1(cose, async () => [signer.publicKey]);
    expect(ok.ok).toBe(true);
    // a flipped payload bit breaks the signature
    const bad = cose.slice();
    bad[bad.length - 80] ^= 1;
    expect((await verifyCose1(bad, async () => [signer.publicKey])).ok).toBe(false);
  });

  it("a device capture verifies end to end, and the verdict depends on whom you trust", async () => {
    const w = await testWorld();
    const cam = await w.camera();
    const shot = await cam.shoot();
    await cam.anchor([shot.store], [shot.id]);
    const file = embedStore(shot.file, shot.store);
    const r = await verifyAsset(file, null, w.ctx());
    expect(codes(r, "fail")).toEqual([]);
    expect(r.verdict).toBe("verified");
    expect(r.chain[0].signer.owner?.name).toBe("Daily Planet photo desk");
    expect(r.chain[0].signer.label).toBe("Dana's laptop camera");
    expect(r.chain[0].signer.maker?.model).toBe("Capture Web Camera 0.1");
    expect(r.interval?.notBefore).toBeDefined();
    expect(r.interval?.notAfter).toBeDefined();
    // without the owner on the trust list
    const r2 = await verifyAsset(file, null, w.ctx({ trust: w.trust.filter((t) => t.did !== w.owner.did) }));
    expect(r2.verdict).toBe("untrustedIssuer");
    expect(r2.issuers.find((i) => i.role === "owner")).toMatchObject({ did: w.owner.did, trusted: false });
  });

  it("a manifest swapped onto another file fails", async () => {
    const w = await testWorld();
    const cam = await w.camera();
    const shot = await cam.shoot();
    const other = jpegPhoto(320, 192, 7);
    const r = await verifyAsset(embedStore(other, shot.store), null, w.ctx());
    expect(r.verdict).toBe("broken");
    expect(codes(r, "fail")).toContain("file.mismatch");
  });

  it("a signer that differs from the kid is refused", async () => {
    const w = await testWorld();
    const cam = await w.camera();
    const signer = await cam.signer();
    const c = { ...claim("did:keri:EOther"), content: { ...claim("").content, hash: contentHash(jpegPhoto()) } };
    const { id, cose } = await signManifest(c, signer);
    const store = emptyStore(idText(id));
    store.manifests[idText(id)] = cose;
    store.keyLogs[cam.did] = await cam.keyLog();
    const r = await verifyAsset(jpegPhoto(), encodeStore(store), w.ctx());
    expect(codes(r, "fail")).toContain("manifest.signerMismatch");
  });
});

describe("carrying the store", () => {
  it("JPEG: embedding keeps the content hash; extraction round-trips; re-embedding a grown store too", async () => {
    const w = await testWorld();
    const cam = await w.camera();
    const shot = await cam.shoot();
    const before = contentHash(shot.file);
    const file = embedStore(shot.file, shot.store);
    expect(contentHash(file)).toEqual(before);
    expect(withoutStore(file)).toEqual(shot.file);
    const back = extractStore(file)!;
    expect(encodeStore(back)).toEqual(encodeStore(shot.store));
    await cam.anchor([back], [shot.id]);
    const again = embedStore(file, back);
    expect(contentHash(again)).toEqual(before);
    expect(extractStore(again)!.anchors[shot.idText]).toHaveLength(1);
  });

  it("JPEG: a store over 64 KB spans several APP15 segments; a foreign APP15 segment is left alone", () => {
    const jpg = jpegPhoto();
    const store = emptyStore("cm1_x");
    store.manifests.big = new Uint8Array(150_000).map((_, i) => i & 255);
    const file = embedStore(jpg, store);
    expect(file.length).toBeGreaterThan(150_000);
    expect(extractStore(file)!.manifests.big).toEqual(store.manifests.big);
    // a foreign APP15 right after SOI
    const foreign = new Uint8Array([0xff, 0xef, 0x00, 0x08, ...utf8("OTHER\0")]);
    const withForeign = new Uint8Array([...jpg.subarray(0, 2), ...foreign, ...jpg.subarray(2)]);
    const emb = embedStore(withForeign, store);
    expect(withoutStore(emb)).toEqual(withForeign);
    expect(contentHash(emb)).toEqual(contentHash(withForeign));
  });

  it("PNG: the zkCp chunk goes before IDAT and leaves the content hash alone", () => {
    const png = encodePngRgba(photo(100, 70));
    const store = emptyStore("cm1_y");
    store.salts.a = new Uint8Array(16).fill(3);
    const file = embedStore(png, store);
    expect(contentHash(file)).toEqual(contentHash(png));
    expect(extractStore(file)!.salts.a).toEqual(store.salts.a);
    const idat = Buffer.from(file).indexOf("IDAT");
    const zk = Buffer.from(file).indexOf("zkCp");
    expect(zk).toBeGreaterThan(0);
    expect(zk).toBeLessThan(idat);
  });

  it("a stripped file is found in the registry by its hash", async () => {
    const w = await testWorld();
    const cam = await w.camera();
    const shot = await cam.shoot();
    await cam.anchor([shot.store], [shot.id]);
    const registry = new Map<string, Uint8Array>();
    registry.set(Buffer.from(contentHash(shot.file)).toString("hex"), encodeStore(shot.store));
    const fetch = {
      storeByHash: async (h: Uint8Array) => registry.get(Buffer.from(h).toString("hex")) ?? null,
      manifest: async () => null,
      keyLog: async () => null,
      statusList: async () => null,
      drandRound: async () => null,
    };
    const stripped = withoutStore(embedStore(shot.file, shot.store));
    const none = await verifyAsset(stripped, null, w.ctx());
    expect(none.verdict).toBe("none");
    const found = await verifyAsset(stripped, null, w.ctx({ fetch }));
    expect(found.storeSource).toBe("registry");
    expect(found.verdict).toBe("verified");
  });

  it("mergeStores keeps everything and the newer active manifest", () => {
    const a = emptyStore("cm1_a");
    a.manifests.cm1_a = Uint8Array.of(1);
    const b = emptyStore("cm1_b");
    b.manifests.cm1_b = Uint8Array.of(2);
    const m = mergeStores(a, b);
    expect(m.active).toBe("cm1_b");
    expect(Object.keys(m.manifests).sort()).toEqual(["cm1_a", "cm1_b"]);
    expect(decodeStore(encodeStore(m))).toEqual(m);
  });
});
