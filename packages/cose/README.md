# @toip-tools/cose

Deterministic CBOR and `COSE_Sign1`, with async signers.

Capture signs its manifests and sensor frames with it (Capture design §8, §12, §19.1). Mesh can use it for compact signed frames. It runs in browsers and in Node. The main entry has no Node-only imports.

It uses `cborg` for CBOR, and `@noble/curves` and `@noble/hashes` for Ed25519, P-256 and SHA-256.

## Install

```sh
npm install @toip-tools/cose
```

## CBOR

```ts
import { encodeCbor, decodeCbor, Tagged } from "@toip-tools/cose";

const bytes = encodeCbor({ v: 1, kind: "capture", hash: new Uint8Array(32) });
const claim = decodeCbor<{ v: number }>(bytes);
```

`encodeCbor` writes RFC 8949 §4.2.1 Core Deterministic Encoding:
- integers, lengths and floats in their shortest form;
- definite lengths only;
- map keys sorted by the bytes of their encoding (so `"a"`, `"b"`, `"aa"`; and `1`, `10`, `100`, `-1`).

Plain objects become maps with text keys. Use a `Map` for other keys, such as COSE header labels. Properties that are `undefined` are left out. `new Tagged(n, value)` writes a tag.

`decodeCbor` is strict by default. It throws on:
- indefinite lengths;
- integers, lengths or floats that are not in the shortest form;
- map keys out of order, or duplicated;
- `undefined`, NaN, infinities, bad UTF-8, trailing bytes.

Pass `{ strict: false }` to read any well-formed CBOR. Maps whose keys are all text come back as objects; other maps come back as `Map`. Pass `{ useMaps: true }` to get every map as a `Map`. Every tag comes back as a `Tagged`.

## Signers

```ts
interface AsyncSigner {
  alg: CoseAlg;            // -19 Ed25519, -9 ESP256, -8 EdDSA, -7 ES256, -65600 WebAuthn-wrapped ES256
  kid: Uint8Array;
  publicKey: { curve: "ed25519" | "p256"; bytes: Uint8Array };
  sign(toBeSigned: Uint8Array): Promise<Uint8Array>;
}
```

- `seedSigner(seed, kid, alg = -19)`: Ed25519 from a 32-byte seed. `alg` may be `-8`.
- `webCryptoSigner(pair, kid, alg?)`: a WebCrypto `CryptoKeyPair`, Ed25519 or ECDSA P-256. The private key can be non-extractable. The default alg is `-19` for Ed25519 and `-9` for P-256. Pass `-8` or `-7` for the older identifiers.
- `webAuthnSigner({ credentialId, rpId, publicKey, kid, get? })`: a passkey. Each signature is one `navigator.credentials.get` call, with user verification required. Pass `get` to use something other than `navigator.credentials.get`.

```ts
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
const signer = await webCryptoSigner(pair, new TextEncoder().encode("did:trail:EKx3#0"));
```

## COSE_Sign1

```ts
const cose = await signCose1(encodeCbor(claim), signer, { contentType: "application/vnd.zk-toip.capture-claim+cbor" });

const r = await verifyCose1(cose, async (kid, alg) => [deviceKey], { allowedAlgs: [-19, -9, -8, -7] });
if (r.ok) use(r.value.payload);
else console.log(r.failure);
```

`signCose1(payload, signer, opts)` writes tag 18 with an attached payload. The protected header holds alg (1), the content type (3) if given, and the kid (4). Options:
- `contentType`: text or a CoAP content-format number;
- `omitKid`: leave the kid out, for radio frames (a 4-byte protected header);
- `unprotected`: a `Map` of unprotected header parameters (empty by default);
- `externalAad`: bytes bound into the signature but not sent.

`verifyCose1(bytes, key, opts)` returns `{ ok: true, value }` or `{ ok: false, failure }`.
- `key(kid, alg)` returns the keys that may have signed. The verifier tries each one. This fits a device whose previous key is still valid around a rotation.
- `value` has `payload`, `alg`, `kid`, the `protected` header as a `Map`, and, for `-65600`, `webauthn: { origin, flags: { up, uv, be, bs } }`.
- `failure` is one of `malformed`, `algNotAllowed`, `keyMismatch` (no key of the right curve), `signatureInvalid`, `webauthnChallenge`, `webauthnOrigin`, `webauthnFlags`.
- Options: `allowedAlgs` (default: all five), `webauthnOrigins` (required for `-65600`), `externalAad`.

`sigStructure(protected, payload, externalAad?)` returns the bytes that are signed.

### Passkey signatures (alg -65600)

The signature field holds CBOR `[authenticatorData, clientDataJSON, signature]`. The challenge is SHA-256 of the Sig_structure. The verifier checks, in this order:
1. `clientDataJSON.type` is `webauthn.get`, and its `challenge` is base64url of SHA-256 of the Sig_structure (else `webauthnChallenge`);
2. its `origin` is in `webauthnOrigins` (else `webauthnOrigin`);
3. `rpIdHash` is SHA-256 of that origin's host (else `webauthnOrigin`);
4. the UP and UV flags are set (else `webauthnFlags`);
5. the DER ECDSA P-256 signature verifies over `authenticatorData || SHA-256(clientDataJSON)`.

It reports the BE and BS flags. BS set means the passkey may be on the owner's other devices.

## Tests

`npm test`. They include:
- the COSE WG example `eddsa-sig-01` (Ed25519 Sign1), reproduced byte for byte;
- RFC 9052 Appendix C.2.1 (ES256 Sign1), verified;
- the encoding rules above, tampering, wrong keys, external AAD;
- passkey signatures from a synthetic authenticator that builds `authenticatorData` and `clientDataJSON` and signs them with a P-256 key.

## Differences from the design

- `seedSigner` and `webCryptoSigner` take an optional `alg`, so a signer can use `-8` or `-7` where a peer only knows those.
- `signCose1` also takes `unprotected` and `externalAad`, and `contentType` may be a number. `verifyCose1` also takes `externalAad`. The known-answer test needs `unprotected` and a numeric content type.
- `verifyCose1` accepts an untagged `COSE_Sign1` too.
- Keys of the wrong curve are dropped before checking. `keyMismatch` means no key of the right curve was found.
- A `-65600` signature fails with `webauthnOrigin` when no `webauthnOrigins` are given. A wrong `clientDataJSON.type` fails with `webauthnChallenge`.
- A P-256 public key can be a SEC1 point or a SubjectPublicKeyInfo, which is what `getPublicKey()` returns at registration.
- `-65600` signatures must be DER, as authenticators return them. `-7` and `-9` signatures must be raw `r || s`, as COSE requires.
- Detached payloads and critical headers (label 2) are refused as `malformed`.
- Strict decoding re-encodes the value and compares the bytes. So it refuses a float with an integral value, such as `1.0`, because the encoder writes such a number as an integer.
