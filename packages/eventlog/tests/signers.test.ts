import { describe, expect, it } from "vitest";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { toB64u, utf8 } from "@zk-toip/trust-core";
import { nextKeyDigest } from "../src/cesr";
import { Controller } from "../src/controller";
import { verifyKel } from "../src/kel";
import { coldKeysFromSeed, keyQb64, webAuthnSigner, webCryptoSigner, type Signer } from "../src/keys";
import { MemoryStore } from "../src/store";
import { fromStream, toStream } from "../src/stream";
import { verifyTrail } from "../src/trail";
import { exportBundle, verifyBundle } from "../src/verify";
import { seedFrom, setup } from "./helpers";

const codes = (r: { problems: { code: string }[] }) => r.problems.map((p) => p.code);

async function nonExtractable(alg: "Ed25519" | "P-256") {
  const params = alg === "Ed25519" ? { name: "Ed25519" } : { name: "ECDSA", namedCurve: "P-256" };
  const pair = (await crypto.subtle.generateKey(params, false, ["sign", "verify"])) as CryptoKeyPair;
  await expect(crypto.subtle.exportKey("pkcs8", pair.privateKey)).rejects.toThrow();
  return webCryptoSigner(pair);
}

async function roundTrip(hot: Signer[], curve: "ed25519" | "p256") {
  const { clock, store } = setup();
  const cold = coldKeysFromSeed(seedFrom("owner/recovery"), "device", { curve });
  const c = await Controller.incept({ hot, cold, store, clock, data: { keyClass: "B", device: "camera" } });
  const t = await c.openTrail("device/captures");
  await t.append({ kind: "device/capture", refs: [{ d: nextKeyDigest("manifest") }] });
  await c.interact([{ d: nextKeyDigest("batch root") }]);
  return { c, t, store, clock };
}

describe("async and non-extractable signers", () => {
  it("a WebCrypto Ed25519 key that can't be exported signs a KEL and a trail", async () => {
    const s = await nonExtractable("Ed25519");
    const { c, store } = await roundTrip([s], "ed25519");
    expect(c.state().keys[0]).toBe(keyQb64(s));
    const v = await verifyBundle(await exportBundle(store, c.aid), { allowUnwitnessed: true });
    expect(v.problems).toEqual([]);
  });

  it("a WebCrypto P-256 key that can't be exported (ECDSA, possibly high-s) works too", async () => {
    const s = await nonExtractable("P-256");
    expect(keyQb64(s).startsWith("1AAJ")).toBe(true);
    const { c, store } = await roundTrip([s], "p256");
    const v = await verifyBundle(await exportBundle(store, c.aid), { allowUnwitnessed: true });
    expect(v.problems).toEqual([]);
    // the owner rotates with the recovery key; the old key is retired
    await c.rotate();
    expect((await verifyKel(c.kelMessages(), { allowUnwitnessed: true })).ok).toBe(true);
  });
});

/** A simulated platform authenticator. */
function authenticator(origin: string, rpId: string) {
  const sk = p256.utils.randomSecretKey();
  let counter = 0;
  return {
    publicKey: p256.getPublicKey(sk, false), // 65 bytes, as a registration response gives it
    getAssertion: async (challenge: Uint8Array) => {
      const authenticatorData = new Uint8Array(37);
      authenticatorData.set(sha256(utf8(rpId)));
      authenticatorData[32] = 0x05; // UP and UV
      new DataView(authenticatorData.buffer).setUint32(33, ++counter);
      const clientDataJSON = utf8(JSON.stringify({ type: "webauthn.get", challenge: toB64u(challenge), origin, crossOrigin: false }));
      const signed = new Uint8Array([...authenticatorData, ...sha256(clientDataJSON)]);
      const signature = p256.sign(signed, sk, { format: "der" });
      return { authenticatorData, clientDataJSON, signature };
    },
  };
}

describe("WebAuthn hook", () => {
  it("a passkey signs the KEL and trail through WebAuthn assertions; the stream carries them", async () => {
    const auth = authenticator("http://localhost:5173", "localhost");
    const s = webAuthnSigner(auth);
    const { c, store } = await roundTrip([s], "p256");
    const icp = c.kelMessages()[0];
    expect(icp.controllerSigs![0].wrap).toBeDefined();
    const text = toStream(c.kelMessages());
    expect(text).toContain("-Y");
    const back = fromStream(text);
    expect(back.problems).toEqual([]);
    expect(toStream(back.messages)).toBe(text);
    const ok = await verifyBundle(await exportBundle(store, c.aid), { allowUnwitnessed: true, webauthn: { origins: ["http://localhost:5173"], rpIds: ["localhost"], requireUserVerified: true } });
    expect(ok.problems).toEqual([]);
    const wrongOrigin = await verifyKel(text, { allowUnwitnessed: true, webauthn: { origins: ["https://evil.example"] } });
    expect(codes(wrongOrigin)).toContain("signatureInvalid");
    const refused = await verifyKel(text, { allowUnwitnessed: true, webauthn: false });
    expect(codes(refused)).toContain("signatureInvalid");
  });

  it("a pluggable verifier is tried first", async () => {
    const { c } = await roundTrip([coldKeysFromSeed(seedFrom("x"), "x").release(0, 1)[0]], "ed25519");
    const never = await verifyKel(c.kelMessages(), { allowUnwitnessed: true, verifySig: () => false });
    expect(codes(never)).toContain("signatureInvalid");
    const fallback = await verifyKel(c.kelMessages(), { allowUnwitnessed: true, verifySig: () => undefined });
    expect(fallback.ok).toBe(true);
    const tr = await verifyTrail({ kel: fallback, stream: await (await exportBundle(c.store, c.aid)).trails[0].stream }, { allowUnwitnessed: true, verifySig: () => false });
    expect(codes(tr)).toContain("signatureInvalid");
    void MemoryStore;
  });
});
