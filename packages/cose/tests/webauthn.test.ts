import { describe, expect, it } from "vitest";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { decodeCbor, encodeCbor, signCose1, sigStructure, Tagged, verifyCose1, webAuthnSigner, type WebAuthnGet } from "../src/index";

const utf8 = (s: string) => new TextEncoder().encode(s);
const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const concat = (...p: Uint8Array[]) => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of p) out.set(x, (o += x.length) - x.length);
  return out;
};
const ab = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const bytesOf = (s: BufferSource) => (s instanceof ArrayBuffer ? new Uint8Array(s) : new Uint8Array(s.buffer, s.byteOffset, s.byteLength));

const ORIGIN = "https://capture.example";
const UP = 0x01, UV = 0x04, BE = 0x08, BS = 0x10;

interface Options {
  origin?: string;
  rpId?: string;
  flags?: number;
  type?: string;
  challenge?: (c: Uint8Array) => Uint8Array;
  signWith?: Uint8Array;
}

/** A synthetic authenticator: builds authenticatorData and clientDataJSON itself, and signs them with a P-256 key, as a passkey does. */
function authenticator(o: Options = {}) {
  const secret = p256.utils.randomSecretKey();
  const publicKey = p256.getPublicKey(secret, false);
  const calls: CredentialRequestOptions[] = [];
  const get: WebAuthnGet = async (options) => {
    calls.push(options);
    const pk = options.publicKey!;
    const challenge = bytesOf(pk.challenge);
    const rpIdHash = sha256(utf8(o.rpId ?? pk.rpId!));
    const authData = concat(rpIdHash, new Uint8Array([o.flags ?? UP | UV]), new Uint8Array([0, 0, 0, 7]));
    const clientDataJSON = utf8(JSON.stringify({ type: o.type ?? "webauthn.get", challenge: b64u(o.challenge ? o.challenge(challenge) : challenge), origin: o.origin ?? ORIGIN, crossOrigin: false }));
    const signature = p256.sign(concat(authData, sha256(clientDataJSON)), o.signWith ?? secret, { format: "der", prehash: true });
    return { response: { authenticatorData: ab(authData), clientDataJSON: ab(clientDataJSON), signature: ab(signature) } };
  };
  return { publicKey, get, calls };
}

const kid = utf8("did:trail:EKx3#0");
const credentialId = new Uint8Array([9, 9, 9]);
const payload = encodeCbor({ v: 1, kind: "capture" });

async function signed(o: Options = {}) {
  const a = authenticator(o);
  const signer = webAuthnSigner({ credentialId, rpId: "capture.example", publicKey: a.publicKey, kid, get: a.get });
  const bytes = await signCose1(payload, signer);
  return { a, signer, bytes, key: async () => [signer.publicKey] };
}

describe("WebAuthn-wrapped signatures (alg -65600)", () => {
  it("signs through navigator.credentials.get with challenge = SHA-256(Sig_structure), and verifies", async () => {
    const { a, signer, bytes, key } = await signed();
    expect(signer.alg).toBe(-65600);
    expect(signer.publicKey.curve).toBe("p256");

    const [prot, , , sig] = decodeCbor<Tagged>(bytes).value as Uint8Array[];
    const req = a.calls[0].publicKey!;
    expect(bytesOf(req.challenge)).toEqual(sha256(sigStructure(prot, payload)));
    expect(req.rpId).toBe("capture.example");
    expect(req.userVerification).toBe("required");
    expect(bytesOf(req.allowCredentials![0].id)).toEqual(credentialId);

    const [authData, clientDataJSON, der] = decodeCbor<Uint8Array[]>(sig);
    expect(authData.length).toBe(37);
    expect(JSON.parse(new TextDecoder().decode(clientDataJSON)).type).toBe("webauthn.get");
    expect(der[0]).toBe(0x30);

    const r = await verifyCose1(bytes, key, { webauthnOrigins: [ORIGIN] });
    expect(r).toMatchObject({ ok: true, value: { alg: -65600, kid, payload, webauthn: { origin: ORIGIN, flags: { up: true, uv: true, be: false, bs: false } } } });
  });

  it("reports backup eligible and backup state (a synced passkey)", async () => {
    const { bytes, key } = await signed({ flags: UP | UV | BE | BS });
    const r = await verifyCose1(bytes, key, { webauthnOrigins: [ORIGIN] });
    expect(r.ok && r.value.webauthn?.flags).toEqual({ up: true, uv: true, be: true, bs: true });
  });

  it("accepts the passkey public key as SPKI (what getPublicKey() returns)", async () => {
    const { a, bytes } = await signed();
    const spki = concat(Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex"), a.publicKey);
    expect((await verifyCose1(bytes, async () => [{ curve: "p256", bytes: spki }], { webauthnOrigins: [ORIGIN] })).ok).toBe(true);
  });

  it("checks the challenge", async () => {
    const { bytes, key } = await signed({ challenge: (c) => sha256(c) });
    expect(await verifyCose1(bytes, key, { webauthnOrigins: [ORIGIN] })).toEqual({ ok: false, failure: "webauthnChallenge" });
  });

  it("detects a changed payload through the challenge", async () => {
    const { bytes, key } = await signed();
    const t = bytes.slice();
    const at = t.findIndex((_, i) => payload.every((b, j) => t[i + j] === b));
    t[at + 3] ^= 1;
    expect(await verifyCose1(t, key, { webauthnOrigins: [ORIGIN] })).toEqual({ ok: false, failure: "webauthnChallenge" });
  });

  it("checks the type", async () => {
    const { bytes, key } = await signed({ type: "webauthn.create" });
    expect(await verifyCose1(bytes, key, { webauthnOrigins: [ORIGIN] })).toEqual({ ok: false, failure: "webauthnChallenge" });
  });

  it("checks the origin against the allowed list, and requires one", async () => {
    const { bytes, key } = await signed({ origin: "https://evil.example" });
    expect(await verifyCose1(bytes, key, { webauthnOrigins: [ORIGIN] })).toEqual({ ok: false, failure: "webauthnOrigin" });
    const good = await signed();
    expect(await verifyCose1(good.bytes, good.key)).toEqual({ ok: false, failure: "webauthnOrigin" });
  });

  it("checks rpIdHash against the origin's host", async () => {
    const { bytes, key } = await signed({ rpId: "other.example" });
    expect(await verifyCose1(bytes, key, { webauthnOrigins: [ORIGIN] })).toEqual({ ok: false, failure: "webauthnOrigin" });
  });

  it("requires user presence and user verification", async () => {
    for (const flags of [UV, UP, 0]) {
      const { bytes, key } = await signed({ flags });
      expect(await verifyCose1(bytes, key, { webauthnOrigins: [ORIGIN] }), `flags ${flags}`).toEqual({ ok: false, failure: "webauthnFlags" });
    }
  });

  it("rejects a signature from another key", async () => {
    const { bytes, key } = await signed({ signWith: p256.utils.randomSecretKey() });
    expect(await verifyCose1(bytes, key, { webauthnOrigins: [ORIGIN] })).toEqual({ ok: false, failure: "signatureInvalid" });
  });

  it("binds external AAD through the challenge", async () => {
    const a = authenticator();
    const signer = webAuthnSigner({ credentialId, rpId: "capture.example", publicKey: a.publicKey, kid, get: a.get });
    const bytes = await signCose1(payload, signer, { externalAad: utf8("x") });
    const key = async () => [signer.publicKey];
    expect((await verifyCose1(bytes, key, { webauthnOrigins: [ORIGIN], externalAad: utf8("x") })).ok).toBe(true);
    expect(await verifyCose1(bytes, key, { webauthnOrigins: [ORIGIN] })).toEqual({ ok: false, failure: "webauthnChallenge" });
  });

  it("rejects a malformed wrapper", async () => {
    const { bytes, key } = await signed();
    const [prot, unprot, body] = decodeCbor<Tagged>(bytes).value as unknown[];
    for (const sig of [new Uint8Array(64), encodeCbor([new Uint8Array(10), utf8("{}"), new Uint8Array(70)]), encodeCbor([new Uint8Array(37), utf8("not json"), new Uint8Array(70)])]) {
      const b = encodeCbor(new Tagged(18, [prot, unprot, body, sig]));
      expect(await verifyCose1(b, key, { webauthnOrigins: [ORIGIN] })).toEqual({ ok: false, failure: "malformed" });
    }
  });

  it("is refused where -65600 is not allowed", async () => {
    const { bytes, key } = await signed();
    expect(await verifyCose1(bytes, key, { webauthnOrigins: [ORIGIN], allowedAlgs: [-19, -9] })).toEqual({ ok: false, failure: "algNotAllowed" });
  });
});
