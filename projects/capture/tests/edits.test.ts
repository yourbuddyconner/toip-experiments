import { describe, expect, it } from "vitest";
import { identityFromSeed, seedFrom } from "@toip-tools/trust-core";
import {
  checkTiles,
  commitTiles,
  decodePngReference,
  embedStore,
  encodePngRgba,
  extractStore,
  idBytes,
  idText,
  makeEdit,
  proveTiles,
  redact,
  crop,
  sha,
  signManifest,
  snapCrop,
  verifyAsset,
  withoutStore,
  contentHash,
  type EditClaim,
} from "../src/core";
import { codes, photo, testWorld } from "./helpers";

async function shotAndEdit(opts: { crop?: boolean } = {}) {
  const w = await testWorld();
  const cam = await w.camera();
  const shot = await cam.shoot();
  await cam.anchor([shot.store], [shot.id]);
  const ed = await w.editor();
  const edit = await makeEdit({
    original: shot.file,
    store: shot.store,
    tileKey: shot.tileKey,
    regions: [{ x: 70, y: 40, w: 50, h: 60 }],
    method: "pixelate-16",
    reason: "protect a bystander's identity",
    ...(opts.crop ? { crop: { x: 70, y: 10, w: 200, h: 150 } } : {}),
    signer: ed.signer,
    editor: ed.id.did,
    deviceTime: w.clock.now(),
    extra: { credentials: [ed.credential] },
  });
  return { w, cam, shot, ed, edit };
}

describe("edit chains", () => {
  it("a valid chain: the redacted PNG verifies back to the device, with a tile proof", async () => {
    const { w, edit } = await shotAndEdit();
    const r = await verifyAsset(edit.file, null, w.ctx());
    expect(codes(r, "fail")).toEqual([]);
    expect(r.verdict).toBe("verified");
    expect(r.chain.map((s) => s.kind)).toEqual(["edit", "capture"]);
    expect(r.chain[0].signer.name).toBe("M. Chen");
    expect(r.chain[0].redactions?.[0].reason).toBe("protect a bystander's identity");
    const t = r.chain[0].tiles!;
    // 5 × 3 tiles; the region (70..120, 40..100) touches tiles (1,0) (1,1) — 2 tiles
    expect(t.total).toBe(15);
    expect(t.redacted).toBe(2);
    expect(t.kept).toBe(13);
    expect(codes(r, "ok")).toContain("tiles.ok");
  });

  it("a grid-snapped crop keeps the proof; cropped-away tiles are counted", async () => {
    const { w, edit } = await shotAndEdit({ crop: true });
    const r = await verifyAsset(edit.file, null, w.ctx());
    expect(codes(r, "fail")).toEqual([]);
    const t = r.chain[0].tiles!;
    // crop snapped to (64, 0)–(320, 192): 4 × 3 tiles kept or redacted, column 0 cropped
    expect(t.cropped).toBe(3);
    expect(t.kept + t.redacted).toBe(12);
    expect(r.chain[0].content.width).toBe(256);
  });

  it("a broken parent: the edit names a parent whose fingerprint doesn't match", async () => {
    const { w, shot, ed } = await shotAndEdit();
    const png = encodePngRgba(photo());
    const claim: EditClaim = {
      v: 1,
      kind: "edit",
      signer: ed.id.did,
      parents: [{ manifest: idBytes(shot.idText), content: new Uint8Array(32).fill(1), relationship: "parentOf" }],
      actions: [{ action: "c2pa.opened" }],
      tool: { name: "t", version: "1" },
      content: { alg: "sha-256", hash: contentHash(png), size: png.length, mime: "image/png" },
      deviceTime: w.clock.now(),
      beacons: [],
      nonce: new Uint8Array(16),
    };
    const { id, cose } = await signManifest(claim, ed.signer);
    const store = { ...shot.store, active: idText(id), manifests: { ...shot.store.manifests, [idText(id)]: cose }, credentials: [...shot.store.credentials, ed.credential] };
    const r = await verifyAsset(embedStore(png, store), null, w.ctx());
    expect(r.verdict).toBe("broken");
    expect(codes(r, "fail")).toContain("chain.parentMismatch");
  });

  it("an editor nobody trusted vouches for: warned, not verified", async () => {
    const w = await testWorld();
    const cam = await w.camera();
    const shot = await cam.shoot();
    await cam.anchor([shot.store], [shot.id]);
    const stranger = identityFromSeed(seedFrom("stranger"));
    const ed = await w.editor("Mallory", stranger);
    const edit = await makeEdit({ original: shot.file, store: shot.store, tileKey: shot.tileKey, regions: [], method: "fill-black", signer: ed.signer, editor: ed.id.did, deviceTime: w.clock.now(), extra: { credentials: [ed.credential] } });
    const r = await verifyAsset(edit.file, null, w.ctx());
    expect(codes(r, "warn")).toContain("edit.editorNotAuthorized");
    expect(r.verdict).toBe("verifiedWithWarnings");
    // and with no credential at all
    const ed2 = await w.editor("Nobody");
    const edit2 = await makeEdit({ original: shot.file, store: shot.store, tileKey: shot.tileKey, regions: [], method: "fill-black", signer: ed2.signer, editor: ed2.id.did, deviceTime: w.clock.now() });
    expect(codes(await verifyAsset(edit2.file, null, w.ctx()), "warn")).toContain("edit.editorNotAuthorized");
  });

  it("a missing parent is 'chain incomplete'; a tampered edit output is 'doesn't match'", async () => {
    const { w, shot, edit } = await shotAndEdit();
    const store = extractStore(edit.file)!;
    delete store.manifests[shot.idText];
    const r = await verifyAsset(withoutStore(edit.file), (await import("../src/core")).encodeStore(store), w.ctx());
    expect(codes(r, "warn")).toContain("chain.incomplete");
    const tampered = edit.file.slice();
    tampered[tampered.length - 20] ^= 0xff;
    const r2 = await verifyAsset(tampered, null, w.ctx());
    expect(r2.verdict).toBe("broken");
    expect(codes(r2, "fail")).toContain("file.mismatch");
  });

  it("a chain of two edits walks back through both to the capture (ids are hashes, so parents cannot form a cycle)", async () => {
    const { w, edit, ed } = await shotAndEdit();
    // an edit whose parent is itself is impossible (ids are hashes), so make two edits that name each other's ids via a forged store
    const store = extractStore(edit.file)!;
    const png = withoutStore(edit.file);
    const claim: EditClaim = {
      v: 1,
      kind: "edit",
      signer: ed.id.did,
      parents: [{ manifest: idBytes(store.active), content: contentHash(png), relationship: "parentOf" }],
      actions: [{ action: "c2pa.opened" }],
      tool: { name: "t", version: "1" },
      content: { alg: "sha-256", hash: contentHash(png), size: png.length, mime: "image/png" },
      deviceTime: w.clock.now(),
      beacons: [],
      nonce: new Uint8Array(16),
    };
    const top = await signManifest(claim, ed.signer);
    // the top manifest names the edit; then lie that the edit's parent is the top by swapping the stored bytes
    store.manifests[idText(top.id)] = top.cose;
    store.active = idText(top.id);
    const r = await verifyAsset(embedStore(png, store), null, w.ctx());
    // a well-formed chain: top → edit → capture; no cycle
    expect(codes(r, "fail")).not.toContain("chain.cycle");
    expect(r.chain.map((s) => s.kind)).toEqual(["edit", "edit", "capture"]);
  });
});

describe("tile proofs", () => {
  const img = photo(200, 130);
  const key = new Uint8Array(32).fill(5);

  it("unchanged tiles verify; one changed pixel in a kept tile fails", () => {
    const { commit, hashes } = commitTiles(img, key);
    expect(sha(hashes)).toEqual(commit.root);
    const regions = [{ x: 10, y: 10, w: 20, h: 20 }];
    const edited = redact(img, regions, "fill-black");
    const p = proveTiles(img, edited, key, regions);
    const ref = { against: new Uint8Array(32), ...p.ref };
    const ok = checkTiles(edited, { width: 200, height: 130, commit }, hashes, ref, p.salts, regions);
    expect(ok.failures).toEqual([]);
    expect(ok.redacted).toBe(1);
    expect(ok.kept).toBe(commit.cols * commit.rows - 1);
    const altered = { ...edited, data: edited.data.slice() };
    altered.data[(100 * 200 + 150) * 4] ^= 1;
    const bad = checkTiles(altered, { width: 200, height: 130, commit }, hashes, ref, p.salts, regions);
    expect(bad.failures.map((f) => f.reason)).toEqual(["changed"]);
  });

  it("a redacted tile outside every declared region fails; a wrong salt fails", () => {
    const { commit, hashes } = commitTiles(img, key);
    const regions = [{ x: 10, y: 10, w: 20, h: 20 }];
    const edited = redact(img, [...regions, { x: 140, y: 70, w: 10, h: 10 }], "fill-black");
    const p = proveTiles(img, edited, key, regions);
    const r = checkTiles(edited, { width: 200, height: 130, commit }, hashes, { against: new Uint8Array(32), ...p.ref }, p.salts, regions);
    expect(r.failures.map((f) => f.reason)).toEqual(["undeclaredChange"]);
    const p2 = proveTiles(img, redact(img, regions, "fill-black"), key, regions);
    const salts = p2.salts.slice();
    salts[0] ^= 1;
    const r2 = checkTiles(redact(img, regions, "fill-black"), { width: 200, height: 130, commit }, hashes, { against: new Uint8Array(32), ...p2.ref }, salts, regions);
    expect(r2.failures.map((f) => f.reason)).toContain("changed");
  });

  it("crop offsets work; growing the canvas fails", () => {
    const { commit, hashes } = commitTiles(img, key);
    const area = snapCrop({ x: 70, y: 70, w: 100, h: 50 }, 200, 130);
    expect(area).toEqual({ x: 64, y: 64, w: 128, h: 64 });
    const out = crop(img, area);
    const p = proveTiles(img, out, key, [], [1, 1]);
    const r = checkTiles(out, { width: 200, height: 130, commit }, hashes, { against: new Uint8Array(32), ...p.ref }, p.salts, []);
    expect(r.failures).toEqual([]);
    expect(r.kept).toBe(2);
    expect(r.cropped).toBe(commit.cols * commit.rows - 2);
    const r2 = checkTiles({ ...out, width: out.width + 64, data: new Uint8Array((out.width + 64) * out.height * 4) }, { width: 200, height: 130, commit }, hashes, { against: new Uint8Array(32), ...p.ref }, p.salts, []);
    expect(r2.failures[0].reason).toBe("outsideOutput");
  });

  it("the PNG decoder gives back exactly the pixels written", () => {
    expect(decodePngReference(encodePngRgba(img)).data).toEqual(img.data);
  });

  it("a JPEG output gives 'no tile proof', a warning and not a failure", async () => {
    const w = await testWorld();
    const cam = await w.camera();
    const shot = await cam.shoot();
    await cam.anchor([shot.store], [shot.id]);
    const ed = await w.editor();
    const { encodeJpegRgba, emptyStore, mergeStores } = await import("../src/core");
    const jpg = encodeJpegRgba(redact(photo(), [{ x: 0, y: 0, w: 30, h: 30 }], "fill-black"));
    const claim: EditClaim = {
      v: 1,
      kind: "edit",
      signer: ed.id.did,
      parents: [{ manifest: idBytes(shot.idText), content: shot.claim.content.hash, relationship: "parentOf" }],
      actions: [{ action: "capture.redactedRegion", params: { regions: [{ x: 0, y: 0, w: 30, h: 30 }], method: "fill-black" } }],
      tool: { name: "t", version: "1" },
      content: { alg: "sha-256", hash: contentHash(jpg), size: jpg.length, mime: "image/jpeg" },
      deviceTime: w.clock.now(),
      beacons: [],
      nonce: new Uint8Array(16),
    };
    const m = await signManifest(claim, ed.signer);
    const own = emptyStore(idText(m.id));
    own.manifests[idText(m.id)] = m.cose;
    own.credentials.push(ed.credential);
    const r = await verifyAsset(embedStore(jpg, mergeStores(shot.store, own)), null, w.ctx());
    expect(codes(r, "fail")).toEqual([]);
    expect(codes(r, "warn")).toContain("tiles.none");
    expect(r.verdict).toBe("verifiedWithWarnings");
  });
});
