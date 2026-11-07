import { describe, expect, it } from "vitest";
import { Controller, keyQb64, nextKeyDigest, webCryptoSigner } from "@toip-tools/eventlog";
import { webCryptoSigner as coseWebCrypto } from "@toip-tools/cose";
import { compactFromStream, embedStore, kidOf, makeCapture, ownerRotate, storeFromStream, utf8, verifyAsset } from "../src/core";
import { codes, testWorld } from "./helpers";

describe("key rotation (the owner holds the recovery key)", () => {
  it("captures anchored before a rotation still verify; a capture by the retired key after the rotation fails", async () => {
    const w = await testWorld();
    const cam = await w.camera();
    const before = await cam.shoot();
    await cam.anchor([before.store], [before.id]);
    const unanchored = await cam.shoot();
    w.clock.advance(60_000);

    // the phone is lost: the owner rotates with the recovery key
    const stream = await w.clients[0].query({ logId: cam.aid });
    const { rot } = await ownerRotate({ aid: cam.aid, stream, recovery: cam.rec.signer(0), nextRecovery: cam.rec.digest(1), clock: w.clock, witnesses: w.clients });
    expect(rot.t).toBe("rot");
    w.clock.advance(30_000);
    const fresh = await cam.keyLog();

    // anchored before: still verified, with the reason
    before.store.keyLogs[cam.did] = fresh;
    const r1 = await verifyAsset(embedStore(before.file, before.store), null, w.ctx());
    expect(r1.verdict).toBe("verified");
    expect(codes(r1, "ok")).toContain("key.retiredAfter");
    expect(r1.chain[0].signer.keyStatus).toBe("retiredAnchored");

    // signed before but never anchored: a warning
    unanchored.store.keyLogs[cam.did] = fresh;
    const r2 = await verifyAsset(embedStore(unanchored.file, unanchored.store), null, w.ctx());
    expect(codes(r2, "warn")).toContain("key.retiredUnanchored");
    expect(r2.verdict).toBe("verifiedWithWarnings");

    // the thief keeps shooting with the old key: the beacon proves it was after the rotation
    const after = await cam.shoot(undefined, { keyRef: 0 });
    after.store.keyLogs[cam.did] = fresh;
    const r3 = await verifyAsset(embedStore(after.file, after.store), null, w.ctx());
    expect(r3.verdict).toBe("broken");
    expect(codes(r3, "fail")).toContain("key.usedAfterRetirement");

    // and can't anchor it: the witnesses refuse an interaction event by the retired key
    const report = await cam.controller.interact([{ d: nextKeyDigest("x") }]).then(() => cam.controller.publish(w.clients));
    expect(report.missing.length).toBe(3);
  });

  it("a fresher key log from the registry exposes a rotation the file doesn't know about", async () => {
    const w = await testWorld();
    const cam = await w.camera();
    const stream0 = await w.clients[0].query({ logId: cam.aid });
    await ownerRotate({ aid: cam.aid, stream: stream0, recovery: cam.rec.signer(0), nextRecovery: cam.rec.digest(1), clock: w.clock, witnesses: w.clients });
    w.clock.advance(30_000);
    // the old phone doesn't know; its store carries the old log
    const stale = (await compactFromStream(stream0)).bytes;
    const after = await cam.shoot(undefined, { keyRef: 0 });
    after.store.keyLogs[cam.did] = stale;
    const offline = await verifyAsset(embedStore(after.file, after.store), null, w.ctx());
    expect(codes(offline, "fail")).not.toContain("key.usedAfterRetirement");
    const fresh = await cam.keyLog();
    const fetch = { storeByHash: async () => null, manifest: async () => null, keyLog: async () => fresh, statusList: async () => null, drandRound: async () => null };
    const online = await verifyAsset(embedStore(after.file, after.store), null, w.ctx({ fetch }));
    expect(codes(online, "fail")).toContain("key.usedAfterRetirement");
  });
});

describe("stolen-key recovery", () => {
  it("the thief can't rotate; the owner hands the identifier to a new device key, whose captures verify", async () => {
    const w = await testWorld();
    const cam = await w.camera();
    const stream = await w.clients[0].query({ logId: cam.aid });

    // the thief holds the capture key, but not the committed next key
    const thief = await Controller.load(cam.aid, { hot: [await webCryptoSigner(cam.pair)], store: await storeFromStream(stream, w.clock), clock: w.clock });
    await expect(thief.rotate({ exposed: [await webCryptoSigner(cam.pair)], next: [nextKeyDigest("thief")] })).rejects.toThrow();

    // the owner rotates to the new phone's key: first with the recovery key, committing to the new key...
    const newPair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
    const newSigner = await webCryptoSigner(newPair);
    await ownerRotate({ aid: cam.aid, stream, recovery: cam.rec.signer(0), nextRecovery: nextKeyDigest(keyQb64(newSigner)), clock: w.clock, witnesses: w.clients });
    // ...then the new phone rotates itself in, committing to the owner's next recovery key
    const s2 = await w.clients[0].query({ logId: cam.aid });
    const phone = await Controller.load(cam.aid, { hot: [newSigner], store: await storeFromStream(s2, w.clock), clock: w.clock });
    const rot2 = await phone.rotate({ exposed: [newSigner], next: [cam.rec.digest(1)] });
    await phone.publish(w.clients);
    expect(phone.state().keys).toEqual([keyQb64(newSigner)]);

    // the new phone signs under the same identifier
    const file = (await import("./helpers")).jpegPhoto(256, 128, 3);
    const b = w.beacon();
    const cap = await makeCapture({
      file,
      signer: await coseWebCrypto(newPair, utf8(kidOf(cam.did, rot2.s))),
      device: cam.did,
      deviceTime: w.clock.now(),
      beacons: [b.beacon],
      beaconSigs: b.sigs,
      sensor: { type: "camera", pipeline: "getUserMedia+canvas" },
      app: { name: "capture-camera", version: "0.1.0" },
    });
    cap.store.credentials.push(...cam.credentials);
    cap.store.statusLists.push(w.status.sign());
    const st = phone.state();
    const { batchAnchors, digestSealOf } = await import("../src/core");
    const { root, anchors } = batchAnchors([cap.id], cam.did, st.sn + 1);
    await phone.interact([digestSealOf(root)]);
    w.clock.advance(1000);
    await phone.publish(w.clients);
    cap.store.anchors[cap.idText] = anchors;
    cap.store.keyLogs[cam.did] = await cam.keyLog();
    const r = await verifyAsset(embedStore(file, cap.store), null, w.ctx());
    expect(codes(r, "fail")).toEqual([]);
    expect(r.verdict).toBe("verified");
    expect(r.chain[0].signer.keyRef).toBe(rot2.s);

    // a revoked owner credential is shown, as a warning (status lists don't say when)
    w.status.revoke(cam.statusEntry);
    cap.store.statusLists = [w.status.sign()];
    const r2 = await verifyAsset(embedStore(file, cap.store), null, w.ctx());
    expect(codes(r2, "warn")).toContain("credential.revoked");
  });
});
