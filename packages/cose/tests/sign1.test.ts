import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  decodeCbor,
  encodeCbor,
  seedSigner,
  signCose1,
  sigStructure,
  Tagged,
  verifyCose1,
  webCryptoSigner,
  type AsyncSigner,
  type CoseAlg,
  type PublicKey,
} from "../src/index";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (h: string) => new Uint8Array(Buffer.from(h.replace(/\s+/g, ""), "hex"));
const utf8 = (s: string) => new TextEncoder().encode(s);
const keys = (...k: PublicKey[]) => async () => k;
const pub = (s: AsyncSigner) => s.publicKey;

const SEED = unhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
const CONTENT = utf8("This is the content.");

describe("known answers", () => {
  // cose-wg/Examples, eddsa-examples/eddsa-sig-01.json (RFC 8032 test key 1).
  const EDDSA_SIG_01 = unhex(
    "D28445A201270300A10442313154546869732069732074686520636F6E74656E742E5840" +
      "7142FD2FF96D56DB85BEE905A76BA1D0B7321A95C8C4D3607C5781932B7AFB8711497DFA751BF40B58B3BCC32300B1487F3DB34085EEF013BF08F4A44D6FEF0D",
  );

  it("reproduces the COSE WG Ed25519 Sign1 example byte for byte", async () => {
    const signer = seedSigner(SEED, utf8("11"), -8);
    expect(hex(signer.publicKey.bytes)).toBe("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
    const bytes = await signCose1(CONTENT, signer, { contentType: 0, omitKid: true, unprotected: new Map([[4, utf8("11")]]) });
    expect(hex(bytes)).toBe(hex(EDDSA_SIG_01));
    expect(hex(sigStructure(unhex("A201270300"), CONTENT))).toBe(
      "846a5369676e61747572653145a2012703004054546869732069732074686520636f6e74656e742e",
    );
  });

  it("verifies the COSE WG Ed25519 Sign1 example", async () => {
    const r = await verifyCose1(EDDSA_SIG_01, keys({ curve: "ed25519", bytes: unhex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a") }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.alg).toBe(-8);
    expect(r.value.kid).toEqual(utf8("11"));
    expect(r.value.payload).toEqual(CONTENT);
    expect(r.value.protected.get(3)).toBe(0);
  });

  // RFC 9052 Appendix C.2.1 with key "11" from Appendix C.7.
  const RFC9052_C21 = unhex(
    "d2 84 43a10126 a104423131 54546869732069732074686520636f6e74656e742e 5840" +
      "8eb33e4ca31d1c465ab05aac34cc6b23d58fef5c083106c4d25a91aef0b0117e2af9a291aa32e14ab834dc56ed2a223444547e01f11d3b0916e5a4c345cacb36",
  );
  const KEY_11 = {
    x: "bac5b11cad8f99f9c72b05cf4b9e26d244dc189f745228255a219a86d6a09eff",
    y: "20138bf82dc1b6d562be0fa54ab7804a3a64b6d72ccfed6b6fb6ed28bbfc117e",
    d: "57c92077664146e876760c9520d054aa93c3afb04e306705db6090308507b4d3",
  };

  it("verifies RFC 9052 C.2.1 (ES256)", async () => {
    expect(RFC9052_C21.length).toBe(98);
    const r = await verifyCose1(RFC9052_C21, keys({ curve: "p256", bytes: unhex("04" + KEY_11.x + KEY_11.y) }));
    expect(r).toMatchObject({ ok: true, value: { alg: -7, kid: utf8("11"), payload: CONTENT } });
  });

  it("signs ES256 with the RFC key so the RFC's key verifies it", async () => {
    const b64u = (h: string) => Buffer.from(h, "hex").toString("base64url");
    const jwk = { kty: "EC", crv: "P-256", x: b64u(KEY_11.x), y: b64u(KEY_11.y), d: b64u(KEY_11.d) };
    const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const publicKey = await crypto.subtle.importKey("jwk", { ...jwk, d: undefined }, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
    const signer = await webCryptoSigner({ privateKey, publicKey }, utf8("11"), -7);
    const bytes = await signCose1(CONTENT, signer, { omitKid: true, unprotected: new Map([[4, utf8("11")]]) });
    expect(bytes.length).toBe(98);
    expect(hex(bytes.subarray(0, 32))).toBe(hex(RFC9052_C21.subarray(0, 32)));
    expect((await verifyCose1(bytes, keys({ curve: "p256", bytes: unhex("04" + KEY_11.x + KEY_11.y) }))).ok).toBe(true);
  });
});

describe("signing and verifying", () => {
  const payload = encodeCbor({ v: 1, kind: "capture", nonce: new Uint8Array(16) });
  const kid = utf8("did:trail:EKx3#0");

  async function webCrypto(alg: "Ed25519" | "P-256", coseAlg?: CoseAlg): Promise<AsyncSigner> {
    const params = alg === "Ed25519" ? { name: "Ed25519" } : { name: "ECDSA", namedCurve: "P-256" };
    const pair = (await crypto.subtle.generateKey(params, false, ["sign", "verify"])) as CryptoKeyPair;
    return webCryptoSigner(pair, kid, coseAlg);
  }

  const cases: [string, () => Promise<AsyncSigner>, CoseAlg][] = [
    ["Ed25519 from a seed", async () => seedSigner(ed25519.utils.randomSecretKey(), kid), -19],
    ["Ed25519 from a seed, EdDSA", async () => seedSigner(ed25519.utils.randomSecretKey(), kid, -8), -8],
    ["non-extractable WebCrypto Ed25519", () => webCrypto("Ed25519"), -19],
    ["non-extractable WebCrypto P-256", () => webCrypto("P-256"), -9],
    ["non-extractable WebCrypto P-256, ES256", () => webCrypto("P-256", -7), -7],
  ];

  for (const [name, make, alg] of cases) {
    it(`round-trips: ${name}`, async () => {
      const signer = await make();
      expect(signer.alg).toBe(alg);
      const bytes = await signCose1(payload, signer, { contentType: "application/vnd.zk-toip.capture-claim+cbor" });
      const r = await verifyCose1(bytes, async (k, a) => {
        expect(k).toEqual(kid);
        expect(a).toBe(alg);
        return [pub(signer)];
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.payload).toEqual(payload);
      expect(r.value.alg).toBe(alg);
      expect(r.value.kid).toEqual(kid);
      expect(r.value.protected.get(3)).toBe("application/vnd.zk-toip.capture-claim+cbor");
    });
  }

  it("writes tag 18, the protected header (alg, content type, kid) and an empty unprotected map", async () => {
    const signer = seedSigner(new Uint8Array(32), kid);
    const outer = decodeCbor<Tagged>(await signCose1(payload, signer, { contentType: "text/x" }));
    expect(outer.tag).toBe(18);
    const [prot, unprot, body, sig] = outer.value as [Uint8Array, unknown, Uint8Array, Uint8Array];
    expect(decodeCbor(prot)).toEqual(new Map<number, unknown>([[1, -19], [3, "text/x"], [4, kid]]));
    expect(unprot).toEqual({});
    expect(body).toEqual(payload);
    expect(sig.length).toBe(64);
  });

  it("keeps a radio frame small: omitKid gives a 4-byte protected header", async () => {
    const signer = seedSigner(new Uint8Array(32), kid);
    const reading = encodeCbor([new Uint8Array(4), 0xffffffff, 0xffffffff, [[1, 0xffff], [2, 0xffff], [3, 0xffff]]]);
    const bytes = await signCose1(reading, signer, { omitKid: true });
    // tag 1, array 1, protected 4, unprotected 1, payload (header + body), signature 66
    expect(hex(bytes.subarray(0, 7))).toBe("d28443a10132a0");
    expect(bytes.length).toBe(1 + 1 + 4 + 1 + (reading.length + (reading.length < 24 ? 1 : 2)) + 66);
    const r = await verifyCose1(bytes, keys(pub(signer)));
    expect(r.ok && r.value.kid).toBe(undefined);
  });

  describe("rejection", () => {
    const signer = seedSigner(new Uint8Array(32).fill(7), kid);
    const other = seedSigner(new Uint8Array(32).fill(8), kid);

    it("detects a changed payload, protected header or signature", async () => {
      const bytes = await signCose1(payload, signer);
      const k = keys(pub(signer));
      expect((await verifyCose1(bytes, k)).ok).toBe(true);
      const at = (needle: Uint8Array) => {
        for (let i = 0; i < bytes.length; i++) if (needle.every((b, j) => bytes[i + j] === b)) return i;
        throw new Error("not found");
      };
      const flips = [at(payload) + 5, at(kid) + 2, bytes.length - 1];
      for (const i of flips) {
        const t = bytes.slice();
        t[i] ^= 1;
        expect(await verifyCose1(t, k), `byte ${i}`).toEqual({ ok: false, failure: "signatureInvalid" });
      }
    });

    it("rejects the wrong key", async () => {
      const bytes = await signCose1(payload, signer);
      expect(await verifyCose1(bytes, keys(pub(other)))).toEqual({ ok: false, failure: "signatureInvalid" });
    });

    it("tries every key it is given (for example around a rotation)", async () => {
      const bytes = await signCose1(payload, signer);
      expect((await verifyCose1(bytes, keys(pub(other), pub(signer)))).ok).toBe(true);
    });

    it("reports keyMismatch when no key fits the algorithm", async () => {
      const bytes = await signCose1(payload, signer);
      expect(await verifyCose1(bytes, keys())).toEqual({ ok: false, failure: "keyMismatch" });
      expect(await verifyCose1(bytes, keys({ curve: "p256", bytes: new Uint8Array(65) }))).toEqual({ ok: false, failure: "keyMismatch" });
    });

    it("binds external AAD", async () => {
      const aad = utf8("capture/v1");
      const bytes = await signCose1(payload, signer, { externalAad: aad });
      expect((await verifyCose1(bytes, keys(pub(signer)), { externalAad: aad })).ok).toBe(true);
      expect(await verifyCose1(bytes, keys(pub(signer)))).toEqual({ ok: false, failure: "signatureInvalid" });
      expect(await verifyCose1(bytes, keys(pub(signer)), { externalAad: utf8("capture/v2") })).toEqual({ ok: false, failure: "signatureInvalid" });
    });

    it("enforces allowedAlgs", async () => {
      const bytes = await signCose1(payload, signer);
      expect(await verifyCose1(bytes, keys(pub(signer)), { allowedAlgs: [-8, -7] })).toEqual({ ok: false, failure: "algNotAllowed" });
      expect((await verifyCose1(bytes, keys(pub(signer)), { allowedAlgs: [-19] })).ok).toBe(true);
    });

    it("rejects unknown algorithms", async () => {
      const prot = encodeCbor(new Map([[1, -35]]));
      const bytes = encodeCbor(new Tagged(18, [prot, new Map(), payload, new Uint8Array(64)]));
      expect(await verifyCose1(bytes, keys(pub(signer)))).toEqual({ ok: false, failure: "algNotAllowed" });
    });

    it("rejects malformed messages", async () => {
      const prot = encodeCbor(new Map([[1, -19]]));
      const sig = new Uint8Array(64);
      const bad = [
        new Uint8Array([0xff]),
        encodeCbor("hello"),
        encodeCbor(new Tagged(18, [prot, new Map(), payload])),
        encodeCbor(new Tagged(17, [prot, new Map(), payload, sig])),
        encodeCbor(new Tagged(18, [new Uint8Array(), new Map([[1, -19]]), payload, sig])), // alg not protected
        encodeCbor(new Tagged(18, [prot, new Map(), null, sig])), // detached payload
        encodeCbor(new Tagged(18, [encodeCbor(new Map<number, unknown>([[1, -19], [2, [99]]])), new Map(), payload, sig])), // crit
        encodeCbor(new Tagged(18, [prot, new Map(), payload, new Uint8Array(63)])),
      ];
      for (const b of bad) expect(await verifyCose1(b, keys(pub(signer))), hex(b).slice(0, 20)).toEqual({ ok: false, failure: "malformed" });
    });

    it("accepts an untagged COSE_Sign1", async () => {
      const tagged = decodeCbor<Tagged>(await signCose1(payload, signer));
      expect((await verifyCose1(encodeCbor(tagged.value), keys(pub(signer)))).ok).toBe(true);
    });
  });
});
