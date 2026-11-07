# @toip-tools/did: design

DID tools for the toolkit: parse DIDs, resolve them under a network policy, find the right key, and verify signatures with it. Also build the documents and files that a controller publishes. Date: 2026-11-07. State: design written, not built.

Choices marked **(our call)** are the assistant's and open to change. Facts about specs and libraries cite section 17, with the date read.

## 1. Why

Today the toolkit understands one DID method. `trust-core`'s `resolveDidKey` turns an Ed25519 `did:key` into two public keys, and `@openvtc/trust-tasks-proof` verifies proofs only when the verification method is a `did:key`. `eventlog` writes `did:keri:<AID>`, but only its own code reads it. The site says so: "Nothing here resolves other DID methods."

That blocks real uses:

- **Tipline** pins an issuer's DID "from the organization's own website" and asks how sources can learn it safely (`projects/tipline/docs/design.md`, lines 440 and 754). `did:web` and `did:webvh` answer that.
- **Agora** expects licensing boards and employers to issue credentials. Those issuers won't use a `did:key` that they can never rotate.
- **Settle**'s arbiter publishes a key and builds a public track record. A key that can't rotate ends the track record when the key is lost.
- **Capture** devices have KERI key histories. Other tools can't check a device's signature without our own code.
- **The P2P Trust Stack** uses `did:peer:4` for VIDs and `did:scid:vh` for long-lived identity (S01, S02, S03). We can't talk to it with `did:key` only.

The package adds the missing layer once, so that every project gets it through `trust-core`.

## 2. Who uses it

| User | Needs |
|---|---|
| `trust-core` | keys for a TSP sender or recipient; a key for a Data Integrity proof, with its verification relationship checked |
| `eventlog` | a place to plug in the `did:keri` driver, and the shared document types |
| Projects | resolve an issuer, arbiter or device; build and publish their own `did:web` or `did:webvh` files |
| App developers outside this repo | a small, strict DID library for browsers and Node with no framework around it |

## 3. Goals, non-goals, anti-goals

**Goals**

1. Parse DIDs and DID URLs by the DID 1.1 syntax, and dereference a DID URL to a verification method, a service, or a service URL.
2. One resolver interface after the W3C DID Resolution model, with drivers that plug in.
3. Resolve `did:key`, `did:peer` (0, 2 and 4), `did:jwk`, `did:web`, `did:webvh` and `did:keri` in the first version.
4. Verify everything that a method lets a resolver verify: `did:webvh` logs (SCID, hash chain, signatures, pre-rotation, witnesses) and KERI key event logs.
5. Convert keys between Multikey, JsonWebKey and the older 2018, 2019 and 2020 key types, for Ed25519, X25519, P-256, P-384 and secp256k1.
6. Verify a raw signature, a Data Integrity proof, or a JWS or JWT, given a DID URL. Check the verification relationship every time.
7. Build `did:peer:2` and `did:peer:4` DIDs, and the files to host for `did:web` and `did:webvh`.
8. Runs in browsers and Node. The core makes no network calls and has no Node imports.
9. `trust-core` gains all this through optional parameters. Code that passes none behaves exactly as today.

**Non-goals (for now)**

- Ledger methods: `did:ethr`, `did:ion`, `did:cheqd`, `did:indy` and the like (section 7.10).
- `did:plc` (section 7.10).
- JSON-LD processing, and the RDF cryptosuites (`eddsa-rdfc-2022`, `ecdsa-rdfc-2019`). They need RDF canonicalization and context loading.
- Selective disclosure suites (`bbs-2023`, `ecdsa-sd-2023`).
- DIDComm. TSP is the toolkit's messaging layer.
- Key storage. Keys stay where they are today: `Identity`, `web-vault`, `eventlog` signers.
- A hosted resolver service.

**Anti-goals**

- **Silent network access.** No driver reaches the network unless the caller turned networking on and named the hosts, or explicitly allowed any public host.
- **Trusting a resolver's word for what can be checked.** A `did:webvh` log and a KERI KEL are verified here, every time, whoever supplied them. A remote resolver's answer is marked as unverified, and verifiers refuse it by default.
- **Quiet fallback.** If a local driver says "invalid", nothing asks another source.
- **Equivalence by assertion.** `alsoKnownAs`, `equivalentId` and a parallel `did:web` never make two DIDs the same for a signature check.
- **Guessing keys.** No key is used for a purpose its document doesn't give it. No X25519 key is derived from an Ed25519 key, except for `did:key` and `did:peer:0`, where the method defines it.
- **A framework.** No agent, plugin system, key manager or data store.

## 4. Threat model

What each method's document is worth depends on what stands behind it. Every resolution result carries an **assurance** level **(our call)**:

| Assurance | Methods | What stands behind it |
|---|---|---|
| `self-certifying` | `did:key`, `did:peer`, `did:jwk`, later `did:pkh` | the identifier itself. Nothing to fetch, nothing to fake. |
| `verified-history` | `did:webvh`, `did:keri`, later `did:scid:vh` and `did:webs` | a signed, hash-chained log that we verify. The host can withhold it or serve an old one, but can't forge it. |
| `web` | `did:web` | DNS and TLS only. Whoever controls the domain or the web server controls the keys. |
| `remote` | Universal Resolver, adapted third-party drivers | another party's word. |

Verifiers accept `self-certifying`, `verified-history` and `web` by default, and refuse `remote` unless the caller allows it.

| Threat | Defence | What's left |
|---|---|---|
| **DNS or web hijack, `did:web`.** An attacker serves a different `did.json`. | `did:web` results are `web`, never more. HTTPS only, no redirects, no IP literals or private addresses. Optional key pins: a verifier can pin the keys it saw first and get `keyChanged` when they change. We recommend `did:webvh` wherever a project controls the choice. | First contact trusts DNS and TLS. That is the method. |
| **Web hijack, `did:webvh`.** The host serves a forged, truncated or old log. | Forging fails: the SCID, the hash chain, the update-key signatures and pre-rotation are all checked by `didwebvh-ts`. Truncation and rollback: we keep the highest version seen per SCID and refuse anything older. With witnesses, a new entry also needs the witness threshold. | The host can withhold the log (`notFound`) or freeze it at the latest version we haven't seen yet. Split views need watchers (later). |
| **A lying Universal Resolver.** It returns any document it likes. | Off by default. Its results are `remote`. Verifiers refuse `remote`. It's never asked about a method with a local driver. | A caller who turns it on and accepts `remote` trusts it fully. |
| **Downgrade between methods.** A verifier is steered from `did:webvh` to its parallel `did:web`, or from a failing local driver to a remote one. | Issuer binding is the exact DID string. `alsoKnownAs` is never followed for verification. A local driver's error is final. `did:scid:vh` (later) maps to `did:webvh` only through the verified log. | None known. |
| **Key confusion.** An X25519 key used to verify a signature; a P-256 key read as secp256k1; a JWS `alg` that doesn't fit the key; a JWK with a private part; a `kid` naming a key in someone else's document. | Each step checks the next: verification method type ↔ key bytes and curve ↔ verification relationship ↔ cryptosuite or `alg`. JWKs with `d` are refused. A verification method must belong to the DID being resolved, and its `controller` must be that DID, unless the caller allows external methods. | None known. |
| **Cache poisoning.** A bad answer stays in the cache. | Only verified, successful results are cached. The cache key holds the DID and the version options. TTLs are bounded by the method's own TTL. Failures get a short, separate negative cache. Each resolver has its own cache. | A result stays good until its TTL ends, so a rotation shows late. `noCache` forces a fresh fetch. |
| **Attacker-chosen DIDs.** A TSP sender's VID is resolved before the message is authenticated, so any sender picks the host we contact (SSRF, denial of service). | The network is denied by default. With a host allowlist, other hosts are refused before any connection. Size cap (1 MiB), timeout (10 s), no redirects, a concurrency limit and a negative cache. In Node, the `/node` fetch also checks the resolved IP addresses. | In browsers, a public name that resolves to a private address passes the literal check. Use the allowlist there. |
| **Backdating with a retired key.** Someone holding a rotated-out `did:webvh` or KERI key signs a document and dates it before the rotation. | Verifiers check against the current version by default. A historical check (`at`) needs an independent time, such as a witness receipt or an anchor, not the proof's own `created`. | None, if callers use the default. |
| **Resolution loops.** A `did:webvh` entry signed by another `did:webvh`, and so on. | Nested resolution depth is limited to 4. | None known. |
| **Correlation.** Resolving a `did:web` tells the host who is asking and when. | Caching. Local methods for pairwise relationships (`did:peer`). | The host still learns of the first lookup. |

## 5. Wrap or build

Measured on 2026-11-07 with `npm view` and by installing each candidate in a scratch directory (not in this repository). "Last publish" is npm's `time.modified`. Sizes are the ESM entry, unminified, unless noted.

### The candidates

| Library | Version, last publish | Shape | Notes |
|---|---|---|---|
| `did-resolver` (DIF) | 6.0.0, 2026-09-21 | ESM, browser and Node, no dependencies, 5.7 KB | `Resolver` class, `parse()`, the common result types. The cache has no TTL. No network policy. Error codes are camelCase strings from the older resolution draft. |
| `web-did-resolver` (DIF) | 3.2.0, 2026-10-12 | ESM, 4.2 KB, depends on `did-resolver` | Calls `fetch` with default redirect handling. Accepts IP-literal hosts. No size or time limits. |
| `key-did-resolver` (Ceramic) | 4.0.0, 2026-10-30 | ESM, 3.1 MB installed | Pulls `multiformats` 13, `uint8arrays`, `varint` and an old `@noble/curves` 1.x. |
| `did-jwt` (DIF) | 9.0.2, 2026-09-29 | ESM, 500 KB installed | EdDSA, ES256, ES256K and more. Needs a `did-resolver` `Resolver`. Pulls `uint8arrays`, `multiformats` 14 and `canonicalize`. |
| `jose` | 6.2.15, 2026-11-01 | ESM, no dependencies | JWS and JWT, no DIDs. WebCrypto underneath; Ed25519 and secp256k1 depend on the runtime. |
| `@digitalbazaar/did-method-key` | 5.3.0, 2025-09-21 | ESM | Built on `did-io`, `ed25519-multikey` and `x25519-key-agreement-key-2020`, which pull `@noble/ed25519` 1.7, `tweetnacl` and `crypto-ld`. |
| `@digitalbazaar/did-io` | 2.2.0, 2026-05-29 | ESM | `CachedResolver` with an LRU. Fits Digital Bazaar's key-suite classes. |
| `@digitalbazaar/ed25519-multikey` | 1.3.1, 2025-02-14 | ESM | Ed25519 only, on `@noble/ed25519` 1.x. |
| `didwebvh-ts` (DIF) | 3.0.0, 2026-10-29 | ESM, CJS and a browser build (93 KB, dependencies bundled) | The did:webvh v1.0 TypeScript implementation. Create, update, deactivate, resolve from an in-memory log, witness proofs. `fetch` is injectable. Depends only on `@noble/curves` 2.4, `@noble/hashes` 2.4, `@scure/base` 2.4, `did-resolver` 6 and `json-canonicalize` 3. Its repository had 5 open issues. In the official test suite it passes all its own creation cases and every negative case. Cross-resolution with the other implementations differs only in metadata members, which the suite reports without normalizing (section 13). |
| `@interop/did-method-webvh` | 5.18.2, 2026-11-05 | ESM | Another did:webvh implementation. Its `@interop/data-integrity-core` needs Node 24; the repository runs Node 22. |
| `@estoc/did-peer` | 0.1.0, 2026-08-12 | ESM, about 28 KB | did:peer 2 and 4, pure. **Its repository is archived.** One release. |
| `@aviarytech/did-peer` | 1.1.2, 2025-07-29 | | Depends on the `buffer` polyfill. Ruled out. |
| `peer-did-resolver` (Veramo) | 2.0.0, 2024-01-22 | | Wraps an old `@aviarytech/did-peer` on `did-resolver` 4. |
| `@openvtc/vti-didcomm-js` | 0.14.0, 2026-11-05 | ESM, plain JS with types | OpenVTC's browser DIDComm. Has resolvers for did:key, did:peer:2 (only), did:webvh and `did:scid:vh:1`, and a careful egress guard. Depends on `didwebvh-ts` 2.8, which pulls `glob`, `js-yaml` and `cookie`. A whole DIDComm stack for a few modules. |
| Veramo `@veramo/did-*` | 7.0.2, 2026-11-01 | | A plugin framework: `@veramo/core-types`, `debug`, `cross-fetch`, `did-resolver` 4. |
| `@sphereon/did-resolver-key`, `@sphereon/ssi-sdk-ext.*` | 0.10.2-unstable.5 (2023-04-19); 0.40.1 | | Old unstable releases, or part of a large SDK. |
| `ethr-did-resolver` | 14.1.4, 2026-09-18 | | Needs `ethers` 6 and an Ethereum RPC endpoint. |
| `@atcute/did-plc` | 1.0.2, 2026-09-12 | | did:plc operations, on eight `@atcute/*` packages and `valibot`. |
| `webs-did-resolver`, `@gleif-it/did-webs-ts` | 0.1.0 (2026-06-27); 0.0.6 (2025-04-08) | | did:webs. Early. |
| `@scure/base` | 2.4.0 | ESM, no dependencies | base58btc and base64url. Already installed in the repository, through `@openvtc/trust-tasks-proof`. |

### Decisions

| Piece | Decision | Why |
|---|---|---|
| DID and DID URL syntax | **Build** (about 150 lines) | We need the DID 1.1 ABNF exactly, method-specific checks, and our error codes. `did-resolver`'s `parse()` is close but returns its own shape. |
| Document and result types | **Build**, shaped to match `did-resolver`'s types | One adapter (`fromDidResolver`, `toDidResolver`) then plugs any DIF driver in, at `remote` assurance. |
| Resolver registry, cache, network policy | **Build** | No candidate has deny-by-default networking, bounded TTLs, a negative cache and rollback detection. `@openvtc/vti-didcomm-js`'s egress guard is the model to follow: the same rules, written here, and tested against it. |
| Multibase, multicodec, base58, base64url | **Wrap `@scure/base` 2.4.0**, plus a 20-line varint table | Small, no dependencies, already installed. `multiformats` is bigger and built around CIDs. |
| Curves and hashes | **Wrap `@noble/curves` 2.4.0, `@noble/hashes` 2.4.0** | Already used everywhere in the repository. Covers all five key types and SHA-2. |
| JCS canonicalization | **Wrap `@openvtc/trust-tasks-proof` 0.1.6** (`canonicalBytes`) | Already a dependency of `trust-core`. Gives the same bytes that `signTrustTask` signs. |
| Key conversion | **Build** on the above | A few hundred lines. The Digital Bazaar classes bring older crypto and do one curve each. |
| `did:key` | **Build** | 100 lines over the key module. Behavior is pinned to `resolveDidKey` by tests (section 12). |
| `did:peer` | **Build** | The candidates are archived (`@estoc/did-peer`), ruled out (`@aviarytech/did-peer`), stale (`peer-did-resolver`), or numalgo 2 only (`@openvtc/vti-didcomm-js`). The algorithms are short and have reference vectors. |
| `did:jwk` | **Build** | 40 lines. |
| `did:web` | **Build** | The fetch must go through our policy. `web-did-resolver` follows redirects and allows IP literals. |
| `did:webvh` | **Wrap `didwebvh-ts` 3.0.0** | Log verification is subtle (SCID, entry hashes, pre-rotation, witness transitions, portability, IDNA hosts). This library is the DIF one, it passes the test suite's creation and negative cases, and it lets us supply the log, the witness file and every fetch. Ours is the network part. It lives in the `/webvh` subpath, so only its users load it. |
| `did:keri` | **Build, in `eventlog`** | `eventlog` already verifies KELs and passes KERIpy interop. The driver is a thin layer over `verifyKel`. |
| Data Integrity verification | **Build**, reusing `@openvtc/trust-tasks-proof` for `did:key` | Their verifier knows only `did:key` and doesn't check verification relationships. For `did:key` we call it, so results stay identical. For other methods we run the same `eddsa-jcs-2022` and `ecdsa-jcs-2019` algorithm with the resolved key. |
| JWS and JWT | **Build** (about 200 lines) | Compact JWS with EdDSA, ES256 and ES256K on `@noble/curves`, with our resolver and relationship checks. `did-jwt` and `jose` become test oracles. |
| Universal Resolver driver | **Build, later** | A 60-line HTTP client for `/1.0/identifiers/`. |

Test-only (development dependencies, never shipped): `did-jwt` 9.0.2, `jose` 6.2.15, `web-did-resolver` 3.2.0, `@digitalbazaar/did-method-key` 5.3.0, `@openvtc/vti-didcomm-js` 0.14.0.

Shipped dependencies, pinned exactly as the repository does: `@noble/curves` 2.4.0, `@noble/hashes` 2.4.0, `@scure/base` 2.4.0, `@openvtc/trust-tasks-proof` 0.1.6 (with its peer `@openvtc/trust-tasks` 0.28.17), and `didwebvh-ts` 3.0.0 for the `/webvh` subpath. `cborg` isn't needed: no first-version method uses CBOR.

## 6. Architecture

### Layers

```
@toip-tools/did          parse, types, keys, dereference, resolver, pure drivers, verifiers
      ▲
@toip-tools/trust-core   Endpoint, signDocument / verifyDocument, credentials, status lists
      ▲
@toip-tools/eventlog     KELs and trails; exports keriDriver()
      ▲
projects
```

`did` depends on nothing in this repository. `trust-core` depends on `did`. The `did:keri` driver lives in `eventlog`, because `eventlog` already depends on `trust-core`. Putting the driver in `did` would make a cycle **(our call)**.

### Entry points

The build and export layout is being reworked in parallel. These subpaths follow whatever convention that work settles on.

| Entry | Contents | Runs in |
|---|---|---|
| `@toip-tools/did` | syntax, types, keys, relationships, dereferencing, `DidResolver`, cache, network policy, drivers for `did:key`, `did:peer`, `did:jwk`, builders for `did:peer` and document edits, all verifiers, the `did-resolver` adapter | browsers and Node; no network unless a driver asks and the policy allows |
| `@toip-tools/did/web` | `did:web` driver and builder | browsers and Node |
| `@toip-tools/did/webvh` | `did:webvh` driver and builder (loads `didwebvh-ts`) | browsers and Node |
| `@toip-tools/did/universal` | Universal Resolver driver (later) | browsers and Node |
| `@toip-tools/did/node` | `nodeFetch` (checks resolved IP addresses at connect time), `writeHostingFiles` | Node only |

### Module layout

```
packages/did/
  src/
    index.ts             core exports
    syntax.ts            parseDid, parseDidUrl, absolutize
    document.ts          types, validateDocument, edit helpers
    keys.ts              PublicKey, Multikey, JWK, older key types, conversions
    multicodec.ts        the codec table
    relationships.ts     methodsFor, hasRelationship
    dereference.ts       fragments, service, relativeRef
    errors.ts            codes and type URIs
    resolver.ts          DidResolver, driver registry
    cache.ts             TTL and negative cache, in-flight dedupe
    net.ts               NetPolicy, guardedFetch
    methods/key.ts  peer.ts  jwk.ts
    methods/web.ts       → /web
    methods/webvh.ts     → /webvh
    methods/universal.ts → /universal (later)
    adapters/didResolver.ts
    verify/signature.ts  dataIntegrity.ts  jws.ts  tsp.ts
    build/peer.ts  web.ts  webvh.ts
    node/index.ts        → /node
  tests/
  docs/design.md
```

## 7. Methods

Each driver says what it verifies, and what it takes on trust.

### 7.1 did:key

Spec: did:key v0.9 (W3C CCG).

1. Parse `did:key:z<base58btc>`. Read the multicodec varint. Accept `ed25519-pub` (0xed, 32 bytes), `x25519-pub` (0xec, 32), `secp256k1-pub` (0xe7, 33 compressed), `p256-pub` (0x1200, 33 compressed), `p384-pub` (0x1201, 49 compressed). Refuse anything else as `invalidDid`.
2. Check the point is on the curve.
3. Build the document. One `Multikey` verification method, `<did>#<multibase>`, in `authentication`, `assertionMethod`, `capabilityInvocation` and `capabilityDelegation`. An X25519 key goes only in `keyAgreement`.
4. For Ed25519, add the derived X25519 key in `keyAgreement`, with id `<did>#<x25519 multibase>`, as the spec's `enableEncryptionKeyDerivation` describes. This is on by default **(our call)**, because the P2P Trust Stack and `trust-core` derive it (S02).

Verifies: everything. Assurance `self-certifying`. No network. Results are memoized in a bounded LRU, not cached by TTL.

`publicKeyFormat: "JsonWebKey"` gives `JsonWebKey` methods instead. A DID URL fragment must equal the key's own multibase, as `trust-core`'s CTT1 compaction already expects.

### 7.2 did:peer

Spec: Peer DID Method v1.0 draft (DIF).

- **numalgo 0.** The rest is a `did:key` value. Resolve it as `did:key`, with the `did:peer:0` id.
- **numalgo 2.** Split on `.`. Each element is a purpose code and a value: `A` assertion, `E` key agreement, `V` authentication, `I` capability invocation, `D` capability delegation, `S` service. Keys are multibase Multikeys and get ids `#key-1`, `#key-2`, … in the order they appear. Services are base64url JSON with the abbreviations `t`, `s`, `r`, `a` and `dm` → `DIDCommMessaging`. The first service without an id gets `#service`, then `#service-1`, and so on. Verification methods are `Multikey` type.
- **numalgo 4.** Long form `did:peer:4<hash>:<encoded document>`. Decode the document: base58btc, then the multicodec JSON prefix (0x0200), then UTF-8 JSON. Check that `<hash>` is the base58btc SHA-256 multihash (0x12 0x20) of the encoded document string. Then build the document: `id` is the DID, `alsoKnownAs` gains the short form, and each verification method without a `controller` gets the DID. Relative references are kept relative and also matched absolutely.
- **numalgo 4, short form.** It can't be resolved from the string. The driver takes an optional `PeerStore`. Every long form it resolves is stored under its short form. A short form not in the store is `notFound`.
- **numalgo 1 and 3** are refused as `methodNotSupported`. numalgo 1 has no current users that we know of. numalgo 3 is a short form of numalgo 2; it can be added with the same store if needed.

Verifies: everything, given the long form. Assurance `self-certifying`. No network.

Which form the P2P Trust Stack advertises as a TSP sender VID, long or short, is an open question (section 16).

### 7.3 did:jwk

Spec: did:jwk (a draft by Jeremie Miller).

1. base64url-decode the method-specific id. Parse UTF-8 JSON. Refuse private members (`d`, `p`, `q`, `dp`, `dq`, `qi`, `k`) and unknown `kty` or `crv`.
2. One verification method, `<did>#0`, type `JsonWebKey`. With `use: "enc"`, only `keyAgreement`. With `use: "sig"`, every relationship except `keyAgreement`. With no `use`, every relationship that fits the curve: X25519 gets only `keyAgreement`, signing curves get the other four **(our call; the spec is silent)**.

Verifies: everything. Assurance `self-certifying`.

### 7.4 did:web

Spec: did:web (W3C CCG).

1. Map the DID to a URL. `did:web:example.com` → `https://example.com/.well-known/did.json`. `did:web:example.com:user:alice` → `https://example.com/user/alice/did.json`. A port is written `%3A`. Refuse IP literals, userinfo, empty segments, `.` and `..`, and percent-encoded `/`.
2. Ask the network policy. If the host isn't allowed, fail with `networkNotAllowed` before any connection.
3. GET with `redirect: "error"`, `Accept: application/did+json, application/json`, the size cap and the timeout. HTTP 404 and 410 are `notFound`. Other failures are `internalError`.
4. Parse JSON. Check that `id` is exactly the DID, that every verification method's `controller` is the DID unless external methods are allowed, and that DID URLs in the document are absolute, as the spec requires.
5. TTL: `Cache-Control: max-age`, bounded by the cache's maximum. Default 5 minutes.

Verifies: the document's shape and its `id`. Trusts: DNS, TLS and the web server. Assurance `web`.

### 7.5 did:webvh

Spec: did:webvh v1.0 (DIF). Verification: `didwebvh-ts` 3.0.0.

1. Parse `did:webvh:<SCID>:<host>[:path…]`. Map it to the log URL: `https://<host>/.well-known/did.jsonl`, or `https://<host>/<path>/did.jsonl`. The witness file `did-witness.json` sits beside it.
2. Ask the network policy for the host.
3. Fetch `did.jsonl` ourselves: HTTPS only, no redirects, 1 MiB cap (the spec suggests up to 5 MiB; configurable), 10 s timeout. If any entry turns witnessing on, fetch `did-witness.json` the same way. A 404 on it means no proofs.
4. Call `resolveDIDFromLog(log, { witnessProofs, verifier, versionId, versionTime, versionNumber, fetch: refuse, resolveControlledDid })`. `fetch: refuse` is a function that always throws, so the library can never reach the network on its own. `resolveControlledDid` sends any nested `did:webvh` through our resolver, with the depth limit and the same policy.
5. The library checks, per the spec: the `method` parameter (`did:webvh:1.0`; unknown versions are refused, not downgraded); the SCID against the first entry; each entry hash and version number; each proof is `eddsa-jcs-2022`, purpose `assertionMethod`, by a key in the active `updateKeys`; pre-rotation, where every new update key must hash to one of the previous `nextKeyHashes`; witness thresholds, counting distinct listed witnesses; portability; and deactivation.
6. Rollback check, ours: a `VersionStore` holds the highest `versionNumber` and `versionId` verified per SCID. A log that ends earlier is refused with `invalidDidDocument` (detail `rollback`). The default store is in memory. A caller can supply a persistent one.
7. Map the result. `didDocumentMetadata` gets `versionId`, `created`, `updated`, `deactivated`, `nextVersionId` when not the latest, and a `webvh` member with `scid`, `updateKeys`, `nextKeyHashes`, `prerotation`, `portable`, `witness` and `watchers`. TTL is the log's `ttl` parameter (default 3600 s; 0 means don't cache).

Verifies: the whole log. Trusts: the host only for availability and freshness. Assurance `verified-history`.

DID URL paths resolve against the implicit `#files` service, and `/whois` against `#whois`. The dereferencer returns the URL. It doesn't fetch it.

### 7.6 did:keri (in eventlog)

Spec: none current. `did:keri` was an IETF draft (draft-pfeairheller-did-keri) that lapsed in November 2023, and DIF's KERI work item is archived. KERI's live DID method is `did:webs` (ToIP). `eventlog` uses `did:keri:<AID>` as its own name for "this AID, resolved from its KEL alone". We keep the name and say plainly that it is not a standard method **(our call)**. See section 16.

`keriDriver({ source })` takes a `KelSource`: anything that returns the KEL stream for an AID. `eventlog` provides sources for a `LogStore`, a `Watcher`, and a list of `WitnessClient`s (query each, merge, and let the watcher logic report duplicity).

1. Parse `did:keri:E<43 base64url>` (`aidOfDid`).
2. Get the stream from the source. No source, or no KEL, is `notFound`.
3. `verifyKel`. Any problem is `invalidDidDocument`, with the problem codes in the detail. Duplicity is the same, with code `duplicity`.
4. Build the document from the key state, following `did:webs`'s rules so that a later `did:webs` driver shares the code: one `JsonWebKey` method per current key, with the key's qb64 as fragment (`#D…` for Ed25519, `#1AAJ…` for P-256), in `authentication`, `assertionMethod` and `capabilityInvocation`.
5. If the signing threshold `kt` is greater than 1, the document still lists the keys, and `didDocumentMetadata.keri.threshold` says so. Verifiers then refuse a single signature (`thresholdNotMet`). Multi-signature checks go through `eventlog`'s `verifySignature`.
6. Verified DID bindings sealed in the KEL add their `did:key` to `alsoKnownAs`. The inception's `messagingDid` (Capture) is added too, but only when a binding for it is sealed. KERI has no encryption keys, so `keyAgreement` is empty. TSP to a device goes to its messaging DID.
7. Metadata: `versionId` is `<sn>-<SAID>` of the last establishment event, `created` and `updated` come from timed witness receipts where there are any, `deactivated` is true when the KEL is abandoned (empty next keys). A `keri` member holds `aid`, `sn`, `kt`, `witnesses`, `bt` and the receipt count.
8. `versionId` asks for the key state at that event. `versionTime` uses the earliest witness receipt time of each event, never a time the controller wrote.

Verifies: the whole KEL. Trusts: the source only for availability and freshness. Assurance `verified-history`.

### 7.7 did:scid:vh (later, first after the MVP)

The P2P Trust Stack's long-lived identifier (S01, S03). A ToIP draft defines `did:scid` as a method namespace over self-certifying identifiers. `did:scid:vh:1:<SCID>` is backed by a `did:webvh` log. A `?src=<host/path>` parameter says where the log is. It's a locator, not part of the identity. `@openvtc/vti-didcomm-js` implements it this way, mirroring Affinidi's Rust code.

Plan: map to `did:webvh:<SCID>:<src>`, resolve that through 7.5, check the SCID matches, and rewrite the document under the `did:scid` id. Keep a source book of the last good `src` per SCID, sharing the `did:webvh` rollback store. A bare `did:scid:vh:1:<SCID>` with no known source is `notFound`. This is a small layer once 7.5 exists, and it's the one that unlocks the P2P Trust Stack, so it comes first after the MVP **(our call)**.

### 7.8 did:pkh (later)

Spec: did:pkh draft (W3C CCG). `did:pkh:<CAIP-10 account>`. For `solana:<chain>:<address>`, the address is the Ed25519 public key, so the document carries a key that can verify. Legacy shape `Ed25519VerificationKey2018` with `blockchainAccountId`. We also add a `Multikey` form. For `eip155`, there is no public key: verification needs signature recovery (`EcdsaSecp256k1RecoveryMethod2020`), which this package doesn't do.

**Not for identifying Settle's parties.** Settle's anti-goal is that people's DIDs never appear on-chain, and its payment keys are fresh per payment. A `did:pkh` for a party would link the two. It's useful for naming a published Solana key (the processor's fee payer, the arbiter's on-chain key) and for wallet sign-in. So it waits until a project asks.

### 7.9 Universal Resolver (later)

`universalDriver({ url, methods })`. GET `<url>/1.0/identifiers/<did>` with `Accept: application/did-resolution`, through the network policy. Only for the listed methods, and never for a method with a local driver. Results are `remote`. DIF's public instance, `https://dev.uniresolver.io/`, is described as being for testing, so there is no default `url`.

### 7.10 Out

- **`did:plc`.** Bluesky's method. Its operation log is signed, but a single directory (`plc.directory`) orders it. No project here needs it. If one does, a driver over `@atcute/did-plc` fits the same interface.
- **`did:ethr`.** Needs an Ethereum RPC endpoint and `ethers`. Settle's first rail is Solana. Reach it through `fromDidResolver(ethr-did-resolver)` at `remote` assurance if needed.
- **`did:webs`.** Later, in `eventlog`. A conforming resolver must check a "designated aliases" ACDC anchored in the KEL, and `eventlog` has no ACDC support yet.

## 8. Resolution

### 8.1 The model

The W3C DID Resolution Candidate Recommendation Draft (2026-11-03) defines one function, `resolve(did, resolutionOptions)`, returning `didResolutionMetadata`, `didDocument` and `didDocumentMetadata`. Its earlier drafts had a separate `resolveRepresentation()`. The current draft merged the two, with an `accept` option. We follow the current draft: one `resolve`, plus `serialize(document, contentType)` for callers who need bytes.

Errors are RFC 9457 problem objects whose `type` is a URI, `https://www.w3.org/ns/did#<NAME>`. We set `type` to that URI, and also a short `code` that matches `did-resolver`'s camelCase codes:

| `code` | `type` | When |
|---|---|---|
| `invalidDid` | `…#INVALID_DID` | syntax, or a method's own rules |
| `invalidDidUrl` | `…#INVALID_DID_URL` | DID URL syntax |
| `invalidDidDocument` | `…#INVALID_DID_DOCUMENT` | the document or its log fails verification, rollback, duplicity |
| `notFound` | `…#NOT_FOUND` | no document, no log, unknown short form |
| `methodNotSupported` | `…#METHOD_NOT_SUPPORTED` | no driver for the method |
| `representationNotSupported` | `…#REPRESENTATION_NOT_SUPPORTED` | `accept` names a type we can't give |
| `invalidOptions` | `…#INVALID_OPTIONS` | conflicting `versionId` and `versionTime` |
| `featureNotSupported` | `…#FEATURE_NOT_SUPPORTED` | for example, a path on a method without paths |
| `internalError` | `…#INTERNAL_ERROR` | transport failures, bad HTTP status |
| `networkNotAllowed` | `https://toip.tools/spec/did/errors#networkNotAllowed` | the network policy refused the host (ours) |
| `timeout` | `https://toip.tools/spec/did/errors#timeout` | the request took longer than the policy allows (ours) |
| `tooLarge` | `https://toip.tools/spec/did/errors#tooLarge` | the response was over the size cap (ours) |

`resolve` never throws. Every failure is a result with `error` set and `didDocument: null`.

### 8.2 Network policy

```ts
interface NetPolicy {
  /** "none" (the default), a host allowlist, or any public host. */
  allow: "none" | { hosts: string[] } | "public";  // "example.com" or "*.example.com"
  maxBytes?: number;        // 1 MiB
  timeoutMs?: number;       // 10 s
  maxConcurrent?: number;   // 8 requests at a time per resolver
  allowInsecure?: boolean;  // http, for tests only; still no private hosts
  allowPrivate?: boolean;   // localhost, RFC 1918, link-local; for tests only
  fetch?: FetchLike;        // defaults to globalThis.fetch, or nodeFetch from /node
}
```

Every driver that fetches gets one `guardedFetch` from the resolver. A driver never sees the raw `fetch`. Checks, in order: scheme `https:`; no userinfo; host canonicalized by `URL`; not an IP literal; not a special-use name (`localhost`, `*.local`, `*.internal`, `*.home.arpa`); on the allowlist; then the request with `redirect: "error"`, a timeout and a streamed size cap. The allowlist only narrows. It never re-admits a private address. `/node`'s `nodeFetch` also checks every address the name resolves to at connect time.

### 8.3 Cache

```ts
interface CacheOptions {
  maxEntries?: number;      // 1000
  defaultTtlMs?: number;    // 5 minutes
  maxTtlMs?: number;        // 1 hour
  negativeTtlMs?: number;   // 30 s, for notFound and network errors only
}
```

- The key is the DID plus `versionId`, `versionTime` and `accept`.
- The TTL is the method's own (`did:web` `max-age`, `did:webvh` `ttl`), bounded by `maxTtlMs`.
- `invalidDidDocument` and `invalidDid` are not cached. They're cheap to repeat and must not stick.
- Concurrent calls for the same key share one request.
- `noCache: true` skips the cache for one call.
- Self-certifying methods use a bounded LRU memo, so unlimited distinct `did:key`s can't grow memory.

## 9. API

Short descriptions. Nothing throws on bad input unless it says so.

### 9.1 Syntax

```ts
interface ParsedDid { did: string; method: string; id: string }
interface ParsedDidUrl extends ParsedDid {
  url: string; path?: string; query?: string; fragment?: string;
  params: Record<string, string>;     // decoded query parameters; repeats are an error
}
function parseDid(s: string): ParsedDid | null;          // DID 1.1 ABNF; no path, query or fragment
function parseDidUrl(s: string): ParsedDidUrl | null;
function isDid(s: string): boolean;
function didOf(didUrl: string): string | null;           // "did:x:y#k" → "did:x:y"
function absolutize(ref: string, did: string): string;   // "#key-1" → "did:x:y#key-1"
```

### 9.2 Documents

```ts
type Relationship = "authentication" | "assertionMethod" | "keyAgreement" | "capabilityInvocation" | "capabilityDelegation";
interface VerificationMethod {
  id: string; type: string; controller: string;
  publicKeyMultibase?: string; publicKeyJwk?: Jwk; publicKeyBase58?: string; blockchainAccountId?: string;
}
interface Service { id: string; type: string | string[]; serviceEndpoint: string | object | (string | object)[] }
interface DidDocument {
  "@context"?: string | (string | object)[]; id: string; controller?: string | string[]; alsoKnownAs?: string[];
  verificationMethod?: VerificationMethod[]; service?: Service[];
  authentication?: (string | VerificationMethod)[]; assertionMethod?: …; keyAgreement?: …;
  capabilityInvocation?: …; capabilityDelegation?: …;
}
function validateDocument(doc: unknown, did: string): Problem[];   // id matches, ids unique, one key property per method
function methodsFor(doc: DidDocument, rel: Relationship): VerificationMethod[];  // references followed, embedded kept
function findMethod(doc: DidDocument, idOrRef: string): VerificationMethod | undefined;
function hasRelationship(doc: DidDocument, methodId: string, rel: Relationship): boolean;
function findService(doc: DidDocument, idOrRef: string): Service | undefined;
function serialize(doc: DidDocument, contentType?: "application/did" | "application/did+json" | "application/did+ld+json"): Uint8Array;

// Edits return a new document; the input is not changed.
function addVerificationMethod(doc: DidDocument, vm: VerificationMethod, rels: Relationship[]): DidDocument;
function removeVerificationMethod(doc: DidDocument, id: string): DidDocument;      // also from every relationship
function setRelationships(doc: DidDocument, id: string, rels: Relationship[]): DidDocument;
function addService(doc: DidDocument, service: Service): DidDocument;
function removeService(doc: DidDocument, id: string): DidDocument;
```

`Problem` is `{ code: string; message: string; path?: string }`, as in `eventlog`.

### 9.3 Keys

```ts
type KeyType = "Ed25519" | "X25519" | "P-256" | "P-384" | "secp256k1";
interface PublicKey { type: KeyType; bytes: Uint8Array }     // EC keys compressed
interface Jwk { kty: "OKP" | "EC"; crv: string; x: string; y?: string; use?: string; alg?: string; kid?: string }

function encodeMultikey(key: PublicKey): string;             // "z6Mk…", "z6LS…", "zDn…", "zQ3s…"
function decodeMultikey(mb: string): PublicKey;              // throws on unknown codec or a bad point
function keyToJwk(key: PublicKey): Jwk;
function keyFromJwk(jwk: Jwk): PublicKey;                    // throws on private members
function keyFromMethod(vm: VerificationMethod): PublicKey;   // throws on an unknown type or a type/curve mismatch
function methodFromKey(key: PublicKey, o: { id: string; controller: string; format?: "Multikey" | "JsonWebKey" }): VerificationMethod;
function ed25519ToX25519(key: PublicKey): PublicKey;          // for did:key and did:peer:0 only
function didKeyFromKey(key: PublicKey): string;
function keyFromDidKey(did: string): PublicKey | null;       // sync; what trust-core's resolveDidKey calls
function thumbprint(key: PublicKey): string;                 // RFC 7638, for pins
```

`keyFromMethod` reads:

| Type | Key property | Key types |
|---|---|---|
| `Multikey` | `publicKeyMultibase` | all five |
| `JsonWebKey`, `JsonWebKey2020` | `publicKeyJwk` | all five |
| `Ed25519VerificationKey2020` | `publicKeyMultibase` (with 0xed prefix) | Ed25519 |
| `Ed25519VerificationKey2018` | `publicKeyBase58` (raw) | Ed25519 |
| `X25519KeyAgreementKey2020` | `publicKeyMultibase` (with 0xec prefix) | X25519 |
| `X25519KeyAgreementKey2019` | `publicKeyBase58` (raw) | X25519 |
| `EcdsaSecp256k1VerificationKey2019` | `publicKeyJwk` | secp256k1 |

We write only `Multikey` and `JsonWebKey`.

### 9.4 Resolution

```ts
interface ResolveOptions {
  accept?: string; versionId?: string; versionTime?: string; versionNumber?: number;
  noCache?: boolean; signal?: AbortSignal;
}
type Assurance = "self-certifying" | "verified-history" | "web" | "remote";
interface ResolutionResult {
  didDocument: DidDocument | null;
  didResolutionMetadata: {
    contentType?: string; error?: DidError;
    assurance?: Assurance; driver?: string; retrieved?: string; cached?: boolean;
  };
  didDocumentMetadata: {
    created?: string; updated?: string; deactivated?: boolean; versionId?: string;
    nextUpdate?: string; nextVersionId?: string; equivalentId?: string[]; canonicalId?: string;
    webvh?: WebvhMetadata; keri?: KeriMetadata;
  };
}
interface DidError { type: string; code: DidErrorCode; title?: string; detail?: string }

interface DidDriver {
  method: string;                                    // "web", "webvh", "peer", …
  assurance: Assurance;
  network: boolean;                                  // true if it may fetch
  resolve(parsed: ParsedDid, opts: ResolveOptions, ctx: DriverContext): Promise<ResolutionResult>;
}
interface DriverContext {
  fetch: FetchLike;                                  // the guarded fetch; refuses when the policy says "none"
  resolve(did: string, opts?: ResolveOptions): Promise<ResolutionResult>;   // nested, depth-limited
  now(): number;
}

class DidResolver {
  constructor(o?: { drivers?: DidDriver[]; network?: NetPolicy; cache?: CacheOptions | false;
                    maxDepth?: number; fallback?: DidDriver });
  resolve(did: string, opts?: ResolveOptions): Promise<ResolutionResult>;
  dereference(didUrl: string, opts?: ResolveOptions): Promise<DereferenceResult>;
  methods(): string[];
}
/** did:key, did:peer and did:jwk. No network. */
function localResolver(o?: { peerStore?: PeerStore }): DidResolver;

// drivers
function keyDriver(o?: { deriveX25519?: boolean; publicKeyFormat?: "Multikey" | "JsonWebKey" }): DidDriver;
function peerDriver(o?: { store?: PeerStore }): DidDriver;
function jwkDriver(): DidDriver;
function webDriver(o?: { pins?: PinStore }): DidDriver;                           // /web
function webvhDriver(o?: { versions?: VersionStore; maxBytes?: number }): DidDriver; // /webvh
function universalDriver(o: { url: string; methods: string[] }): DidDriver;      // /universal, later
// in @toip-tools/eventlog
function keriDriver(o: { source: KelSource }): DidDriver;

interface PeerStore { get(short: string): Promise<string | undefined>; put(short: string, long: string): Promise<void> }
interface VersionStore { get(scid: string): Promise<{ versionNumber: number; versionId: string } | undefined>; put(…): Promise<void> }
interface PinStore { get(did: string): Promise<string[] | undefined>; put(did: string, thumbprints: string[]): Promise<void> }

// adapters for DIF drivers; results are "remote" unless the caller says otherwise
function fromDidResolver(method: string, entry: DidResolverRegistryEntry, o?: { assurance?: Assurance }): DidDriver;
function toDidResolver(resolver: DidResolver): DidResolverRegistry;

function guardedFetch(policy: NetPolicy): FetchLike;
```

### 9.5 Dereferencing

```ts
type DereferenceResult =
  | { ok: true; kind: "document"; document: DidDocument; metadata: ResolutionResult["didDocumentMetadata"] }
  | { ok: true; kind: "verificationMethod"; method: VerificationMethod; document: DidDocument; metadata: … }
  | { ok: true; kind: "service"; service: Service; document: DidDocument; metadata: … }
  | { ok: true; kind: "url"; url: string; service: Service; document: DidDocument; metadata: … }
  | { ok: false; error: DidError };
```

1. Parse the DID URL. Promote `versionId`, `versionTime` and `versionNumber` from the query to resolution options.
2. Resolve the DID. Deactivated documents dereference to an error, not to keys.
3. `service=<id>`: find exactly one service by id (relative or absolute). None or several is an error. With `relativeRef=<ref>`, join it to the service's single URL endpoint with WHATWG URL rules, refuse a result outside the endpoint's path (no `..` escape), and return `kind: "url"`.
4. A path: the method decides. `did:webvh` maps it through `#files`. Others: `featureNotSupported`.
5. A fragment: find the verification method or service with that id, comparing absolute forms. Embedded methods in relationships count.
6. Otherwise, the document.

Dereferencing never fetches the target of a service. The DID Resolution draft marks dereferencing "at risk", so this follows its current text and may change.

### 9.6 Builders

```ts
// did:peer
function peer2(o: { keys: { purpose: "A" | "E" | "V" | "I" | "D"; key: PublicKey }[]; services?: PeerService[] }): string;
function peer4(input: InputDocument): { long: string; short: string };
function peerInputFor(o: { signing: PublicKey; agreement?: PublicKey; services?: Service[] }): InputDocument;
                                                     // #key-1 signing (V, A, I, D), #key-2 agreement (E)

// did:web  (/web)
function webDid(host: string, path?: string[]): string;                    // port as %3A
function webDocumentUrl(did: string): string;                             // https://…/did.json
function webDocument(did: string, o: { keys: { key: PublicKey; rels: Relationship[]; id?: string }[]; services?: Service[];
                                       alsoKnownAs?: string[] }): DidDocument;
function webHostingFiles(doc: DidDocument): { path: string; contentType: string; body: string }[];  // ".well-known/did.json"

// did:webvh  (/webvh); wraps didwebvh-ts createDID / updateDID / deactivateDID
interface DidSigner { verificationMethod: string; keyType: KeyType; sign(bytes: Uint8Array): Promise<Uint8Array> }
function createWebvh(o: { host: string; path?: string[]; signer: DidSigner; updateKeys: PublicKey[];
                          document: Omit<DidDocument, "id">; nextKeys?: PublicKey[];
                          witnesses?: { ids: string[]; threshold: number }; watchers?: string[];
                          portable?: boolean; parallelDidWeb?: boolean; now?: Date }):
  Promise<{ did: string; document: DidDocument; log: WebvhLog }>;
function updateWebvh(o: { log: WebvhLog; signer: DidSigner; document?: DidDocument; updateKeys?: PublicKey[];
                          nextKeys?: PublicKey[]; witnesses?: { ids: string[]; threshold: number } | null;
                          witnessProofs?: WitnessProofs; now?: Date }):
  Promise<{ did: string; document: DidDocument; log: WebvhLog }>;
function rotateWebvh(o: { log: WebvhLog; signer: DidSigner; to: PublicKey[]; nextKeys?: PublicKey[]; … }): Promise<…>;  // updateWebvh, keys only
function deactivateWebvh(o: { log: WebvhLog; signer: DidSigner; witnessProofs?: WitnessProofs }): Promise<{ log: WebvhLog }>;
                                                     // with pre-rotation on, writes the two entries the spec needs
function witnessWebvh(o: { log: WebvhLog; versionId: string; witness: DidSigner }): Promise<WitnessProofEntry>;
function webvhHostingFiles(log: WebvhLog, o?: { witnessProofs?: WitnessProofs; parallelDidWeb?: boolean }):
  { path: string; contentType: string; body: string }[];  // did.jsonl (text/jsonl), did-witness.json, did.json
function nextKeyHash(key: PublicKey): string;

// /node
function writeHostingFiles(dir: string, files: { path: string; body: string }[]): Promise<void>;
```

`webvhHostingFiles` lists `did-witness.json` before `did.jsonl`, because the spec says witness proofs must be published first. `did:webvh` v1.0 allows only `eddsa-jcs-2022`, so update keys and witnesses are Ed25519. The document itself can hold any key type.

### 9.7 Verifiers

```ts
type VerifyFailure =
  | "malformed" | "unresolvable" | "deactivated" | "assuranceTooLow" | "methodNotFound"
  | "externalMethod" | "relationshipMissing" | "keyTypeMismatch" | "algorithmMismatch"
  | "thresholdNotMet" | "keyChanged" | "issuerMismatch" | "signatureInvalid"
  | "notYetValid" | "expired" | "unsupportedCryptosuite";
type Verified =
  | { ok: true; did: string; method: VerificationMethod; key: PublicKey; assurance: Assurance; versionId?: string }
  | { ok: false; failure: VerifyFailure; detail: string; error?: DidError };

interface VerifyOptions {
  resolver: DidResolver;
  accept?: Assurance[];             // default: everything but "remote"
  allowExternalMethods?: boolean;   // default false
  at?: { versionId: string } | { versionTime: string; evidence: "witnessReceipt" | "anchor" };  // historical checks
}

/** Resolve → find the method → check the relationship → verify by key type. */
function verifySignature(o: VerifyOptions & {
  verificationMethod: string;       // a DID URL
  relationship: Relationship;
  message: Uint8Array; signature: Uint8Array;
  algorithm?: "EdDSA" | "ES256" | "ES384" | "ES256K";   // default: from the key type; ECDSA signatures are r‖s
}): Promise<Verified>;

/** A W3C Data Integrity proof: eddsa-jcs-2022 or ecdsa-jcs-2019. */
function verifyDataIntegrity(doc: object, o: VerifyOptions & {
  purpose?: Relationship;           // default: the proof's own proofPurpose, which must be a relationship
  bind?: "issuer" | "none" | { did: string };   // default "issuer": the method's DID must equal doc.issuer, exactly
  now?: () => number; clockSkewMs?: number;
  cryptosuites?: ("eddsa-jcs-2022" | "ecdsa-jcs-2019")[];
}): Promise<Verified>;

/** The ProofVerifier that @openvtc/trust-tasks and TspConsumer take. */
function dataIntegrityProofVerifier(o: Parameters<typeof verifyDataIntegrity>[1]): { verify(doc: object): Promise<boolean> };

/** Compact JWS. `kid` must be a DID URL. */
function verifyJws(jws: string, o: VerifyOptions & { relationship?: Relationship; algorithms?: ("EdDSA" | "ES256" | "ES256K")[] }):
  Promise<Verified & { payload?: Uint8Array; header?: object }>;
/** A JWT. `iss` must be the `kid`'s DID. Checks `exp`, `nbf`, and `aud` if given. */
function verifyJwt(jwt: string, o: VerifyOptions & { audience?: string; now?: () => number; clockSkewMs?: number }):
  Promise<Verified & { claims?: Record<string, unknown> }>;
function signJws(payload: Uint8Array | object, signer: DidSigner, header?: object): Promise<string>;
function signJwt(claims: object, signer: DidSigner): Promise<string>;

/** The two keys TSP needs: Ed25519 in authentication, X25519 in keyAgreement. */
function tspKeys(vid: string, o: VerifyOptions): Promise<
  { ok: true; signingKey: Uint8Array; encryptionKey: Uint8Array; assurance: Assurance } | { ok: false; failure: VerifyFailure; detail: string }>;
```

The rules, in order, for every verifier:

1. The verification method is a DID URL. Its DID resolves, at an accepted assurance, and isn't deactivated.
2. The method is in that document. Its `controller` is the DID, unless external methods are allowed.
3. The method is listed under the relationship: `authentication` for TSP and log-ins, `assertionMethod` for credentials and Trust Task documents (the default `proofPurpose` that `signTrustTask` writes), `capabilityInvocation` for capabilities.
4. The key type fits the algorithm. Ed25519 with `EdDSA` and `eddsa-jcs-2022`. P-256 with `ES256` and `ecdsa-jcs-2019`. P-384 with `ES384` and `ecdsa-jcs-2019`. secp256k1 with `ES256K` only; no W3C Data Integrity suite uses it. X25519 never signs.
5. A KERI document with `kt > 1` refuses single signatures.
6. For `did:web` with a `PinStore`, a key outside the pinned set gives `keyChanged`.
7. The signature verifies. ECDSA accepts high-S, as `@openvtc/trust-tasks-proof` does, so the two give the same answers.

For `did:key` issuers, `verifyDataIntegrity` calls `@openvtc/trust-tasks-proof`'s `DataIntegrityProofVerifier`, then checks the relationship. The relationship check can't fail for a valid `did:key` proof with purpose `assertionMethod` or `authentication`, so results for today's documents don't change.

`tspKeys` takes the first Ed25519 method in `authentication` and the first X25519 method in `keyAgreement`. It derives the X25519 key only for `did:key` and `did:peer:0`. A document without both is `relationshipMissing`. How the P2P Trust Stack chooses among several keys is an open question.

## 10. trust-core integration

Every change is additive. With no new parameters, `trust-core` behaves exactly as today. The existing tests are the proof.

### 10.1 Identity and did:key

- `resolveDidKey(did)` keeps its signature, its return value and its error text (`"not an Ed25519 did:key"`). It becomes a wrapper over `did`'s `keyFromDidKey` and `ed25519ToX25519`. It stays synchronous, because the relay, `mesh-transport` and CTT1 compaction call it in hot paths, and they stay `did:key`-only.
- New: `identityWithDid(identity, did, verificationMethod)`. It returns an `Identity` with the same keys, whose `did` is the new DID and whose `signer` names the new verification method. `@openvtc/trust-tasks-proof`'s `Signer` is a plain object with `did` and `verificationMethod`, and `signTrustTask` only checks that `issuer` equals `signer.did`. So signing needs no change.
- New: `peerIdentity(identity, services?)`. Builds a `did:peer:4` from the identity's Ed25519 and X25519 keys (via `peerInputFor`) and returns `identityWithDid(…)` for it.
- New: `didSigner(identity)`. Adapts an `Identity` to the `DidSigner` that the `/webvh` builders and `signJws` take.

### 10.2 Endpoint and TSP

```ts
new Endpoint({ identity, transport, clock, resolver?: DidResolver, acceptAssurance?: Assurance[] })
```

- With no `resolver`, the endpoint uses `resolveDidKey` exactly as now.
- With a `resolver`, `TspConsumer`'s `resolveSender` (which may already return a promise) calls `tspKeys(vid, { resolver })`. A failure throws the same error the consumer already handles, so the message is refused as today.
- `recipientKey(to)` becomes `async`. It's private, and its only caller, `pack`, is already `async`. A failure is still `TaskError("undelivered", "can't resolve <to>")`.
- `receive` resolves the advertised sender the same way.
- The endpoint's `proofVerifier` becomes `dataIntegrityProofVerifier({ resolver, now })` when a resolver is given. It implements the `ProofVerifier` interface from `@openvtc/trust-tasks/runtime` (`verify(doc) → Promise<boolean>`). Otherwise it stays `DataIntegrityProofVerifier`.
- The consumer resolves a sender before the message is authenticated. Use `TspConsumer`'s `allowedSenders` or a host allowlist on any resolver that can fetch (section 4).

### 10.3 Documents, credentials and status lists

```ts
verifyDocument(doc, clock, opts?: { resolver?: DidResolver; accept?: Assurance[] })
verifyCredential(vc, clock, opts?)
checkStatus(doc, index, expectedIssuer, clock, opts?)
```

- With no `opts`, nothing changes.
- With a `resolver`, a proof whose verification method is a `did:key` goes through `DataIntegrityProofVerifier`, as now. Any other goes through `verifyDataIntegrity` with `bind: "issuer"`, the same 5-minute skew, and the purpose check.
- The result keeps the `ProofVerification` shape (`valid`, `failure`, `detail`). The failure union isn't widened, so no `switch` breaks: resolution failures map to `signatureInvalid`, with the real reason in `detail`. `issuerMismatch` and `malformedProof` keep their meaning.
- `signDocument` and `issueCredential` work unchanged for any DID through `identityWithDid`.

### 10.4 What stays did:key

The relay's authentication, `mesh-transport`, CTT1 compaction (it already falls back to text for other DIDs) and `eventlog`'s witness identities. Each could take a resolver later. None needs to now.

## 11. eventlog integration

Additive exports in `@toip-tools/eventlog`:

```ts
function keriDriver(o: { source: KelSource }): DidDriver;
type KelSource = (aid: Qb64) => Promise<string | undefined>;      // a CESR stream
function storeSource(store: LogStore): KelSource;
function watcherSource(watcher: Watcher): KelSource;
function witnessSource(clients: WitnessClient[]): KelSource;      // queries each, merges, keeps duplicity evidence
function keriDocument(kel: KelResult, o?: { bindings?: DidBinding[] }): DidDocument;
```

`aidDid` and `aidOfDid` stay as they are. Capture's `deviceDid` already uses them. Capture's design still writes `did:trail:…` as a placeholder; `did:keri` is the name in code.

An idea for later **(ours)**: `did:webvh` witnesses are `did:key`s that sign `eddsa-jcs-2022` proofs over a `versionId`. `eventlog`'s witnesses are Ed25519 `did:key`s already. One witness service could witness both KELs and `did:webvh` logs.

## 12. What the projects gain

| Project | Today | With this package |
|---|---|---|
| **Settle** | every party is a `did:key` | The arbiter and processor publish `did:webvh` DIDs: their keys rotate without losing the track record, and pre-rotation and witnesses guard the arbiter's key. Payees that are businesses can use `did:web` or `did:webvh`. Payment keys and their bindings don't change, and DIDs still never go on-chain. |
| **Tipline** | the issuer DID is pinned by hand | The organization publishes `did:webvh` on its own site. The journalist pins the SCID once. Later rotations verify against the log. |
| **Agora** | issuers are `did:key` | Licensing boards and employers issue under `did:web` or `did:webvh`. `verifyCredential` and `checkStatus` take a resolver. |
| **Capture** | device keys are checked with `eventlog` only | Device DIDs (`did:keri`) resolve to documents. Any verifier with a resolver checks a device's P-256 `ecdsa-jcs-2019` proof. Multi-signature and historical checks still use `eventlog`'s `verifySignature`. |
| **Shared To-Do, Mesh, Community Rides** | `did:key` instead of the stack's `did:peer:4` (their design docs say so) | `peerIdentity` gives `did:peer:4` VIDs, one per relationship if wanted. A step towards talking to the P2P Trust Stack. |
| **Trail** | `did:keri` | The same, readable by any tool that loads `keriDriver`. `did:webs` later. |
| **The site** | "Nothing here resolves other DID methods." | The concepts page can say which methods resolve, and at which assurance. |

## 13. Test plan

### Official vectors

| Area | Vectors |
|---|---|
| `did:key` | The spec's Test Vectors section: Ed25519 (with and without the derived X25519), secp256k1, P-256, P-384 |
| `did:peer` | The spec's examples for numalgo 2 and 4. The fixtures in `dbluhm/did-peer-4`, the numalgo 4 reference code the spec names |
| `did:jwk` | The spec's examples (P-256, X25519) |
| `did:webvh` | `decentralized-identity/didwebvh-test-suite`: every scenario under `vectors/`, positive and negative (basic create and update, key rotation, pre-rotation, witness threshold and update, portability, services, IDNA hosts, path traversal, SCID mismatch, wrong cryptosuite, unknown method version, `versionTime` edge cases). Served from a local test server through our driver, so the network layer is tested too |
| Data Integrity | The `eddsa-jcs-2022` and `ecdsa-jcs-2019` examples in the W3C EdDSA and ECDSA cryptosuite specs |
| JWS | RFC 8037 appendix A.4 (Ed25519, deterministic), RFC 7515 appendix A.3 (ES256, verify only), RFC 8812 (ES256K) |
| Keys | RFC 7638 thumbprints. Multikey examples from Controlled Identifiers v1.0 |
| `did:keri` | `eventlog`'s KERIpy fixtures and interop tests, as today |

### Interop

- **`did:key`:** documents from `@digitalbazaar/did-method-key` 5.3.0 match ours, up to `@context` order.
- **`did:web`:** `web-did-resolver` 3.2.0 and our driver return the same document from the same local HTTPS fixture.
- **`did:peer` and `did:webvh`:** `@openvtc/vti-didcomm-js` 0.14.0 resolves our `did:peer:2` DIDs and our `did:webvh` logs, and we resolve theirs. Its egress guard and ours refuse the same list of hostile URLs.
- **`did:webvh`:** later, register this package as an implementation in the test suite, so other implementations cross-resolve our logs.
- **JWT:** `did-jwt` 9.0.2 verifies JWTs that we sign, and we verify JWTs that it signs, for EdDSA, ES256 and ES256K. Same with `jose` 6.2.15 for plain JWS.
- **Python:** `dbluhm/did-peer-4` round-trips our numalgo 4 DIDs.

### Security tests

- Network: denied by default; allowlist; IP literals in every form (`https://2130706433/`, `[::ffff:7f00:1]`); special-use names; redirects; userinfo; responses over the size cap; slow responses; plaintext only with `allowInsecure`.
- No fallback: a local driver's `invalidDidDocument` is never retried on the Universal Resolver.
- Cache: failures aren't cached; version options are part of the key; `did:webvh` rollback is refused; concurrent calls share one fetch.
- Key confusion: an X25519 key in `authentication`; an Ed25519 key labeled P-256; a JWS `alg` that doesn't fit the key; a JWK with `d`; a `kid` that isn't a DID URL; a method whose `controller` is another DID; a method listed under `keyAgreement` only, used for a proof.
- Backdating: a `did:webvh` proof by a rotated-out key, dated before the rotation, fails by default.
- Depth: a chain of nested `did:webvh` resolutions stops at 4.

### trust-core regression

- The whole existing `trust-core` suite passes with no resolver given.
- It passes again with `localResolver()` given everywhere.
- For 1,000 random seeds, `keyDriver`'s document gives the same signing and encryption keys as `resolveDidKey`.
- A `did:peer:4` Endpoint and a `did:key` Endpoint exchange Trust Tasks over the in-memory Bus.
- A credential issued under `identityWithDid` for a local `did:webvh` verifies with a resolver, and fails without one.

## 14. MVP and later

**MVP**

- Core: syntax, types, keys (five key types, all listed formats), relationships, dereferencing, edits.
- `DidResolver`, network policy, cache, `fromDidResolver` and `toDidResolver`.
- Drivers: `did:key`, `did:peer` (0, 2, 4 with a store), `did:jwk`, `did:web`, `did:webvh`, `did:keri` (in `eventlog`).
- Builders: `did:peer:2` and `:4`, `did:web` documents and files, `did:webvh` create, update, rotate, deactivate, witness, and hosting files.
- Verifiers: raw signatures, Data Integrity (`eddsa-jcs-2022`, `ecdsa-jcs-2019`), JWS and JWT (EdDSA, ES256, ES256K), `tspKeys`.
- `trust-core`: sections 10.1 to 10.3.

**Next, in order**

1. `did:scid:vh`, for the P2P Trust Stack.
2. A persistent `VersionStore`, `PeerStore` and `PinStore` on IndexedDB (with `web-vault`) and on files (`/node`).
3. `did:pkh` for Solana.
4. `did:webs` in `eventlog`, once it can verify designated-aliases ACDCs.
5. The Universal Resolver driver.
6. `did:webvh` watchers, to detect split views.

**Not planned:** `did:plc`, `did:ethr` and other ledger methods (reachable through `fromDidResolver` at `remote` assurance), RDF and selective-disclosure cryptosuites, DIDComm.

## 15. Changes from the brief

- **`resolveRepresentation`.** The current DID Resolution draft (2026-11-03) merged it into `resolve` with an `accept` option. We follow the draft. Error types are URIs now, so we carry the URI and a short code.
- **`did:key` stays in `trust-core`'s API.** The implementation moves into `did`. `resolveDidKey` remains a synchronous wrapper, because hot paths call it.
- **`did:keri` lives in `eventlog`.** `did` must not depend on `eventlog`, since `eventlog` depends on `trust-core`, which will depend on `did`. And `did:keri` has no current spec, so we call it the toolkit's own name.
- **`did:scid:vh` is added.** The P2P Trust Stack's Layer 1 identifier is `did:scid:vh`, not plain `did:webvh` (S01, S03). It is first after the MVP.
- **`did:pkh` moves to later,** and it isn't for naming Settle's parties.
- **The Universal Resolver moves to later.** No project needs a method that lacks a local driver.
- **P-384 is added.** `@openvtc/trust-tasks-proof` already verifies `ecdsa-jcs-2019` with P-384, so we read the same keys.
- **No cryptosuite for secp256k1.** No W3C Data Integrity suite uses it. It's supported for JWS (ES256K) and key conversion only.

## 16. Open questions

1. Does the P2P Trust Stack advertise the long or the short form of `did:peer:4` as a TSP sender VID? Its `issuer` binding, and whether a receiver needs a `PeerStore`, depend on it. We can't read its code; a wire test against it would answer this.
2. When a document has several Ed25519 methods in `authentication` or several X25519 methods in `keyAgreement`, which one does TSP use? We take the first.
3. Should issuer binding accept the `did:peer:4` short and long forms as one DID, or `did:scid:vh` and its `did:webvh`? We say no for now. An explicit option could say yes for those two pairs only, where the method defines the equivalence.
4. Should `did:keri` become `did:webs` everywhere once `eventlog` can do designated aliases, or should both stay?
5. Where do `did:web` key pins and the `did:webvh` version store live in a browser app: `web-vault`, IndexedDB, or the app's choice?
6. Should one witness service, `eventlog`'s, also witness `did:webvh` logs (section 11)?
7. The did:jwk spec doesn't say which relationships a JWK without `use` gets. Our rule (section 7.3) needs checking against other implementations.
8. The DID Resolution draft marks DID URL dereferencing "at risk". If it's cut, `dereference` stays as our own helper.

## 17. Sources

Read on 2026-11-07 unless marked. Specs were read through a fetch tool that summarizes long pages, so the details we rely on are listed in the test plan for checking against the full text.

**Specs**

- W3C Decentralized Identifiers (DIDs) v1.1, Candidate Recommendation Snapshot, 2026-03-05: https://www.w3.org/TR/did-1.1/ (syntax, relationships, Multikey and JsonWebKey).
- W3C DID Resolution, Candidate Recommendation Draft, 2026-11-03: https://www.w3.org/TR/did-resolution/ (`resolve`, metadata, error URIs, HTTP binding and status codes, dereferencing "at risk").
- W3C DID Core 1.0, Recommendation, 2022-07-19: https://www.w3.org/TR/did-1.0/. Not re-read today.
- W3C Controlled Identifiers v1.0 (Multikey, JsonWebKey) and the Data Integrity EdDSA and ECDSA cryptosuites: https://www.w3.org/TR/cid-1.0/, https://www.w3.org/TR/vc-di-eddsa/, https://www.w3.org/TR/vc-di-ecdsa/. Not read today.
- did:key v0.9 (W3C CCG): https://w3c-ccg.github.io/did-key-spec/ (codecs, X25519 derivation, test vectors).
- Peer DID Method v1.0 draft (DIF): https://identity.foundation/peer-did-method-spec/ (numalgo 2 and 4).
- did:web (W3C CCG): https://w3c-ccg.github.io/did-method-web/.
- did:webvh v1.0 (DIF): https://identity.foundation/didwebvh/v1.0/ (SCID, entry hashes, pre-rotation, witnesses, security considerations).
- did:webvh test suite: https://github.com/decentralized-identity/didwebvh-test-suite (README, vector list, `implementations/ts/status.md`).
- did:jwk: https://github.com/quartzjer/did-jwk/blob/main/spec.md.
- did:pkh draft (W3C CCG): https://github.com/w3c-ccg/did-pkh/blob/main/did-pkh-method-draft.md.
- did:webs v0.10.3 (ToIP): https://trustoverip.github.io/kswg-did-method-webs-specification/ (files, KEL-derived documents, designated aliases).
- did:keri IETF draft, lapsed 2023-11-05: https://weboftrust.github.io/ietf-did-keri/draft-pfeairheller-did-keri.txt. Status from a web search, not read.
- did:scid working draft (ToIP wiki): https://lf-toip.atlassian.net/wiki/spaces/HOME/pages/88572360. Seen in search results only.
- DIF Universal Resolver: https://github.com/decentralized-identity/universal-resolver (README).

**Code** (installed in a scratch directory, not in this repository)

- `didwebvh-ts` 3.0.0: types, `resolveDIDFromLog`, the injectable `fetch`, `resolveControlledDid`. https://github.com/decentralized-identity/didwebvh-ts
- `@openvtc/vti-didcomm-js` 0.14.0: `src/did-webvh.js`, `src/did-scid.js`, `src/net-guard.js`, `src/did-peer.js`, and the upstream issues they cite (didwebvh-ts #158, #185). https://github.com/OpenVTC/vti-didcomm-js
- `did-resolver` 6.0.0, `web-did-resolver` 3.2.0, `did-jwt` 9.0.2, `jose` 6.2.15, `key-did-resolver` 4.0.0, `@digitalbazaar/did-method-key` 5.3.0, `@estoc/did-peer` 0.1.0: package metadata, dependency trees and entry files.
- npm metadata for the other candidates in section 5.

**This repository**

- `docs/sources/S01`–`S04`: the P2P Trust Stack's `did:peer:4` and `did:scid:vh`, and the OpenVTC libraries.
- `packages/trust-core/src/identity.ts`, `tasks.ts`, `credentials.ts`, `statusList.ts`, `compact.ts`.
- `node_modules/@openvtc/trust-tasks-proof` 0.1.6 (`verifier.js`, `sign.d.ts`, `keys.d.ts`) and `@openvtc/trust-tasks-tsp` 0.1.2 (`consumer.d.ts`: `resolveSender` may return a promise).
- `packages/eventlog/src/cesr.ts`, `binding.ts` and its README.
- `site/src/pages/concepts.ts` and `ecosystem.ts`.
- Project designs: Settle, Tipline, Agora, Capture, Trail, Community Rides, Mesh, Shared To-Do.

## Decisions made (2026-11-07)

The open questions above were settled by the coordinator so the package can be built. Each can be revisited.

- **did:peer:4 forms.** Accept both forms everywhere. A sender advertises the long form on first contact and may use the short form after; the resolver keeps long forms it has seen in its `PeerStore`, so a short form resolves once the long form has been seen.
- **Which key TSP uses.** Encryption uses the first `keyAgreement` method of a supported type. A signature is accepted if it verifies under any method in the relationship being checked (`authentication` for TSP senders, `assertionMethod` for documents and credentials).
- **Equivalent forms.** Issuer matching treats the long and short forms of one did:peer:4 as the same DID, by canonicalizing to the long form's hash. No other equivalence: a did:web and a did:webvh for the same domain are different DIDs.
- **did:keri and did:webs.** did:keri stays in `eventlog` for the MVP. did:webs is in the "later" list.
- **Stores in browser apps.** Key pins, `PeerStore` entries and webvh version stores go in `@toip-tools/web-vault` blobs, sealed like the rest of an account's state. Node uses the JSON-file stores.
- **Witnessing webvh logs with eventlog's witnesses.** Later.
- **did:jwk without `use`.** Follow the did:jwk spec: a key with no `use` goes in every relationship its key type allows (Ed25519 and P-256 for signing relationships; X25519 for key agreement only).
- **Dereferencing marked at risk in the draft.** Implement it anyway; the toolkit needs fragment and service dereferencing whatever the draft's final form.
