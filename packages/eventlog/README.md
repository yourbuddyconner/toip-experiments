# @zk-toip/eventlog

Append-only, signed event logs whose writer can't quietly change them.

There are two kinds of log:

- **KELs.** A KERI key event log for one identifier (an AID). It holds key rotations with pre-rotation, witnesses and anchors. The events are real KERI 1.0, and KERIpy 1.3.6 computes the same key state from them.
- **Trails.** Our own audit logs, owned by an AID. Each entry is a small signed header that commits to a private body. Rotations seal every open trail, so a stolen or retired key can't extend it.

Witnesses receipt the first version they see at each place in a log. Watchers compare versions and record duplicity. Bundles verify offline.

The design is `projects/trail/docs/design.md`. Section 13 is the API.

The core runs in browsers and Node. `JsonFileStore`, `serveHttp` and `startWitness` are Node only, in `@zk-toip/eventlog/node`.

## KERI compatibility

**Produced and accepted:**

- KERI 1.0 JSON messages (`KERI10JSON…_`): `icp`, `rot`, `ixn` and `rct`.
- Non-delegated, self-addressing AIDs (`E`).
- Keys: Ed25519 (`D`) and ECDSA P-256 (`1AAJ`). Witnesses: Ed25519 (`B`).
- Integer thresholds for `kt`, `nt` and `bt`.
- Configuration traits `[]` or `["DND"]`.
- Next-key digests: Blake3-256 over the key's qb64 text.
- Attachments: controller signatures (`-A`), witness signatures (`-B`), non-transferable receipt couples (`-C`), signature groups with a key state (`-F`). KERIpy's `-V` attachment groups and `-E` first-seen couples are read and skipped.
- Indexed signature codes `A`, `B`, `2A`, `2B` (Ed25519) and `E`, `F`, `2E`, `2F` (P-256).
- Superseding recovery: a `rot` replaces `ixn`s after the last establishment event (rule A0).
- Abandonment: a `rot` with an empty `n` ends the log.

**Rejected as `unsupported` (not as invalid):**

- Delegated events (`dip`, `drt`) and any other message type.
- Fractionally weighted thresholds.
- KERI or CESR 2.0, and CBOR or MessagePack serializations.
- Basic (non-self-addressing) and non-transferable inceptions.
- Other key, digest or signature codes. Traits other than `DND`.
- More than 64 keys or witnesses.

Also refused, as malformed (`badFields`): more than one `-F` group on a message, `-H` groups, and other attachment groups.

**Not KERI.** No KERI implementation reads these:

- Trail messages (`tin`, `ten`, `tcl`, `trc`), with the version string `ZKTR10JSON…_`.
- Timed receipts: a witness's `trc` over a KEL event, which carries the witness's time.
- WebAuthn-wrapped signatures, carried in our `-Y` attachment group.
- Bodies and DID bindings.

These use KERI's SAID rules and CESR primitives. A KEL with only Ed25519 or plain P-256 signatures is pure KERI. To give KERIpy a KEL, send `toStream(kel.messages)`. A bundle's KEL stream also holds timed receipts, which KERIpy does not read.

**What the tests prove.** `tests/interop.test.ts` hands our KELs to KERIpy 1.3.6. It covers inception, interaction with seals and a data field, full and partial rotation (including a principal rotating alone with `extraKeys`), 2-of-3 multisig, witness add and remove with receipts, a superseding recovery, and P-256 keys. `tests/kel.test.ts` verifies three KELs that KERIpy made (`tests/fixtures/keripy-kels.json`). Known answers for SAIDs and next-key digests come from the CESR specification and from KERIpy.

## Quick start

```ts
import { Controller, MemoryStore, coldKeysFromSeed, signerFromIdentity, localWitnessClient, Witness, exportBundle, verifyBundle } from "@zk-toip/eventlog";

const controller = await Controller.incept({
  hot: [signerFromIdentity(agentIdentity)],
  cold: coldKeysFromSeed(rotationSeed, "agent"),
  extraNext: [principalNextDigest], nt: 1,          // the principal can rotate too
  witnesses: [w1.aid, w2.aid], bt: 1,
  bind: agentIdentity,                              // DID binding, sealed right after inception
  store: new MemoryStore(), clock,
});
const trail = await controller.openTrail("agent/actions");
await trail.append({ kind: "agent/tool-call", body: { tool, input } });

// before spending: throws WitnessError unless bt witnesses (at least one) receipt it
const { entry } = await trail.appendWitnessed({ kind: "agent/mandate-decision", body: decision }, [client1, client2]);
const trailRef = trail.ref(entry.s);                // {i, s, d}

const bundle = await exportBundle(controller.store, controller.aid, { entries: { [trail.id]: [entry.s] } });
const result = await verifyBundle(bundle, { expectDid: agentIdentity.did });
```

## API

Names only. The types in `src/` have short comments.

**Primitives.** `Code`, `encode`, `decode`, `isQb64`, `digest`, `digestSeal`, `nextKeyDigest`, `nonTransferableAid`, `didKeyOf`, `aidOfDidKey`, `aidDid`, `aidOfDid`, `encodeIndexedSig`, `decodeIndexedSig`, `encodeKeyRefSig`, `decodeKeyRefSig`, `saidify`, `versionString`, `parseMessage`, `makeBody`, `checkBody`.

**Streams and compact form.** `toStream`, `fromStream`, `attachmentsOf`, `toCompact`, `fromCompact`, `toCompactLog`, `fromCompactLog`.

**Keys.** `Signer` (async), `ed25519Signer`, `p256Signer`, `signerFromIdentity`, `webCryptoSigner`, `webAuthnSigner`, `ColdKeys`, `coldKeysFromSeed`, `keyQb64`, `verifyKeySig`.

**Writing.** `Controller` (`incept`, `load`, `state`, `signers`, `interact`, `rotate`, `checkpointNow`, `openTrail`, `trail`, `trails`, `bind`, `publish`, `headSeal`, `kelMessages`) and `Trail` (`append`, `appendWitnessed`, `close`, `head`, `ref`).

**Witnessing.** `Witness`, `WitnessClient`, `SubmitResult`, `WitnessError`, `localWitnessClient`, `httpWitnessClient`, `witnessHttpHandler`, `taskWitnessClient`, `serveWitnessTasks`, `makeReceipt`, `endorse`. Node: `startWitness`, `serveHttp`.

**Watching.** `Watcher` (`watch`, `ingest`, `poll`, `heads`, `evidence`, `asSource`), `verifyEvidence`.

**Verifying.** `verifyKel`, `verifyTrail`, `verifySignature`, `checkTrailRef`, `fetchTrail`, `KelProcessor`, `TrailProcessor`. Key state queries: `keyAt`, `isCurrentAt`, `retiredAt`, `stateOf`, `anchoredIn`.

**Bindings and bundles.** `makeBinding`, `bindingSeal`, `bindingDigest`, `verifyBinding`, `exportBundle`, `verifyBundle`.

**Trust Tasks.** `TRAIL_TASKS` (`trail/witness/submit`, `trail/witness/receipts`, `trail/query`, `trail/head`, `trail/disclose`, `trail/duplicity`), `disclose`, `onDisclose`, `reportDuplicity`, `onDuplicity`.

**Storage.** `LogStore`, `MemoryStore` (with `dump()` and `new MemoryStore(data)`), `JsonFileStore` (Node).

Nothing throws on bad input to a verifier. Every check returns `Problem {code, logId?, s?, message}`.

### Examples

Rotation, and recovery after key theft:

```ts
await controller.rotate();                                   // seals every open trail at its head
await controller.rotate({ cutAfter: { [trail.id]: 8 } });    // recovery: entries after 8 under the old key are cut
await controller.rotate({ supersede: 3 });                   // put the rot at KEL sn 3, superseding ixns
await controller.rotate({ next: [] });                       // abandon: the log ends
```

The principal rotates with its own key (a partial rotation, signed with a `2A` signature):

```ts
const p = await Controller.load(aid, { hot: [], store, clock });
await p.rotate({ exposed: [principalNextSigner], next: [nextKeyDigest(keyQb64(principalNextNext))] });
```

A device with a key that can't be exported, and a data field:

```ts
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
const device = await Controller.incept({
  hot: [await webCryptoSigner(pair)],
  next: [ownerRecoveryDigest],
  witnesses, bt: 1,
  data: { messagingDid, keyClass: "B", device: "camera" },
  store, clock,
});
await device.interact([digestSeal(merkleRoot)]);              // SHA-256 root, code I
```

A passkey: `webAuthnSigner({ publicKey, getAssertion })`. The challenge is SHA-256 of the message. Verifiers check the assertion with `{ webauthn: { origins, rpIds, requireUserVerified } }`, or with their own `verifySig` hook.

A capture signed outside the log:

```ts
const check = await verifySignature({ bytes: manifest, sig: keyRefSig, kel, trails });
// { valid, current, retiredAt, anchored, anchoredBeforeRetirement, witnessedBy, disputed }
```

A counterparty checks a `trailRef` over HTTP, then endorses it:

```ts
const client = httpWitnessClient(url, witnessAid);
const r = await checkTrailRef(trailRef, client);
if (r.ok) await client.addReceipts(toStream([endorse(r.entry!, payeeIdentity, clock.iso())]));
```

## Sizes

Measured by the tests, with Ed25519 keys and 2 witnesses.

| Message | JSON and CESR text | Compact (CBOR) |
|---|---|---|
| `ten` header, with a body and one `x` seal | 358 B | 204 B |
| the same with its `-F` signature group | 566 B | 348 B |
| `ten` with its `-F` group, no `x` seal | 516 B | 315 B |
| `trc` (receipt) with its signature | 313 B | 190 B |
| `icp`, 2 witnesses, with its signature and 2 witness signatures | 664 B | 432 B |
| `ixn` with one seal, its signature and 2 witness signatures | 527 B | 355 B |

A whole log in compact form leaves out what its position gives (`i`, `s`, `p`, and the SAID):

- A camera's KEL (P-256, inception with a data field, 2 rotations, 3 interaction events, 2 witness receipts each): 3,613 B as CESR text, 1,841 B compact.
- Each further interaction event with 2 witness receipts adds about 249 B.
- Each timed receipt adds about 112 B.

So "a few hundred interaction events in under 2 KB" is not possible. A signature is 64 bytes and can't be compressed. Batch captures under one Merkle root per interaction event, as capture's design plans.

## Differences from the design

Additive, or where a consumer needed more than section 13:

- **Signers.** `Signer.sign` is async and may return a WebAuthn-wrapped signature. `Signer.curve` is `"ed25519"` (default) or `"p256"`. Added `p256Signer`, `webCryptoSigner`, `webAuthnSigner`. `coldKeysFromSeed` takes `{ curve }`.
- **P-256** keys (`1AAJ`) and signature codes `E`, `F`, `2E`, `2F`, for capture. KERIpy 1.3.6 accepts them. Section 5.4 listed Ed25519 only.
- **Pluggable verification.** `VerifyOptions.verifySig` (tried first) and `VerifyOptions.webauthn`.
- **Another party's next key.** `InceptOptions.extraNext` and `next`; `RotateOptions.extraNext` and `next`. `exposed` signers become the new current keys. `RotateOptions.extraKeys` adds current keys that don't sign the rotation, so a principal can rotate alone and name the agent's new key.
- **Inception data.** `InceptOptions.data` puts a small object in the inception's `a`. KERIpy accepts it.
- **DID binding at inception.** A binding names the AID, and the AID is the inception's SAID, so the binding can't be sealed in the inception itself. `InceptOptions.bind` seals it in an `ixn` right after. (Section 7.6 says "normally in the inception event".)
- **Timed receipts on KEL events.** KERI's `rct` has no time. Witnesses also return a `trc` over each KEL event they receipt. `KelEvent.receiptTimes` and `earliestReceipt` report them. They don't count toward `bt`. `StoredReceipt.kind` gains `"timed"`, and `addReceipt` is idempotent per (by, d, kind).
- **Key state queries** for capture: `keyAt`, `isCurrentAt`, `retiredAt`, `stateOf`, `anchoredIn`. `anchoredIn` returns every anchor (KEL seals and trail entries) as a list, and takes a qb64 digest or 32 raw bytes (matched as Blake3 `E` or SHA-256 `I`). `verifySignature` also counts a KEL `ixn` seal as an anchor before retirement.
- **Compact form is CBOR** (cborg), for capture. Per message: `toCompact`, `fromCompact`. Per log: `toCompactLog`, `fromCompactLog`. The receiver rebuilds the exact JSON and checks the SAID.
- **Head digest per log:** `Controller.headSeal()`, `Trail.ref()`, and `TrailResult.head`.
- **DID for an AID:** `did:keri:<AID>` (`aidDid`, `aidOfDid`), resolved from the KEL alone.
- **Disclosure.** `exportBundle` takes `entries: { [trailId]: s[] }` as well as body SAIDs. `disclose`, `onDisclose`, `reportDuplicity` and `onDuplicity` wrap the Trust Tasks.
- **trailRef checks:** `checkTrailRef(ref, witnessClient)` and `fetchTrail`.
- **Results.** `KelResult.messages` holds the verified trunk. `TrailEntry` has `a` and `x`. `SubmitResult` refusals may carry `receipts` for the messages before the refused one.
- **Stores.** `LogStore.all(logId)` returns every version in first-seen order. `MemoryStore.dump()` and `new MemoryStore(data)` move a store between places, such as a browser's IndexedDB.
- **Node helpers.** `serveHttp` and `startWitness`. The witness HTTP routes also have `GET info`.
- **Interop test switch.** The test runs when `KERIPY_PYTHON` names a Python with `keri` 1.3.x, not `KERIPY=1`. The Python scripts are in `interop/` here, not in `projects/trail/interop/`.

Behavior worth knowing:

- An entry under a retired key that directly follows an entry under a newer key fails `staleKeyState`. Other entries past a rotation's seal are `cut`.
- A rotation seals every open trail, and every closed trail whose last message is in the outgoing epoch.
- An identical copy of a message in a stream is merged, not reported.
- A witness refuses an entry that a rotation it holds has cut. Its head skips cut entries, so after a recovery the head is the entry that replaced them.
- A watcher's poll fetches from the last place it holds. So a version handed to it directly shows as duplicity when the witnesses hold another.
- Bundles carry the whole KEL, including superseded events, so a recovery is visible.

Not done yet:

- An IndexedDB `LogStore`. A browser witness works today on `MemoryStore`, saved with `dump()`.
- Endorsements by AIDs (`-F` on a `trc`) verify only when the caller passes the endorser's KEL (`endorserKels`).
- The shorter `-H` key reference for receivers that already hold the KEL.
- `cesr-ts` parsing of our streams (optional in the design).

## Tests

```
npm test --workspace @zk-toip/eventlog
```

The KERIpy interop tests are skipped unless `KERIPY_PYTHON` is set:

```
python3.12 -m venv ~/.cache/zk-toip-keripy/venv
~/.cache/zk-toip-keripy/venv/bin/pip install "keri==1.3.*"
KERIPY_PYTHON=~/.cache/zk-toip-keripy/venv/bin/python npm test --workspace @zk-toip/eventlog
```

KERIpy needs libsodium. `interop/keripy_make.py` rebuilds the KERIpy fixtures.
