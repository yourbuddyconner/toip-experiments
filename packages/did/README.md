# @toip-tools/did

DID tools for the toolkit: parse DIDs and DID URLs, resolve them under a network policy, find the right key for the job, and verify signatures with it. It also builds the DIDs and the files a controller publishes.

**State: design written, not built.** The design is `docs/design.md`. Section 9 is the API.

## Why

Today the toolkit resolves one method: Ed25519 `did:key`, through `trust-core`'s `resolveDidKey`. Issuers can't rotate keys, and we can't talk to the P2P Trust Stack, which uses `did:peer:4` and `did:scid:vh`. This package adds the missing layer once. `trust-core` takes it through optional parameters, so code that passes none behaves as today.

## What's planned

**Methods, first version:**

| Method | Verifies | Network |
|---|---|---|
| `did:key` | everything; the key is the DID | none |
| `did:peer` 0, 2, 4 | everything, given the long form | none |
| `did:jwk` | everything | none |
| `did:web` | the document's shape and id; DNS and TLS are trusted | HTTPS, if allowed |
| `did:webvh` | the whole log: SCID, hash chain, signatures, pre-rotation, witnesses, and rollback | HTTPS, if allowed |
| `did:keri` (in `eventlog`) | the whole key event log | whatever KEL source you give it |

**Next:** `did:scid:vh`, persistent stores, `did:pkh` for Solana, `did:webs`, a Universal Resolver driver.

**Not planned:** `did:plc`, `did:ethr` and other ledger methods. Any DIF `did-resolver` driver plugs in through an adapter, and its results are marked unverified.

## How it works

- **One resolver.** `DidResolver` follows the W3C DID Resolution model. Drivers plug in. `resolve` never throws.
- **No network by default.** A driver that fetches gets a guarded `fetch`: HTTPS only, a host allowlist, no redirects, no private addresses, size and time limits.
- **Assurance on every result.** `self-certifying`, `verified-history`, `web` or `remote`. Verifiers refuse `remote` unless told otherwise.
- **Relationships checked every time.** A key signs only for the relationship its document gives it, and only with an algorithm that fits its type.

## Entry points

- `@toip-tools/did`: syntax, document types, keys, dereferencing, the resolver, `did:key`, `did:peer`, `did:jwk`, builders and verifiers. Browsers and Node.
- `@toip-tools/did/web` and `@toip-tools/did/webvh`: the two web methods. `/webvh` wraps the DIF `didwebvh-ts` library.
- `@toip-tools/did/node`: a fetch that checks resolved IP addresses, and a writer for hosting files. Node only.

The final export layout will follow the repository's build conventions.

## A sketch

```ts
import { DidResolver, keyDriver, peerDriver, verifyDataIntegrity } from "@toip-tools/did";
import { webvhDriver } from "@toip-tools/did/webvh";

const resolver = new DidResolver({
  drivers: [keyDriver(), peerDriver(), webvhDriver()],
  network: { allow: { hosts: ["issuer.example"] } },
});

const r = await verifyDataIntegrity(credential, { resolver });
// { ok: true, did, method, key, assurance: "verified-history", versionId } or { ok: false, failure, detail }
```

With `trust-core`:

```ts
const endpoint = new Endpoint({ identity, transport, clock, resolver });
const check = await verifyCredential(vc, clock, { resolver });
```
