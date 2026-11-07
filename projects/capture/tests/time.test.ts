import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MandateEngine, StatusRegistry } from "@zk-toip/mandates";
import { embedStore, fromHex, makeCapture, QUICKNET, randomnessOf, roundAt, roundTime, verifyAsset, verifyBeaconClaim, verifyRound, verifyRounds } from "../src/core";
import { cameraMandate, mandateChecker } from "../src/core/mandate";
import { codes, jpegPhoto, testWorld } from "./helpers";

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "drand-quicknet.json"), "utf8")) as { rounds: { round: number; randomness: string; signature: string }[] };

describe("time: drand for not-before", () => {
  it("recorded quicknet rounds verify offline; randomness is SHA-256 of the signature; a wrong round fails", () => {
    for (const r of fixture.rounds) {
      const sig = fromHex(r.signature);
      expect(verifyRound(QUICKNET, r.round, sig)).toBe(true);
      expect(Buffer.from(randomnessOf(sig)).toString("hex")).toBe(r.randomness);
    }
    const r0 = fixture.rounds[0];
    expect(verifyRound(QUICKNET, r0.round + 1, fromHex(r0.signature))).toBe(false);
    expect(verifyBeaconClaim(QUICKNET, r0.round, fromHex(r0.randomness).slice(0, 8), fromHex(r0.signature))).toBe(true);
    expect(verifyBeaconClaim(QUICKNET, r0.round, new Uint8Array(8), fromHex(r0.signature))).toBe(false);
    // round time: genesis + (round − 1) × 3 s, and back
    expect(roundAt(QUICKNET, roundTime(QUICKNET, r0.round))).toBe(r0.round);
  });

  it("rounds verify in a batch, and a bad one in the batch is still caught", () => {
    const good = fixture.rounds.map((r) => ({ round: r.round, signature: fromHex(r.signature) }));
    expect(verifyRounds(QUICKNET, good)).toEqual(good.map(() => true));
    const swapped = good.map((r, i) => (i === 2 ? { ...r, round: r.round + 100 } : r));
    expect(verifyRounds({ ...QUICKNET, hash: "fresh-cache" }, swapped)).toEqual(good.map((_, i) => i !== 2));
  });

  it("a capture with a real quicknet beacon gets that round as its lower bound; a forged prefix fails", async () => {
    const w = await testWorld();
    const cam = await w.camera();
    const r0 = fixture.rounds[fixture.rounds.length - 1];
    const at = roundTime(QUICKNET, r0.round);
    const file = jpegPhoto();
    const mk = async (prefix: Uint8Array) => {
      const cap = await makeCapture({
        file,
        signer: await cam.signer(),
        device: cam.did,
        deviceTime: at + 1500,
        beacons: [{ kind: "drand-quicknet", round: r0.round, prefix }],
        beaconSigs: { [`drand-quicknet:${r0.round}`]: fromHex(r0.signature) },
        sensor: { type: "camera", pipeline: "getUserMedia+canvas" },
        app: { name: "capture-camera", version: "0.1.0" },
      });
      cap.store.credentials.push(...cam.credentials);
      cap.store.keyLogs[cam.did] = await cam.keyLog();
      return cap;
    };
    const ok = await mk(fromHex(r0.randomness).slice(0, 8));
    const r = await verifyAsset(embedStore(file, ok.store), null, w.ctx({ drand: [QUICKNET] }));
    expect(r.interval?.notBefore).toBe(at);
    expect(r.interval?.notBeforeWhy).toBe(`after drand round ${r0.round}`);
    const bad = await mk(new Uint8Array(8).fill(7));
    expect(codes(await verifyAsset(embedStore(file, bad.store), null, w.ctx({ drand: [QUICKNET] })), "fail")).toContain("time.beaconInvalid");
  });
});

describe("time: witness receipts for not-after", () => {
  it("the interval is [beacon round, the 2nd of 3 witnesses' receipt]; a lying device clock is flagged", async () => {
    const w = await testWorld();
    const cam = await w.camera();
    w.clock.advance(10_000);
    const shot = await cam.shoot(undefined, { deviceTime: w.clock.now() - 86_400_000 });
    const round = shot.claim.beacons[0].round;
    await cam.anchor([shot.store], [shot.id]);
    const r = await verifyAsset(embedStore(shot.file, shot.store), null, w.ctx());
    expect(r.interval?.notBefore).toBe(w.roundTime(round));
    // witnesses received the anchor when the clock was at publish time (anchor() advances 2 s first)
    expect(r.interval?.notAfter).toBe(w.clock.now());
    expect(r.interval?.notAfterWhy).toBe("before 3 of 3 witnesses received it");
    expect(codes(r, "warn")).toContain("time.deviceClockWrong");
    expect(r.verdict).toBe("verifiedWithWarnings");
  });

  it("no beacon and no anchor: only the device's claim, and both ends are missing", async () => {
    const w = await testWorld();
    const cam = await w.camera();
    const shot = await cam.shoot(undefined, { beacon: false });
    shot.store.keyLogs[cam.did] = await cam.keyLog();
    const r = await verifyAsset(embedStore(shot.file, shot.store), null, w.ctx());
    expect(codes(r, "warn")).toEqual(expect.arrayContaining(["time.noNotBefore", "time.noNotAfter"]));
    expect(r.interval).toEqual({});
  });

  it("time evidence that contradicts itself fails", async () => {
    const w = await testWorld();
    const cam = await w.camera();
    const shot = await cam.shoot();
    // a beacon from the future: the dev chain's key can sign any round, as a broken beacon could
    const future = roundAt(w.drand.chain, w.clock.now() + 3_600_000);
    const fr = w.drand.sign(future);
    const cap = await makeCapture({
      file: shot.file,
      signer: await cam.signer(),
      device: cam.did,
      deviceTime: w.clock.now(),
      beacons: [{ kind: "drand-dev", round: future, prefix: fr.randomness.slice(0, 8) }],
      beaconSigs: { [`drand-dev:${future}`]: fr.signature },
      sensor: shot.claim.sensor,
      app: shot.claim.app,
    });
    cap.store.credentials.push(...cam.credentials);
    await cam.anchor([cap.store], [cap.id]);
    const r = await verifyAsset(embedStore(shot.file, cap.store), null, w.ctx());
    expect(codes(r, "fail")).toContain("time.contradiction");
  });
});

describe("capture/1 mandates", () => {
  it("the owner's mandate allows a JPEG and refuses a type it doesn't list", async () => {
    const w = await testWorld();
    const cam = await w.camera();
    const status = new StatusRegistry(w.owner, w.clock);
    const engine = await MandateEngine.load();
    const check = mandateChecker(engine);
    const jpegOnly = cameraMandate(w.owner, w.clock, status, cam.did, { validUntil: "2027-01-01T00:00:00Z", mediaTypes: ["image/jpeg"] });
    const lists = [status.sign()];
    const at = w.clock.now();
    expect((await check({ mandate: jpegOnly as never, device: cam.did, media: "sha-256:00", mediaType: "image/jpeg", at, statusLists: lists })).outcome).toBe("allow");
    const png = await check({ mandate: jpegOnly as never, device: cam.did, media: "sha-256:00", mediaType: "image/png", at, statusLists: lists });
    expect(png.outcome).not.toBe("allow");
    // another device presenting it is refused
    expect((await check({ mandate: jpegOnly as never, device: "did:keri:EOther", media: "sha-256:00", mediaType: "image/jpeg", at, statusLists: lists })).outcome).toBe("deny");
    // in the verifier
    const shot = await cam.shoot();
    await cam.anchor([shot.store], [shot.id]);
    shot.store.mandates.push(jpegOnly as never);
    shot.store.statusLists.push(...lists);
    const r = await verifyAsset(embedStore(shot.file, shot.store), null, w.ctx({ mandates: check }));
    expect(codes(r, "ok")).toContain("mandate.allow");
    // revoked
    status.revoke(jpegOnly.credentialStatus);
    shot.store.statusLists = [status.sign()];
    const r2 = await verifyAsset(embedStore(shot.file, shot.store), null, w.ctx({ mandates: check }));
    expect(codes(r2, "warn")).toContain("mandate.deny");
  });
});
