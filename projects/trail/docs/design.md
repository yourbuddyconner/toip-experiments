# Trail: design

Verifiable audit trails for agents, devices and services, and the shared event-log library under them. Date: 2026-11-06.

Trail has two parts:
1. **`packages/eventlog`** (`@zk-toip/eventlog`): append-only, hash-chained, signed event logs with key rotation, witnesses, receipts and duplicity detection. Other projects build on it.
2. **`projects/trail`**: a small service and explorer that proves the library works and gives `projects/agents` and `projects/capture` a viewer.

Choices marked **(our call)** are the assistant's and open to change. Claims about KERI cite the sources in section 18. A guess is labeled a guess.

## 1. What Trail is, and why

The convener asked for audit trails, "maybe" on KERI. An audit trail is only worth something if the party who writes it can't quietly change it later. Today the repository has one log: Settle's processor log (`projects/settle/src/protocol/log.ts`). It is hash-chained and has a signed head. That stops someone editing an entry in the middle. It doesn't stop the processor:
- showing two different logs to two different people;
- dropping the last few entries;
- losing its key, or having it stolen, without a way to rotate it. A `did:key` can't rotate.

KERI (Key Event Receipt Infrastructure) solves exactly these problems for key histories (theirs, section 18, K1). It has:
- a self-certifying identifier, the AID;
- a key event log (KEL) with pre-rotation, so a stolen signing key can be rotated away;
- witnesses that receipt only the first version of an event they see;
- watchers that detect two versions of the same event (duplicity).

Trail takes KERI's key event log as it is, so KERIpy can verify it. On top, it adds **trails**: our own audit logs, owned by an AID, sealed into its KEL and witnessed by the same witnesses.

## 2. Who uses it

| User | What they need |
|---|---|
| **An AI agent** (`projects/agents`) | Append every action (tool calls, messages, payments, approvals) to a trail it can't later rewrite. |
| **The agent's principal** | Review the trail. Prove it is complete up to a point, and that the agent showed nobody a different one. |
| **A counterparty** (a payee, Settle's processor) | Check that the agent logged the action that concerns them, before acting on it. |
| **A camera or sensor** (`projects/capture`) | Rotate keys over its life. Have a capture signed in 2026 still verify after a rotation in 2028, and prove it was signed while that key was current. |
| **Settle's processor** (`projects/settle`) | A transparency log that can't be forked. Replaces `TransparencyLog` later. |
| **A witness operator** | Run a witness: receipt first-seen versions, store headers, serve them. |
| **Anyone with a bundle** | Verify it offline. |
| **`projects/mesh`** | Carry events and receipts over Bluetooth or LoRa, so encodings must compact well. |

## 3. Goals, non-goals, anti-goals

**Goals**

1. A log whose writer can't edit, reorder, truncate or fork it without that being detectable by anyone holding the right evidence.
2. Keys that rotate. A signature made under an old key still verifies after rotation, against the key state at the time.
3. Recovery from a stolen signing key, visibly.
4. KEL events in real KERI 1.0 format. KERIpy accepts our KELs, and we accept KERIpy's within a stated subset (section 5.4).
5. Private by default. Witnesses see entry headers, never entry contents.
6. Runs in browsers, Node and small devices. No new runtime dependencies beyond what `trust-core` already uses.
7. Works offline. Entries chain locally and get witnessed later.
8. One library for agents, capture and Settle.

**Non-goals (for now)**

- KERI delegation (`dip`, `drt`), fractionally weighted thresholds, KERI 2.0 messages, CESR binary (qb2), OOBIs, ACDCs and TELs.
- Merkle-tree batching and inclusion proofs.
- Anchoring checkpoints on a blockchain. Settle wants it later (section 12.3).
- Publishing AIDs as `did:webs`.
- Global ordering across logs. KERI doesn't need it, and neither do we.
- Interop with the KERIA cloud agent protocol.

**Anti-goals**

- **A log whose operator decides what's true.** Verification never trusts the server it came from.
- **Private data at witnesses.** Bodies stay with the controller and whoever it discloses them to.
- **Silent history rewrites,** including through recovery. A recovery that cuts entries leaves them visible and marked.
- **A blockchain dependency** for the basic guarantees.
- **"KERI-compatible" claims beyond what a test proves.**

## 4. Threat model

Parties: the **controller** (the agent, device or processor writing the log), its **witnesses**, **verifiers** (principal, counterparties, anyone), and **watchers** run by verifiers.

| Threat | What it looks like | Defense | What remains |
|---|---|---|---|
| **Edit an old entry** | Change a tool call's arguments after the fact. | Each entry's SAID covers its header; the header holds the body's digest; each entry names the prior entry's SAID; signatures and witness receipts cover the header. | None, given one honest copy. |
| **Delete or reorder** | Drop entry 7. | Sequence numbers are contiguous; prior links break. | None. |
| **Truncate** | Hide the last 20 entries. | Witnesses hold the head. Rotations and checkpoints seal the head into the KEL. Verifiers ask witnesses for the head. | If the controller uses no witnesses, truncation after the last checkpoint isn't detectable. Bundles say so (section 11). |
| **Fork for different viewers** | Show the principal one version of entry 12 and the payee another. | Witnesses receipt only the first version at each location. A version needs `bt` receipts to count. Watchers compare. Two signed versions are self-proving evidence. | A controller colluding with enough witnesses can fork, until any watcher sees both (section 9.4). |
| **Backdate** | Claim an entry was written yesterday. | `dt` is the controller's claim. Each witness receipt carries the witness's own time, an upper bound. `dt` can't go backwards along the trail. | A controller can claim any time between the previous entry and now. |
| **Omit** | Never log an action. | A log can't prevent this. Counterparties can refuse requests that don't cite a trail entry (section 12.1), and endorse the entry they rely on. | Actions with no counterparty, like a local tool call, can be omitted. |
| **Signing key stolen** | An attacker appends entries with the agent's current key. | Rotation to pre-rotated keys the attacker never saw. The rotation seals the trail at the last good entry and cuts the rest. KERI's rule A0 lets a rotation supersede compromised interaction events (K1). | Entries cut by recovery stay visible, and so does the time the attacker had. |
| **Old key leaks later** ("dead attack" in K1) | A retired key is used to write a new history. | The rotation that retired it sealed every open trail's head; entries under a retired key after that seal are invalid. Witnesses and first-seen copies hold the real KEL. | A verifier with no copy and no witness access could be fooled only if the attacker also holds `bt` witness keys. |
| **Next (rotation) key stolen** | The attacker rotates first. | None in KERI without delegation (K1, rule A1). Mitigate with several next keys and a threshold, or a principal-held rotation key (section 8.5). | Unrecoverable. Make a new AID. |
| **Malicious witness** | Refuses to receipt; receipts two versions; lies about the head. | `bt` below the witness count tolerates refusals. A witness that signs two versions at one location is caught by its own signatures. Other witnesses contradict a false head. | Collusion of enough witnesses with the controller (section 9.4). |
| **Replay a receipt** | Attach a receipt for entry 3 to a forged entry 3. | A receipt names log, sequence number and SAID. | None. |
| **Guess a body from its digest** | "approved" or "denied"? | Every body has a random 128-bit salt `u`. | None. |
| **Metadata at witnesses** | Witnesses see how often, when, and what kind. | Headers carry no body content. `k` (kind) may be left empty for sensitive trails. | Timing and volume are visible to witnesses. |

## 5. The KERI decision

### 5.1 The options

| Option | What it means | For | Against |
|---|---|---|---|
| **(a) Use a KERI implementation** | Adopt KERIpy (Python), KERIA (cloud agent) with signify-ts, or keri-ts. | Full protocol, maintained by the KERI community. | See 5.2. None of them fits a browser-and-device TypeScript repository today. |
| **(b) A KERI subset ourselves** | Produce and verify real KERI 1.0 KELs in TypeScript; build trails on top. | Small. Interoperable where it counts. No new dependencies. Compact encodings under our control. | We own the code and must keep it honest with interop tests. |
| **(c) Something simpler** | Settle's chain plus signed heads, maybe with co-signers. | Smallest. | No rotation, no historical key state, no first-seen witnesses, so no fork protection. That's most of the brief. |

### 5.2 What exists (read 2026-11-06, section 18)

- **KERIpy** (WebOfTrust/keripy, K2): the reference implementation, in Python. Stable releases on PyPI are 1.3.6 (2026-07-31) and 1.2.14 (2026-09-09). The main branch is 2.1.0-dev1, and its default protocol version is 2.0. It is our interop oracle, not a dependency.
- **KERIA + signify-ts** (signify-ts 0.4.1, 2026-10-12; K3, K4): signify-ts does key generation and signing "at the edge" only. Its README lists five functions of a KERI agent, of which signify-ts does two. Event validation, storage and witnessing stay in KERIA, a Python cloud agent. Adopting it means running Python services for every agent and device. It also brings libsodium (WebAssembly) and mathjs.
- **keri-ts and cesr-ts** 1.0.0 (kentbull/keri-ts, 2026-10-16; K5): the most complete TypeScript KERI. Its release record reports parity tests against KERIpy. It is Deno-first, runs on Node 20.3 or later, and stores state in LMDB, a native database. So it doesn't run in a browser as packaged (our reading; not tried). It reached 1.0 three weeks ago and has one main maintainer. It is the first thing to revisit (section 17).
- **@kerits/core** 0.3.4 (aaronp/kerits, K6): KERI primitives and KEL validation in TypeScript. It is a read-only mirror of a private repository, and depends on cesr-ts from a git URL. Too young to build on.
- **cesr** 0.1.2 (lenkan/keri-js, K6): a CESR parser.
- **keriox** (THCLab, Rust): not a fit for a TypeScript repository.

### 5.3 Decision: (b), with the KEL in real KERI format

**KEL events are real KERI.** Inception, rotation, interaction and receipt messages follow the KERI specification exactly:
- version 1.0 JSON;
- Blake3-256 SAIDs;
- Ed25519 keys;
- CESR 1.0 text attachments.

A test hands our KEL streams to KERIpy 1.3.x and checks it computes the same key state (section 16).

**Trails are ours,** shaped like KERI and encoded with the same machinery. Rotation and interaction events seal their heads with standard KERI event seals `{i, s, d}`. KERIpy sees those seals as opaque anchors, which is all a seal is in KERI.

Why:
1. **Weight and reach.** The subset needs Ed25519, Blake3 and base64url. `@noble/curves` and `@noble/hashes` 2.4.0 are already in `trust-core`, and the latter includes Blake3 and HKDF. The same code runs in browsers, Node and React Native. No Python service, no native database.
2. **Size.** Our guess is 1,500 lines for the KERI part. The hard parts of KERI are left out: delegation, multi-party group signing, OOBIs, escrows of out-of-order events.
3. **The audit layer KERI doesn't have.** KERI's TEL is for credential registries, not general audit logs. Putting every agent action into the KEL as an interaction event would make the KEL huge. It would also let a superseding rotation (rule A0) push ordinary audit history onto a disputed branch. Trails keep the KEL small and make cuts explicit.
4. **Compact encodings** for `projects/mesh` (section 7.8) need control over the encoder.
5. **A path to (a).** Our KELs are real KERI. If keri-ts gains a browser build, or a project needs KERIA, the KEL module can be swapped, and existing AIDs keep working.

Why not (c): it fails the brief. It can't rotate keys, can't verify a capture against a past key state, and can't stop a fork.

### 5.4 Compatibility statement

To be published with the package, and proven by tests:

- **Produced and accepted:** KERI 1.0 JSON (`KERI10JSON…_`) `icp`, `rot`, `ixn` and `rct`. Non-delegated, self-addressing AIDs (`E`). Ed25519 keys (`D`) and witnesses (`B`). Integer thresholds for `kt`, `nt` and `bt`. Configuration traits `[]` or `["DND"]`. Attachments: controller indexed signatures (`-A`), witness indexed signatures (`-B`), non-transferable receipt couples (`-C`), transferable indexed signature groups (`-F`). Indexed signature codes `A`, `B` and `2A`.
- **Rejected as `unsupported`, not invalid:** delegated events, fractional thresholds, KERI or CESR 2.0, qb2, other key or digest types, other traits, more than 64 keys or witnesses.
- **Not KERI:** trails, trail receipts, bodies and DID bindings. They use KERI's SAID protocol and CESR primitives, but no KERI implementation will understand them.

### 5.5 How `did:key` relates

Every project here uses `did:key` (Ed25519) for TSP, Trust Task proofs and credentials. The OpenVTC libraries resolve `did:key` with no network (S02), and `trust-core`'s `Endpoint` relies on that. Moving TSP to AIDs would touch everything and break that property. So:

- **`did:key` stays the TSP and document identity.**
- **The AID is the audit identity.** It holds the KEL and the trails.
- **A DID binding links them both ways (our call).** It is a small document `{type: "trail/did-binding", issuer: <did:key>, aid, issuedAt}`, signed by the `did:key` with `signDocument`. Its digest is sealed in the AID's KEL, normally in the inception event. Either side alone isn't a binding. Rebinding, for example after the `did:key` is replaced, seals a new binding with `replaces`.
- **Witnesses are simpler.** A witness AID `B…` and a `did:key` are both just an Ed25519 public key. The library converts between them, so a witness is reachable over the TSP relay at the `did:key` of its AID.
- **Later:** `did:webs` (ToIP, K7) is the DID method for KERI AIDs on the web. The P2P Trust Stack's own Layer 1, `did:scid:vh`, also has hash-chained history, pre-rotation and witnesses (S01). Both are out of scope here. The binding keeps either option open.

## 6. Concepts

- **AID**: a KERI identifier, the SAID of its inception event. It is self-certifying, so no registry is needed.
- **KEL**: the AID's key event log: `icp`, then `rot` and `ixn` events.
- **Key state**: the keys, thresholds, next-key digests and witnesses in force after an event.
- **Establishment event**: `icp` or `rot`. It changes key state.
- **Epoch**: the stretch of time a given establishment event's keys are current.
- **Trail**: an audit log owned by one AID. It has an id (the SAID of its inception), entries, and an optional close.
- **Entry header**: the signed, chained, witnessed part of an entry. It is small and holds no content.
- **Body**: the entry's content, as JSON. The header holds its digest. Bodies are disclosed only to whoever the controller chooses.
- **Seal**: a digest commitment inside a KEL event. The trail checkpoint seal is `{i: trailId, s, d}`.
- **Checkpoint**: an `ixn` (or `rot`) that seals a trail's head into the KEL.
- **Receipt**: a witness's signature on the first version it saw at a location (log, sequence number).
- **Watcher**: a verifier's own process. It keeps first-seen copies, polls witnesses, and records duplicity.
- **Duplicity**: two validly signed, different versions at the same location, when neither supersedes the other.
- **Cut**: entries signed under an epoch after the head its closing rotation sealed. They are kept, shown, and not valid.

## 7. Data model and encodings

### 7.1 Primitives (CESR 1.0 text, base64url)

| Code | Meaning | Length |
|---|---|---|
| `D` | Ed25519 public key (transferable controller key) | 44 |
| `B` | Ed25519 public key as a non-transferable AID (witnesses, endorsers with a `did:key`) | 44 |
| `E` | Blake3-256 digest: SAIDs, AIDs, next-key digests, body digests | 44 |
| `0B` | Ed25519 signature, not indexed | 88 |
| `A`+1 | Ed25519 indexed signature; same index in current keys and prior next digests | 88 |
| `B`+1 | Ed25519 indexed signature, current keys only | 88 |
| `2A`+4 | Ed25519 indexed signature, two different indexes (big dual) | 92 |
| `0A` | 128-bit number: sequence numbers in attachments; salts | 24 |

Encoding (from the CESR spec, C1): left-pad the raw bytes with zero bytes to a multiple of 3, base64url-encode, and replace the leading `A` characters with the code. For a 32-byte key, add one zero byte, get 44 characters, and replace the first. For a 64-byte signature, add two zero bytes, get 88, and replace the first two. Indexed codes put the index (and for `2A` the second index) in base64 digits after the code letter.

### 7.2 SAIDs

The CESR spec's SAID protocol (C1):
1. Put 44 `#` characters in the SAID field (or fields).
2. Serialize.
3. Blake3-256 the bytes, encode with code `E`, and put it back.

For `icp` and `tin`, both `d` and `i` are dummied and both get the same SAID. Verifying reverses this.

**Serialization** for KEL and trail headers is compact JSON in the fixed field order below. It is UTF-8, has no whitespace, and doesn't escape non-ASCII, matching Python's `json.dumps(sad, separators=(",", ":"), ensure_ascii=False)` (K1). We build the string field by field; we never rely on object key order. Verifiers always hash and verify the exact raw bytes received. They re-serialize only to check the raw bytes are canonical, and reject them if they aren't.

**Version string**, field `v`, always first: `KERI10JSON` + six lowercase hex digits of the total serialized length + `_` (C1, legacy 1.x format). For example, `KERI10JSON00012b_`. The length counts the whole message, so compute it with the dummied SAIDs in place; the width is fixed.

### 7.3 KEL events (KERI 1.0, from KERIpy's field definitions, K2)

| Type | Fields, in order |
|---|---|
| `icp` | `v, t, d, i, s, kt, k, nt, n, bt, b, c, a` |
| `rot` | `v, t, d, i, s, p, kt, k, nt, n, bt, br, ba, a` (KERI 2.0 adds `c`; we use 1.0) |
| `ixn` | `v, t, d, i, s, p, a` |
| `rct` | `v, t, d, i, s` (`d` is the SAID of the event being receipted) |

- `s`, `kt`, `nt`, `bt` are lowercase hex strings with no leading zeros.
- `k` lists `D` keys. `n` lists `E` digests of the next keys: Blake3-256 over the next key's 44-character text form, as signify-ts does (K4).
- `b` lists witness AIDs (`B`). `br` and `ba` remove and then add witnesses.
- `a` lists seals. We use `{i, s, d}` (event seal, for trail checkpoints) and `{d}` (digest seal, for DID bindings and other documents).
- An empty `n` in a rotation abandons the AID. An empty `n` at inception makes it non-transferable. We incept only transferable AIDs.

Example: an agent's inception with one key, one next key and three witnesses, of which two must receipt. The digests are illustrative, not computed.

```json
{"v":"KERI10JSON0001b7_","t":"icp","d":"EAgent…","i":"EAgent…","s":"0","kt":"1",
 "k":["DCurrentKey…"],"nt":"1","n":["ENextKeyDigest…"],"bt":"2",
 "b":["BWitness1…","BWitness2…","BWitness3…"],"c":[],"a":[{"d":"EDidBinding…"}]}
```

### 7.4 Trail messages (ours)

Version string `ZKTR10JSON……_` (our call; `ZKTR` stands for zk-toip trail). It uses the same format and length rule as KERI's, so one stream parser handles both.

| Type | Meaning | Fields, in order |
|---|---|---|
| `tin` | Trail inception | `v, t, d, i, s, ci, dt, m` |
| `ten` | Entry | `v, t, d, i, s, p, dt, k, a, x` |
| `tcl` | Close. No entries may follow. | `v, t, d, i, s, p, dt` |
| `trc` | Receipt or endorsement of a `tin`, `ten` or `tcl` | `v, t, d, i, s, dt` |

- `i`: the trail id, the SAID of the `tin` (dummied with `d`, like `icp`). `s` is hex, starting at `0` for `tin`. `p` is the prior message's SAID.
- `ci`: the controller AID. `m`: a short purpose label, such as `agent/actions`, `device/captures` or `settle/transparency`.
- `dt`: the controller's claimed time, ISO 8601 UTC with milliseconds (`Clock.iso()`). It must not go backwards along the trail.
- `k`: the entry kind, such as `agent/tool-call`. It may be `""` to hide it from witnesses.
- `a`: the body's SAID, or `""` for an entry with no body.
- `x`: a list of seals referring to other things, such as `{i, s, d}` of another trail's entry (cross-anchoring) or `{d}` of a Trust Task document. It may be empty.
- `trc`: `d`, `i` and `s` name the message being receipted, and `dt` is the receipter's time. The signature covers the `trc` itself, so the time is signed too (unlike KERI's `rct`, our call).

**Signatures on `tin`, `ten` and `tcl`**: one `-F` group (transferable indexed signature group, K1 and C1). It holds the controller AID, the `0A` sequence number and SAID of the establishment event whose keys signed, then `-A` indexed signatures meeting that event's `kt`. This names the key state explicitly, which makes historical verification possible.

**Signatures on `trc`**: a `-C` couple (signer `B` AID plus `0B` signature) for witnesses and `did:key` endorsers. Endorsers with an AID use a `-F` group instead.

Example entry header, illustrative digests:

```json
{"v":"ZKTR10JSON00015e_","t":"ten","d":"EEntry12…","i":"ETrail…","s":"c","p":"EEntry11…",
 "dt":"2026-11-06T18:04:05.123Z","k":"agent/payment","a":"EBody…","x":[{"d":"ESettleTerms…"}]}
-FAB EAgent… 0AAAAAAAAAAAAAAAAAAAAAAA EAgent… -AAB AA<signature>
```

### 7.5 Bodies

A body is a JSON object with `d` (its SAID) and `u` (a `0A` random 128-bit salt), plus anything the kind defines.

Fixed field order can't be relied on in free-form application JSON, so bodies are serialized with JCS (RFC 8785, `trust-core`'s `canonicalJson`) and `d` dummied (our call). Bodies are never sent to witnesses.

```json
{"d":"EBody…","u":"0ARandomSalt…","kind":"agent/payment","termsHash":"…","amount":"340.00","rail":"settle/solana-devnet"}
```

### 7.6 DID binding

`{type: "trail/did-binding", issuer: "did:key:z6Mk…", aid: "E…", issuedAt, replaces?: "E…"}`, with a `signDocument` proof. Its seal in the KEL is `{d: Blake3-256(JCS(document with proof))}`.

### 7.7 Streams and storage form

- **Stream**: CESR text. Each message is followed by its attachments. KEL streams put the witness signatures `-B` straight after each event's controller signatures `-A`, which KERIpy accepts. This is the export and interop format.
- **Stored form**: `{logId, s, d, t, raw, attachments, fn, seenAt}`. `raw` holds the exact message bytes. `fn` is KERI's first-seen ordinal (K1).

### 7.8 Compact binary, for `projects/mesh`

Every header type has fixed fields, so a lossless binary transcoding is easy (our call):
- one byte for the message type;
- raw 32-byte keys and digests, each with one code byte;
- sequence numbers as unsigned LEB128 varints;
- `dt` as a 48-bit count of milliseconds;
- strings as varint length plus UTF-8;
- 64-byte signatures with one index byte.

The receiver rebuilds the exact JSON, including the version string, and checks the SAID. Signatures are always over the JSON, so there is only one signing form.

Rough sizes (a guess, to be measured):

| Message | JSON | Compact |
|---|---|---|
| `ten` header | ~330 B | ~150 B |
| `-F` signature group | ~250 B | ~110 B |
| `trc` with its signature | ~330 B | ~110 B |

A receiver that already has the KEL can accept a shorter reference to the latest establishment event (KERI's `-H` group). That saves about 40 bytes. LoRa payloads are often limited to somewhere between 50 and 250 bytes depending on settings (to confirm with `projects/mesh`), so an entry plus signature fits in one or two frames. KERI 2.0's native CESR messages are the standard answer and a later option.

## 8. Key management

### 8.1 Inception

1. The controller makes current key(s) and next key(s), and chooses `kt`, `nt`, witnesses and `bt`.
2. It builds the `icp` with the DID binding seal in `a`, computes the SAID (which is the AID), signs, and stores it as first seen.
3. It submits the event to its witnesses and collects `bt` receipts (section 9).

### 8.2 Hot and cold keys

Pre-rotation only helps if the next keys aren't where the current keys are. Deriving every key from one seed in the hot store defeats it. So keys live in two compartments (our call):
- **Hot**: only the current signing secrets. It signs entries and `ixn`s.
- **Cold**: a rotation seed. Key set *j* is derived from it with HKDF-SHA256(seed, salt `zk-toip/eventlog`, info `<label>/<j>/<n>`). The cold side gives out only digests of set *j+1*, and gives out the secrets of set *j+1* only when rotating.

| Where it runs | Hot | Cold |
|---|---|---|
| Browser (Settle's vault pattern) | sealed under the passkey | sealed under a second passkey, or a backup code kept offline |
| Device (`projects/capture`) | secure element or app storage | the owner's app, or a printed backup |
| MVP demo | separate in-process objects | separate in-process objects; a test proves the hot store alone can't rotate |

The `Signer` interface is asynchronous, so a hardware key or a passkey-backed signer fits.

### 8.3 Rotation

1. **Seal every open trail.** The library refuses to build a `rot` without a seal `{i, s, d}` for each open trail's current head. These seals end the outgoing epoch for each trail (section 11.2, R3).
2. **Release the next set from cold.** Build the new `k`, which must include enough of the prior next keys to meet the prior `nt`. Commit new `n` digests, optionally changing `kt`, `nt`, witnesses (`br`, `ba`) and `bt`.
3. **Sign with dual-indexed signatures.** The signatures must meet the new `kt` over the new `k` **and** the prior `nt` over the prior `n` (K1). Use code `A` when a key has the same position in both lists, `2A` when it doesn't, and `B` for new keys with no prior commitment.
4. Move the new current secrets into hot, discard the old ones, and get receipts.

Partial rotation, where only some prior next keys are exposed, is allowed by these rules and needed by section 8.5.

### 8.4 Recovery from a stolen signing key

1. The controller notices, from its own watcher or from a witness's duplicity report.
2. It rotates. The rotation's trail seals name the **last good entry** of each trail, not the head. Entries the attacker wrote under the old key after that become **cut**.
3. If the attacker added `ixn` events to the KEL, the recovery `rot` is placed at the sequence number of the first bad `ixn`. Under KERI's rule A0, it supersedes that `ixn` and everything after it, which move to a disputed branch (K1). Witnesses accept a superseding rotation even though they first saw the `ixn`.
4. Cut entries and superseded events are never deleted. The explorer shows them struck through, with the recovery that cut them.

A dishonest controller could use recovery to disown entries it regrets. The defense is visibility. Cut entries keep their witness receipts and any counterparty endorsements, so a counterparty holding one can show it was cut. Verifiers' policies can treat "cut after endorsement" as a red flag.

### 8.5 Custody patterns

These are examples, all expressible with integer thresholds:
- **Principal-held rotation key (agents):** `n` holds digests of the agent's next key and the principal's, with `nt = 1`. Either can rotate. The principal can therefore take over or kill the agent's identity, which is the point.
- **Owner-recoverable device (capture):** the same pattern, with the device's owner.
- **Two-of-three for a processor:** `kt = 2` over three keys held by different operators.

## 9. Witnesses and receipts

### 9.1 What a witness is

A service with a non-transferable AID (`B` plus its Ed25519 key) and a store. Its keys never rotate. If one is compromised, the controllers it serves rotate it out with `br` and `ba`. It can be reached over HTTP and, through its `did:key`, as a Trust Task endpoint on the relay.

### 9.2 What it does

**For a KEL event:**
1. Verify the event against its copy of the KEL (section 11.1).
2. If nothing is at that location yet, store it as first seen. Sign a KERI `rct` with a `-B` witness indexed signature, and return it. The index is the witness's position in the witness list in force.
3. If the same version is already there, return its existing receipt.
4. If a different version is there, refuse. Return the first-seen version and its receipt, and store the second one as duplicity evidence. The one exception is a valid superseding `rot` (rule A0).

**For a trail message:**
1. Verify the header and signatures against the controller's KEL, which the witness holds because it witnesses that KEL too.
2. Check the chain and the epoch rules (section 11.2).
3. Check that `dt` is no more than 5 minutes ahead of the witness's clock. It may be behind, for offline devices.
4. Apply first-seen at (trail id, `s`). A second version is accepted only if the first one is cut by an establishment event the witness has accepted.
5. Sign a `trc` with its own time.

**Storage and service:** it stores receipts from other witnesses that the controller forwards, and serves streams, heads and evidence. It never receives bodies.

**Which witnesses apply:** those listed in the establishment event named by the entry's signature group, with that event's `bt` (our call).

### 9.3 Getting receipts around

The controller submits to every witness and gathers receipts. On its next contact with each witness, it forwards the receipts from the others. This is KERI's round-robin pattern, at most 2·N exchanges per event (K1).

`publish()` returns when `bt` receipts are in, or reports which witnesses are missing. Until then an entry is **pending**.

`appendWitnessed()` waits for `bt` receipts before returning. Agents use it before consequential actions (section 12.1).

### 9.4 How many witnesses

With N witnesses and threshold M (`bt`), two different versions that each reach M receipts must share at least 2M − N witnesses that signed both. Each such witness is provably faulty. So the pool is immune to up to F = 2M − N − 1 dishonest witnesses, and stays available with up to N − M witnesses down (KAWA in K1; the arithmetic is ours).

| N | M | Dishonest witnesses tolerated | Down witnesses tolerated |
|---|---|---|---|
| 1 | 1 | 0 | 0 |
| 3 | 2 | 0, but any fork exposes a witness that signed both | 1 |
| 3 | 3 | 2 | 0 |
| 4 | 3 | 1 | 1 |
| 5 | 4 | 2 | 1 |
| 7 | 5 | 2 | 2 |

**Defaults (our call):** the MVP demo uses 3 and 2, which shows a rogue witness being caught. The recommended production default is 4 and 3.

When more witnesses collude than the threshold allows, only watchers protect a verifier (section 10).

## 10. Duplicity detection

### 10.1 What counts

- **Controller duplicity:** two versions at the same (log, `s`), both validly signed by the controller, where neither is cut or superseded by a valid establishment event.
- **Witness duplicity:** one witness's signatures on two different versions at the same location.
- **Not duplicity:** a cut entry and its replacement, or an `ixn` and the `rot` that superseded it. These are recoveries. They are reported as such.

### 10.2 Evidence

```ts
interface DuplicityEvidence {
  kind: "controller" | "witness";
  logId: Qb64; s: number;
  a: SignedMessage; b: SignedMessage;   // both versions, with the signatures that convict
  witness?: Qb64;                       // for witness duplicity
  detectedBy: string; detectedAt: string;
}
```

Evidence proves itself: `verifyEvidence` needs only the evidence and the controller's KEL. It can travel as a Trust Task (`trail/duplicity`) to anyone who relies on the log.

### 10.3 Watchers

A watcher belongs to a verifier: the principal, a counterparty, or the Settle processor.
- **It keeps first-seen copies** of the KELs and trail headers it cares about. Once seen, always seen (K1).
- **It polls witnesses' heads** (`head(logId)`, which returns a signed `trc` or `rct`) on a schedule, and on demand before a decision.
- **It compares** every version it is handed, whether by the controller, a witness or a peer, with its copy.
- **It gossips heads** with other watchers. A head is just a signed receipt, so a peer can't forge one.
- **It records evidence** and raises it.

**Checking a trail you were handed** (what the explorer does):
1. Verify it.
2. Ask at least `bt` witnesses for their head and for the entries since.
3. Any mismatch is either evidence or a gap. A gap means the controller showed an older head than the witnesses hold, so the bundle is truncated.

## 11. Verification, step by step

Every check returns a `Problem {code, at, message}`. Nothing throws on bad input. Problem codes are in section 13.3.

### 11.1 A KEL

For each event in order:

1. **Parse.** The version string is well-formed, the length matches the raw bytes, the type is supported, and the fields are exactly those of section 7.3, in order. The raw bytes are canonical. (`badVersion`, `badFields`, `unsupported`)
2. **SAID.** Recompute `d`. For `icp`, also require `i == d`. (`saidMismatch`)
3. **Position.** `s` is `0` for `icp`, else the previous `s` + 1. `i` matches. `p` is the previous event's `d`. Nothing follows an abandonment. (`badSequence`, `badChain`, `abandoned`)
4. **Shape.** Keys are `D`, digests `E`, witnesses `B` and unique. 1 ≤ `kt` ≤ |k|; `nt` ≤ |n|; `bt` ≤ |b|, and 0 if `b` is empty. `br` entries must be current witnesses; `ba` entries must not be (after removal). Traits are allowed. (`badFields`, `unsupported`)
5. **Controller signatures.**
   - `icp` and `ixn`: distinct valid signatures over the raw bytes, from the current `k`, reaching `kt`.
   - `rot`: those signatures must also reach the prior `nt`, counting only the signatures whose key's digest matches the prior `n` at the second index.

   (`signatureInvalid`, `thresholdNotMet`, `nextKeyMismatch`)
6. **Witness receipts.** Count distinct valid signatures from the witness list in force after this event (for a `rot`, the new list), whether attached or from `rct`s. Fewer than `bt` gives the problem `notWitnessed` and status `pending`, unless the caller allows unwitnessed events (a controller checking its own log). (`notWitnessed`)
7. **First seen.** If a store is given, compare with what it holds at (`i`, `s`).
   - Same: fine.
   - Different, and the new one is a `rot` superseding an `ixn` under rule A0: record the supersession, and mark the old branch disputed.
   - Different otherwise: record controller duplicity. Keep the first-seen version as the trunk. (`duplicity`)
8. **Key state.** Apply the event. Keep the history of key states by establishment event.

The result is the key state history, each event's status, the problems, and any evidence.

### 11.2 A trail

This needs the controller's verified KEL (11.1). For each message in order:

1. Parse, SAID, position and chain, as for the KEL. `tin` has `s = 0` and `i == d`. Nothing follows a `tcl`. (`afterClose`)
2. **Key state reference.** The `-F` group names an establishment event (sn, SAID) that is in the KEL trunk. The signatures meet that event's `kt` over its `k`. (`unknownKeyState`, `signatureInvalid`, `thresholdNotMet`)
3. **Epoch rules (our call):**
   - **R1. Monotonic.** The referenced establishment event is not earlier than the previous entry's. (`staleKeyState`)
   - **R2. Not after a retirement.** Let the referenced event be epoch *j*, and let event *j+1* be the next establishment event in the KEL, if any. Event *j+1* must hold a seal for this trail at `s = h`, unless the trail began after it. Entries of epoch *j* with `s ≤ h` are fine. Those with `s > h` are **cut**. If *j+1* has no seal for this trail, every entry of epoch *j* is flagged `unsealedRotation`. An honest controller never produces this, because the library always seals.
   - **R3. Seals match.** For every seal of this trail in any KEL event, a rotation or a checkpoint `ixn`, the entry at `s` must have SAID `d`. If not, the trail shown is not the one the controller sealed. (`sealMismatch`, which is evidence of a fork)
   - **R4. Checkpoint epochs.** An entry sealed by an `ixn` at KEL sn *c* must use a key state in force at or before *c*. (`staleKeyState`)
4. **`dt`.** It is not before the previous entry's. (`timeReversed`)
5. **Receipts.** Count valid `trc`s from the witness list of the referenced establishment event, and require `bt`. Each receipt's `dt` is an upper bound on when the entry existed. Keep the earliest. Endorsements from others are verified and listed separately. (`notWitnessed`)
6. **First seen and duplicity,** as in 11.1 step 7, with the cut rule from 9.2 step 4.
7. **Bodies,** where given: recompute the body's SAID with JCS and the dummy `d`, and compare with the header's `a`. (`bodyMismatch`)

Entry statuses: `valid` (witnessed), `pending` (not yet `bt` receipts), `cut`, `invalid`. Each entry also reports:
- `anchoredBy`: the KEL sn of the first checkpoint or rotation that sealed it or a later entry;
- the earliest receipt time;
- its endorsers.

### 11.3 A signature made outside the log, such as a capture

Input: the signed bytes, a `-F` group (AID, establishment event sn and SAID, indexed signatures), the verified KEL, and optionally the trail entry that anchors the bytes' digest.

1. The establishment event is in the KEL trunk, and the signatures meet its `kt`.
2. **Current:** that event is still the latest establishment event.
3. **Retired at:** the sn of the rotation after it, if any.
4. **Anchored before retirement:** an entry in the controller's trail has `a` or `x` equal to the bytes' digest, uses the same key state, and is `valid` and not cut. With 11.2, R2, this proves the signature was made while the key was current. It is the strong answer for capture.
5. **Witnessed by:** the earliest receipt time of that entry.
6. **Disputed:** the anchoring entry was cut.

So a 2026 capture still verifies in 2028 after rotations, and says "signed under key state 0, anchored in entry 41 before key state 0 was retired, witnessed by 2026-11-06T18:04Z". A signature by a retired key with no anchor gives `valid: true, anchoredBeforeRetirement: false`. Policy decides; the explorer shows it in amber.

### 11.4 A bundle

A bundle is what gets handed around: KEL stream, trail streams, the bodies disclosed, and DID bindings.

1. Verify the KEL.
2. Verify each trail, then each binding: the `signDocument` proof checks, and the seal is present in the KEL.
3. If any witness is reachable, compare heads (10.3).
4. Report whether the bundle is **witness-checked**, meaning heads were compared at verification time, or **offline**, meaning complete only up to the last head shown.

## 12. How other projects use it

### 12.1 `projects/agents` (the main consumer)

- **Identity.** Each agent gets an AID at creation. Its `icp` seals the DID binding to the agent's `did:key`. The principal holds a rotation key by default (section 8.5, and open question 3).
- **One trail per agent,** purpose `agent/actions`. Proposed kinds:

| Kind | Body holds |
|---|---|
| `agent/mandate-accepted` | the mandate credential's digest and id |
| `agent/tool-call` | tool name, digest of the arguments (or the arguments), and the policy decision that allowed it |
| `agent/tool-result` | digest of the result, and status |
| `agent/message-sent` | Trust Task document id and digest, recipient, type |
| `agent/message-received` | the same |
| `agent/approval-requested` | what, from whom |
| `agent/approval-granted` | the principal's signed approval document. The principal also endorses the entry. |
| `agent/payment-intent` | Settle terms hash, amount, payee |
| `agent/payment` | escrow address, outcome |

- **Witness before you act.** For payments and anything a mandate marks consequential, the agent calls `appendWitnessed`.
- **Cite your entry.** Its Trust Task requests (for example `payment/request` to Settle) carry a `trailRef: {i, s, d}` in the payload.
- **Counterparties check it.** A counterparty's policy can require a `trailRef`. It fetches the header and receipts from a witness, checks them, and endorses the entry with a `trc`. Then it seals the reference in its own trail if it has one. That is KERI's "mutual interaction" proof of priority (K1): the agent can't later deny the entry, even with every witness against it.
- **The principal reviews** in the explorer, or in the agents project's own UI using the library. Bodies come to the principal over TSP (`trail/disclose`), sealed as every TSP message is.

### 12.2 `projects/capture` (the second consumer)

- **Each device has an AID,** incepted at provisioning, with its owner holding a rotation key.
- **The capture manifest** (whatever capture defines) is signed with a `-F` group, so it names its key state.
- **Each capture gets an entry** in the device's `device/captures` trail, with `a` set to the manifest's digest.
- **Offline devices** chain and sign locally, then publish on reconnect. Their receipts then prove "existed by" the upload time, not the capture time. The explorer says so.
- **Rotation** (a scheduled rotation, a repair, or a transfer of ownership) goes through the cold side. It seals the captures trail, so older captures stay verifiable (11.3).
- **Volume.** One entry per capture is fine for cameras. High-rate sensors want Merkle-root batching (a KERI seal type), which is listed for later.

### 12.3 `projects/settle`

The library replaces `projects/settle/src/protocol/log.ts`, in a later change to Settle:

| Today | With `@zk-toip/eventlog` |
|---|---|
| `new TransparencyLog(identity, clock)` | the processor's `Controller` (AID bound to its `did:key`) plus `openTrail("settle/transparency")` |
| `append(kind, termsHash, detail)` | `trail.append({kind: "settle/" + kind, body: {termsHash, ...detail}})`. Bodies are published, because the log is public. |
| `snapshot()`, a signed `LogHead` | `exportBundle(…, {bodies: "all"})`, with witness receipts in place of the self-signed head |
| `verifyLog(entries, head, did)` | `verifyBundle(bundle, {expectDid: processorDid})` |
| `load(entries)` on restart | `JsonFileStore`, re-verified on load |

- **Migration.** The first entry of the new trail, `settle/legacy-head`, carries the old log's size and head hash, so the old history stays attested.
- **The on-chain anchoring** Settle's design promises (its §9) becomes a checkpoint SAID written on Solana. That is a "registrar backer" in KERI terms. It comes later.
- **Agents paying through Settle** cite their `agent/payment-intent` entry. The processor records it in the `x` of its own `settle/opened` entry, which cross-anchors the two trails.

### 12.4 `projects/mesh`

- It carries the compact form (7.8).
- Witness receipts can wait. A message relayed over LoRa can be receipted later, when a node reaches a witness.
- A witness may run on a mesh gateway.

### 12.5 Others

`projects/commons` lists audit trails for status changes (`audit/list`, `audit/verify` in its design). It can use a trail per building service. `projects/agora` and `projects/tipline` are not expected to need it, but a tipline's intake log could use it.

## 13. Shared library needs

### 13.1 Package

- **`packages/eventlog`**, published as `@zk-toip/eventlog`. It is not called `kel`, because it holds trails, witnesses and watchers too.
- **Runtime dependencies:** `@noble/curves` 2.4.0, `@noble/hashes` 2.4.0 (Blake3, HKDF and SHA-256) and `@zk-toip/trust-core` (`Clock`, `Identity`, `signDocument`, `verifyDocument`, `canonicalJson`, `Endpoint`, `ourSpec`, base64url). All are already in the workspace.
- **Optional for tests only:** KERIpy 1.3.x (Python, run from an interop script) and `cesr-ts` 1.0.0, to parse our streams independently.
- Browser-safe except `JsonFileStore`, which is exported from `@zk-toip/eventlog/node`.

```
packages/eventlog/src/
  cesr.ts        primitives, qb64, indexed signatures, attachments, stream parse/emit
  said.ts        version strings, fixed-order serialization, SAIDs, JCS bodies
  kel.ts         KEL event builders, key state, verifyKel
  trail.ts       trail message builders, verifyTrail
  keys.ts        Signer, hot/cold key sources
  controller.ts  Controller and Trail (the writing side)
  witness.ts     Witness, WitnessClient, HTTP and Trust Task adapters
  watcher.ts     Watcher, duplicity evidence
  verify.ts      verifySignature, bundles, DID bindings
  compact.ts     binary transcoding
  store.ts       LogStore, MemoryStore
  node/fileStore.ts
  index.ts
```

### 13.2 API

```ts
// ---- primitives (cesr.ts, said.ts)
export type Qb64 = string;
export const Code: { Ed25519: "D"; Ed25519N: "B"; Blake3: "E"; Ed25519Sig: "0B"; Salt128: "0A" };
export function encode(code: string, raw: Uint8Array): Qb64;
export function decode(qb64: Qb64): { code: string; raw: Uint8Array };
export function digest(bytes: Uint8Array | string): Qb64;                 // Blake3-256, "E"
export function nextKeyDigest(publicKey: Qb64): Qb64;                     // digest of the key's qb64 text
export function nonTransferableAid(publicKey: Uint8Array): Qb64;          // "B…"
export function didKeyOf(aidB: Qb64): string;  export function aidOfDidKey(did: string): Qb64;

export interface IndexedSig { code: "A" | "B" | "2A"; index: number; ondex?: number; sig: Uint8Array }
export interface KeyRef { aid: Qb64; estSn: number; estSaid: Qb64 }
export interface KeyRefSig extends KeyRef { sigs: IndexedSig[] }            // a -F group
export function encodeKeyRefSig(s: KeyRefSig): string;  export function decodeKeyRefSig(text: string): KeyRefSig;

export function saidify<T extends Record<string, unknown>>(protocol: "KERI" | "ZKTR", fields: T, saidFields: ("d" | "i")[]): { raw: string; body: T };
export function makeBody(fields: Record<string, unknown>, random?: (n: number) => Uint8Array): { body: Body; said: Qb64; raw: string };
export function checkBody(body: Body): boolean;

// ---- messages
export type Seal = { d: Qb64 } | { i: Qb64; s: string; d: Qb64 };
export interface SignedMessage {
  t: "icp" | "rot" | "ixn" | "rct" | "tin" | "ten" | "tcl" | "trc";
  raw: string;                 // exact bytes signed and hashed
  body: Record<string, unknown>;
  logId: Qb64; s: number; d: Qb64;
  controllerSigs?: IndexedSig[];      // -A, on KEL events
  witnessSigs?: IndexedSig[];         // -B, on KEL events
  keyRefSig?: KeyRefSig;              // -F, on trail messages and endorsements by AIDs
  couples?: { signer: Qb64; sig: Uint8Array }[];  // -C, on trc and KERI non-transferable receipts
}
export function toStream(msgs: SignedMessage[]): string;
export function fromStream(text: string): { messages: SignedMessage[]; problems: Problem[] };
export function toCompact(msg: SignedMessage): Uint8Array;
export function fromCompact(bytes: Uint8Array): SignedMessage;           // rebuilds raw JSON, checks SAID

// ---- keys (keys.ts)
export interface Signer { readonly publicKey: Uint8Array; sign(message: Uint8Array): Promise<Uint8Array> }
export function ed25519Signer(secret: Uint8Array): Signer;
export function signerFromIdentity(id: Identity): Signer;                  // reuse a did:key's key
export interface ColdKeys {
  commit(set: number, count: number): Qb64[];       // next-key digests for key set `set`
  release(set: number, count: number): Signer[];    // the secrets of key set `set`, only for rotation
}
export function coldKeysFromSeed(rotationSeed: Uint8Array, label: string): ColdKeys;

// ---- key state (kel.ts)
export interface KeyState {
  aid: Qb64; sn: number; said: Qb64;          // latest event
  estSn: number; estSaid: Qb64;               // latest establishment event
  kt: number; keys: Qb64[]; nt: number; next: Qb64[];
  bt: number; witnesses: Qb64[]; traits: string[];
  abandoned: boolean;
}

// ---- writing (controller.ts)
export interface InceptOptions {
  hot: Signer[];                    // current keys
  cold: ColdKeys; nextCount?: number;
  kt?: number; nt?: number;
  witnesses?: Qb64[]; bt?: number;
  anchors?: Seal[];                 // e.g. bindingSeal(binding)
  checkpoint?: { everyEntries?: number; everyMs?: number };   // automatic ixn checkpoints
  store: LogStore; clock: Clock;
}
export class Controller {
  static incept(opts: InceptOptions): Promise<Controller>;
  static load(aid: Qb64, opts: { hot: Signer[]; cold?: ColdKeys; store: LogStore; clock: Clock }): Promise<Controller>;
  readonly aid: Qb64;
  state(): KeyState;
  interact(anchors: Seal[]): Promise<SignedMessage>;
  rotate(opts?: {
    kt?: number; nt?: number; nextCount?: number;
    addWitnesses?: Qb64[]; removeWitnesses?: Qb64[]; bt?: number;
    anchors?: Seal[];
    cutAfter?: Record<Qb64, number>;   // recovery: seal these trails at these s, not at their heads
    supersede?: number;                // recovery: place the rot at this KEL sn, superseding ixns
    exposed?: Signer[];                // signers of prior next keys held elsewhere (custody patterns)
  }): Promise<SignedMessage>;
  openTrail(purpose: string): Promise<Trail>;
  trail(id: Qb64): Trail;
  trails(): Trail[];
  bind(identity: Identity): Promise<DidBinding>;               // signs a binding and seals it via ixn
  publish(witnesses: WitnessClient[]): Promise<PublishReport>; // submit pending messages, round-robin receipts
}
export class Trail {
  readonly id: Qb64; readonly controller: Qb64; readonly purpose: string;
  append(input: { kind: string; body?: Record<string, unknown>; refs?: Seal[] }): Promise<{ entry: SignedMessage; body?: Body }>;
  appendWitnessed(input: { kind: string; body?: Record<string, unknown>; refs?: Seal[] },
                  witnesses: WitnessClient[], opts?: { timeoutMs?: number }): Promise<{ entry: SignedMessage; body?: Body; receipts: SignedMessage[] }>;
  close(): Promise<SignedMessage>;
  head(): { s: number; d: Qb64 };
  ref(s?: number): Seal;          // {i, s, d}, for trailRef in Trust Tasks
}
export interface PublishReport { sent: number; receipted: { logId: Qb64; s: number; witnesses: Qb64[] }[]; missing: { witness: Qb64; error: string }[]; evidence: DuplicityEvidence[] }

// ---- witnessing (witness.ts)
export class Witness {
  constructor(opts: { signer: Signer; store: LogStore; clock: Clock; maxSkewMs?: number });
  readonly aid: Qb64;  readonly did: string;
  submit(stream: string): Promise<SubmitResult>;
  addReceipts(stream: string): Promise<void>;
  query(q: { logId: Qb64; from?: number; to?: number }): Promise<string>;   // stream with attachments and receipts
  head(logId: Qb64): Promise<SignedMessage | undefined>;                     // its receipt of the latest message
  evidence(logId?: Qb64): Promise<DuplicityEvidence[]>;
}
export type SubmitResult =
  | { ok: true; receipts: string }
  | { ok: false; refusal: "invalid" | "duplicity" | "unknownController" | "clockSkew"; problems: Problem[]; firstSeen?: string };
export interface WitnessClient {
  readonly aid: Qb64;
  submit(stream: string): Promise<SubmitResult>;
  addReceipts(stream: string): Promise<void>;
  query(q: { logId: Qb64; from?: number; to?: number }): Promise<string>;
  head(logId: Qb64): Promise<SignedMessage | undefined>;
}
export function localWitnessClient(w: Witness): WitnessClient;
export function httpWitnessClient(baseUrl: string, aid: Qb64): WitnessClient;
export function taskWitnessClient(endpoint: Endpoint, witnessDid: string): WitnessClient;
export function serveWitnessTasks(endpoint: Endpoint, w: Witness): void;
export function witnessHttpHandler(w: Witness): (req: Request) => Promise<Response>;   // fetch-style handler

// ---- watching (watcher.ts)
export interface DuplicityEvidence { kind: "controller" | "witness"; logId: Qb64; s: number; a: SignedMessage; b: SignedMessage; witness?: Qb64; detectedBy: string; detectedAt: string }
export class Watcher {
  constructor(opts: { id: string; store: LogStore; sources: WitnessClient[]; clock: Clock });
  watch(logId: Qb64, controller: Qb64): void;
  ingest(stream: string, from: string): Promise<{ evidence: DuplicityEvidence[]; problems: Problem[] }>;
  poll(): Promise<DuplicityEvidence[]>;
  heads(logId: Qb64): Promise<{ source: string; s: number; d: Qb64; receipt: SignedMessage }[]>;
}
export function verifyEvidence(e: DuplicityEvidence, kel: KelResult): Promise<boolean>;

// ---- verifying (kel.ts, trail.ts, verify.ts)
export interface VerifyOptions { allowUnwitnessed?: boolean; firstSeen?: LogStore; clock?: Clock }
export interface KelResult {
  ok: boolean; aid: Qb64;
  states: KeyState[];                    // one per establishment event, in order
  latest: KeyState;
  events: { s: number; d: Qb64; t: string; status: "valid" | "pending" | "superseded" | "invalid"; receipts: Qb64[] }[];
  superseded: { s: number; d: Qb64; by: Qb64 }[];
  problems: Problem[]; evidence: DuplicityEvidence[];
}
export function verifyKel(input: string | SignedMessage[], opts?: VerifyOptions): Promise<KelResult>;
export type EntryStatus = "valid" | "pending" | "cut" | "invalid";
export interface TrailResult {
  ok: boolean; trailId: Qb64; controller: Qb64; purpose: string; closed: boolean;
  entries: {
    s: number; d: Qb64; t: "tin" | "ten" | "tcl"; kind: string; dt: string;
    status: EntryStatus; keyState: KeyRef;
    receipts: { witness: Qb64; dt: string }[]; earliestReceipt?: string;
    endorsements: { signer: string; dt: string }[];
    anchoredBy?: number;                 // KEL sn of the sealing ixn/rot
    body?: { said: Qb64; ok: boolean };
    cutBy?: number;                      // KEL sn of the rotation that cut it
  }[];
  problems: Problem[]; evidence: DuplicityEvidence[];
}
export function verifyTrail(input: { kel: KelResult; stream: string | SignedMessage[]; bodies?: Body[] }, opts?: VerifyOptions): Promise<TrailResult>;
export interface SignatureCheck {
  valid: boolean; keyState: KeyRef; current: boolean; retiredAt?: number;
  anchored?: { trailId: Qb64; s: number }; anchoredBeforeRetirement: boolean;
  witnessedBy?: string; disputed: boolean; problems: Problem[];
}
export function verifySignature(input: { bytes: Uint8Array; sig: KeyRefSig; kel: KelResult; trails?: TrailResult[] }): Promise<SignatureCheck>;

// ---- DID binding and bundles (verify.ts)
export interface DidBinding { type: "trail/did-binding"; issuer: string; aid: Qb64; issuedAt: string; replaces?: Qb64; proof?: unknown }
export function makeBinding(identity: Identity, aid: Qb64, clock: Clock, replaces?: Qb64): DidBinding;
export function bindingSeal(b: DidBinding): Seal;
export function verifyBinding(b: DidBinding, kel: KelResult, clock: Clock): Promise<{ ok: boolean; sealedAt?: number; replacedAt?: number; problems: Problem[] }>;
export interface Bundle { kel: string; trails: { id: Qb64; stream: string; bodies?: Body[] }[]; bindings: DidBinding[] }
export function exportBundle(store: LogStore, aid: Qb64, opts?: { trails?: Qb64[]; bodies?: "all" | "none" | Qb64[] }): Promise<Bundle>;
export function verifyBundle(b: Bundle, opts?: VerifyOptions & { expectDid?: string; witnesses?: WitnessClient[] }):
  Promise<{ ok: boolean; kel: KelResult; trails: TrailResult[]; bindings: { did: string; ok: boolean }[]; witnessChecked: boolean; problems: Problem[] }>;

// ---- Trust Task specs (ourSpec names)
export const TRAIL_TASKS: { submit: SpecPolicy; receipts: SpecPolicy; query: SpecPolicy; head: SpecPolicy; disclose: SpecPolicy; duplicity: SpecPolicy };
// trail/witness/submit {stream} → SubmitResult      trail/witness/receipts {stream} → {}
// trail/query {logId, from?, to?} → {stream}         trail/head {logId} → {receipt}
// trail/disclose {bundle} → {}                       trail/duplicity {evidence} → {}
```

### 13.3 Problems

```ts
export interface Problem { code: ProblemCode; logId?: Qb64; s?: number; message: string }
export type ProblemCode =
  | "badVersion" | "badFields" | "unsupported" | "saidMismatch" | "badSequence" | "badChain"
  | "abandoned" | "signatureInvalid" | "thresholdNotMet" | "nextKeyMismatch" | "notWitnessed"
  | "duplicity" | "unknownKeyState" | "staleKeyState" | "unsealedRotation" | "sealMismatch"
  | "timeReversed" | "afterClose" | "bodyMismatch" | "bindingInvalid" | "truncated";
```

### 13.4 Storage

```ts
export interface StoredMessage {
  logId: Qb64; s: number; d: Qb64; t: SignedMessage["t"];
  raw: string; attachments: string;      // CESR text of the controller's signatures
  fn: number;                            // first-seen ordinal in this store
  seenAt: string; local: boolean;        // made here, or received
  superseded?: Qb64; cutBy?: number;
}
export interface StoredReceipt { by: Qb64; kind: "witness" | "endorsement"; raw: string; attachments: string; dt?: string }
export interface LogStore {
  /** Never overwrites. "first": stored as first seen. "same": already held. "other": another version is first seen; this one is kept as a version. */
  put(m: StoredMessage): Promise<"first" | "same" | "other">;
  get(logId: Qb64, s: number): Promise<StoredMessage | undefined>;        // the trunk version
  versions(logId: Qb64, s: number): Promise<StoredMessage[]>;             // every version seen, in first-seen order
  range(logId: Qb64, from?: number, to?: number): Promise<StoredMessage[]>;   // trunk, ascending
  head(logId: Qb64): Promise<StoredMessage | undefined>;
  markSuperseded(logId: Qb64, s: number, d: Qb64, by: Qb64): Promise<void>;
  markCut(logId: Qb64, s: number, d: Qb64, byKelSn: number): Promise<void>;
  addReceipt(logId: Qb64, s: number, d: Qb64, r: StoredReceipt): Promise<void>;   // idempotent per (by, d)
  receipts(logId: Qb64, s: number, d: Qb64): Promise<StoredReceipt[]>;
  putBody(said: Qb64, raw: string): Promise<void>;
  getBody(said: Qb64): Promise<string | undefined>;
  putEvidence(e: DuplicityEvidence): Promise<void>;
  evidence(logId?: Qb64): Promise<DuplicityEvidence[]>;
  logs(): Promise<{ logId: Qb64; kind: "kel" | "trail"; controller: Qb64 }[]>;
}
export class MemoryStore implements LogStore {}
// @zk-toip/eventlog/node:
export class JsonFileStore implements LogStore { constructor(path: string, opts?: { flushMs?: number }) }
```

- `JsonFileStore` writes atomically (write to a temporary file, then rename) within `flushMs` of a change, as Settle's `agents.json` does. It is re-verified on load.
- An IndexedDB store for browsers comes when a browser app needs persistence.

## 14. MVP scope

### 14.1 The library

Everything in section 13, with the limits of section 5.4.

### 14.2 The project, `projects/trail/`

```
projects/trail/
  src/
    service.ts     starts 3 witnesses (each its own key and JsonFileStore), a watcher and the explorer API
    agentSim.ts    a scripted "AI agent" that writes entries (no model; fixed script)
    cameraSim.ts   a scripted device that signs captures and rotates
    attacks.ts     the demo's attacks: tamper, fork, rogue witness, key theft, retired-key forgery
    demo.ts        narrated CLI demo, like Settle's
  web/             explorer (Vite + React, like Settle's web app)
  tests/
  interop/keripy_check.py   reads a stream and prints KERIpy's key state as JSON
```

**Service** (`npm run trail`, at `http://localhost:4500` (our call)):
- `/w/1`, `/w/2` and `/w/3` serve the witness HTTP API: `POST submit`, `POST receipts`, `GET log/:id`, `GET head/:id`, `GET evidence`.
- `/api` serves the explorer: list logs, get a bundle, verify an uploaded bundle, show the watcher's evidence, and run demo actions (local only).
- The data lives in `projects/trail/.data`, and `--fresh` starts over.

**Explorer** pages:
1. **Identifier:** the AID, its bound `did:key`, and a key-state timeline (each establishment event, its keys as short fingerprints, its thresholds and witnesses). Superseded events are struck through.
2. **Trail:** entries in order, colored by epoch. Each row shows a status chip (valid 3/3, pending 1/3, cut, invalid), its kind, `dt` against its earliest receipt time, and where it is anchored.
3. **Entry:** the raw header, the body if disclosed, and every check from section 11 as a list of passes and failures.
4. **Verify:** drop a bundle file. It verifies in the browser with the same library, then compares with the witnesses if they're reachable.
5. **Duplicity:** evidence side by side, with the differing fields highlighted.
6. **Demo** (local only): buttons for the attacks in `attacks.ts`.

**Not in the MVP:**
- a real model behind the agent;
- authentication on the service (it listens on localhost only);
- a browser store;
- the Trust Task witness transport in the UI. It is tested in the library, but the demo uses HTTP.

## 15. Demo script

`npm run demo --workspace @zk-toip/trail` runs it narrated in the terminal. The explorer shows the same story step by step.

1. **Birth.** Ada creates an agent, "Scout". Scout's AID is incepted with three witnesses, two required, and a rotation key held by Ada. Its DID binding is sealed in the inception. The explorer shows the KEL with 3/3 receipts.
2. **Work.** Scout runs a fixed script:
   - accepts a mandate;
   - makes two tool calls;
   - messages a supplier;
   - asks Ada for approval, which Ada grants and endorses;
   - logs a payment intent with `appendWitnessed`.

   Seven entries (`s` 1 to 7, after the `tin` at 0), all valid 3/3. A checkpoint `ixn` at KEL sn 1 seals the head.
3. **Ada reviews.** Ada opens Scout's trail with bodies disclosed. Every check passes. The bundle says "witness-checked".
4. **Tamper.** The script edits the payment amount in a saved bundle, from 340 to 3,400. Verify fails with `bodyMismatch` at entry 7. It then edits the header's `a` to match the new body, and verify fails with `saidMismatch`. It then recomputes the SAID too, and verify fails with `signatureInvalid` at entry 7 and `sealMismatch` against the checkpoint. Each layer fails in turn.
5. **Fork.** From here, `attacks.ts` makes Scout misbehave on purpose. Scout shows the supplier a different entry 6 (no approval asked). The witnesses refuse the second version and return their first-seen receipts. The supplier's watcher holds both signed versions. Controller duplicity evidence appears in the explorer and is sent to Ada.
6. **Rogue witness.** Witness 3 is switched to "sign anything". Scout makes two versions of entry 8: witness 1 receipts A, witness 2 receipts B, and witness 3 receipts both. Each version reaches 2 receipts. The watcher, polling all three, holds witness 3's two signatures at one location: witness duplicity, with witness 3 convicted, and controller duplicity against Scout. Ada rotates (KEL sn 2) with her rotation key: it removes witness 3 (`br`), adds witness 4 (`ba`), and seals version A of entry 8.
7. **Key theft and recovery.** An attacker copies Scout's hot key and appends two "tool calls" (entries 9 and 10) plus a checkpoint `ixn` at KEL sn 3. Ada's watcher flags tool calls her policy doesn't allow. Ada rotates using her rotation key. The rotation goes at KEL sn 3, superseding the attacker's `ixn` (rule A0), and seals the trail at entry 8. The explorer shows entries 9 and 10 struck through, "cut by recovery at KEL 3". Scout continues under the new key with a new entry 9.
8. **The old key, later.** The attacker uses the stolen (now retired) key to write another entry 9 for someone who never saw the trail. Verification marks it cut, because the recovery sealed that key's epoch at entry 8.
9. **A camera across rotations** (for capture). A camera signs photo A under key state 0, anchors it, rotates, and signs photo B under key state 1. Both verify. A third photo signed with the retired key 0 also verifies as a signature, but shows "signed by a retired key, not anchored before retirement" in amber.
10. **Interop** (if KERIpy is installed). The script exports Scout's KEL as a CESR stream, runs `interop/keripy_check.py`, and shows KERIpy's key state matching ours: AID, sn, keys, next digests and witnesses.

## 16. Test plan

What must be proven, by test name.

**Encoding**
- `said: CESR known answers.` The CESR spec's two SAID examples reproduce exactly: `ENI2bDYghiu1KYYkFrPofH8tJ5tNiNt8WrTIc4s_5IIH` and `EJymtAC4piy_HkHWRs4JSRv0sb53MZJr8BQ4SMixXIVJ` (C1).
- `next digest: known answer.` The KERI spec's inception example lists the next keys and their digests. Check that `nextKeyDigest` maps one to the other. If the order differs, take a vector from KERIpy instead.
- `qb64 round trip` for every code in 7.1, plus rejection of wrong lengths and codes.
- `version string`: the length is right, and is wrong after any change of length.
- `canonical raw`: whitespace, reordered fields and escaped non-ASCII are all rejected.
- `compact round trip`: every message type round-trips to identical raw bytes, and a flipped bit fails the SAID check.

**Tamper detection**
- `any byte flip fails.` Property test: flip a random byte anywhere in a valid KEL or trail stream, 10,000 times. Verification never returns `ok`, and the problem is one of the expected codes.
- `body tamper`, `header tamper`, `reorder`, `delete middle`, `duplicate entry`: each gives its specific problem.
- `truncation`: a bundle missing the last entries verifies offline as "complete up to s", and fails `truncated` when a witness head is compared.

**Fork and duplicity**
- `controller fork`: two versions at one location go to different witnesses. At most one reaches `bt`, the other is refused, and evidence verifies standalone.
- `witness duplicity`: a witness that signs two versions is convicted by `verifyEvidence`. A witness that signs one is not.
- `seal mismatch`: a trail whose sealed entry differs from the one shown fails `sealMismatch`.
- `watcher gossip`: two watchers each seeing one version detect duplicity after exchanging heads.
- `recovery is not duplicity`: a cut entry and its replacement, and a superseded `ixn` and its `rot`, are reported as recovery, not evidence.

**Rotation correctness**
- `rotation needs prior next keys`: a rotation signed only by the current keys, or by keys whose digests aren't in prior `n`, fails `nextKeyMismatch`.
- `dual threshold`: with prior `nt = 2` of 3, signatures from two prior-next keys pass and from one fail. With new `kt = 2`, both thresholds are enforced independently.
- `partial rotation`: the principal's key alone rotates (prior `nt = 1` of 2). It signs with a `2A` signature: index 0 in the new keys, 1 in the prior next digests.
- `witness changes`: `br` then `ba` applied in order. Removing a non-member or adding a member fails.
- `abandonment`: an empty `n` ends the KEL, and any later event fails `abandoned`.
- `A0 only`: a `rot` supersedes an `ixn`. A `rot` can't supersede a `rot`, and an `ixn` supersedes nothing.
- `hot store can't rotate`: a controller loaded with only hot keys can append and interact, but `rotate` fails.

**Historical signatures**
- `capture after rotation`: a signature under key state 0, checked after two rotations, is `valid`, `current: false`, `retiredAt: 1`, `anchoredBeforeRetirement: true`.
- `retired key forgery`: new bytes signed with key state 0 after rotation are `valid` but `anchoredBeforeRetirement: false`. As a trail entry they are `cut` or `staleKeyState`.
- `epoch monotonic`: an entry under key state 0 after one under key state 1 fails `staleKeyState`.
- `rotation seals trails`: `rotate()` without seals for open trails is refused by the builder. A hand-built one makes `unsealedRotation` flags.

**Witnesses**
- `first seen, always seen`: restarting a witness on its `JsonFileStore` keeps its first-seen versions and refuses others.
- `clock skew`: `dt` more than 5 minutes ahead is refused. A `dt` in the past is receipted, with the receipt's own time.
- `receipt round robin`: after `publish`, every witness holds every other witness's receipts.
- `trust task transport`: submit, receipts, query and head work over the in-memory bus with real TSP, as Settle's tests do.

**Interop** (runs when `KERIPY=1` and Python with `keri` 1.3.x is present. Otherwise each is skipped with a message.)
- `keripy accepts ours`: icp; icp + ixn; icp + rot (full); icp + rot (partial); witness add/remove; a superseding recovery. KERIpy's key state equals ours.
- `we accept keripy's`: KELs generated by a fixed KERIpy script (salts and witnesses committed as fixtures) verify with the same key state.
- `cesr-ts parses ours` (optional dev dependency): our streams parse without errors.

**Settle parity** (when Settle switches)
- Settle's existing log checks pass against the new trail, and the `settle/legacy-head` migration verifies.

## 17. Open questions

1. **Revisit keri-ts?** If keri-ts 1.x gains a browser build, should the KEL module move onto it? Our KELs would carry over unchanged. Suggest: check again at keri-ts 1.1.
2. **KERI 1.0 or 2.0?** We chose 1.0 because KERIpy's stable releases and the KERIA/signify ecosystem use it, and 2.0 implementations must still accept it (K1, C1). KERIpy's main branch already defaults to 2.0. When should we move?
3. **Should the principal hold a rotation key for every agent by default?** It gives recovery and a kill switch, and also total power over the agent's identity. `projects/agents` should decide.
4. **Trail kinds in headers.** Visible kinds let counterparties filter without bodies. Hidden kinds hide activity from witnesses. Default visible?
5. **Who runs witnesses?** Settle could run one, the principal one, and a community or the relay operator one. Is a witness a role of the relay? This is a governance question for the convener.
6. **A Data Integrity proof for AIDs.** Trust Task proofs today are `eddsa-jcs-2022` with `did:key` verification methods. Should documents signed by an AID key state carry a `-F` group in a proof field? Or should we register a verification-method form for AID key states?
7. **Delegation for agents.** KERI delegation (`dip`, `drt`) fits "the principal approves this agent's identity and its rotations" better than a shared rotation key. It is the next big feature if agents want it.
8. **Merkle batching for sensors.** Is one entry per capture enough for `projects/capture`, or do we need KERI Merkle-root seals soon?
9. **Body disclosure to counterparties.** Disclose single bodies, or a selected set? Disclosing headers between two entries reveals that something happened between them, though not what.
10. **Provenance notes.** This design cites sources K1 to K7 below. They should become a source note in `docs/sources/` (S04) when the coordinator merges this. This project may not edit outside its folder.

## 18. Sources

All read on 2026-11-06 through the GitHub API and the npm and PyPI registries. Trust levels follow `docs/provenance.md`.

- **K1. KERI specification**, status v1.1. `spec/spec-body.md` in https://github.com/trustoverip/tswg-keri-specification (last change 2026-08-05). The latest draft has moved to https://github.com/trustoverip/kswg-keri-specification. Read in full: field labels, version strings, message bodies (`icp`, `rot`, `ixn`, `rct`), seals, signatures and receipts, pre-rotation, validation, duplicity, first-seen, superseding recovery rules A to C, and KAWA. **Primary.** Its examples are KERI 2.0.
- **C1. CESR specification**, status v1.1. https://github.com/trustoverip/tswg-cesr-specification, `spec/spec-body.md`. Read: code tables (primitives, indexed signatures, count codes), the 1.x and 2.x version string formats, and the SAID protocol with its examples. **Primary, partly read.**
- **K2. KERIpy**, https://github.com/WebOfTrust/keripy. Read:
  - `setup.py`: version 2.1.0-dev1, Python 3.14;
  - `src/keri/kering.py`: the default protocol version is 2.0;
  - `src/keri/core/serdering.py`: field definitions for KERI 1.0 and 2.0;
  - `src/keri/core/counting.py`: CESR 1.0 count codes `-A`, `-B`, `-C`, `-F`.

  PyPI `keri` releases: 1.3.6 (2026-07-31), 1.2.14 (2026-09-09), 2.1.0.dev0 (2026-09-10). **Primary for those files.**
- **K3. KERIA**, https://github.com/WebOfTrust/keria. Repository metadata only. Latest tag 0.4.1. **Summary only.**
- **K4. signify-ts**, https://github.com/WebOfTrust/signify-ts and npm `signify-ts` 0.4.1 (2026-10-12). Read: the README (signing at the edge, with validation left to KERIA), its declared dependencies, and `src/keri/core/manager.ts` (the next-key digest is over the key's qb64 text). **Primary for those.**
- **K5. keri-ts and cesr-ts** 1.0.0, https://github.com/kentbull/keri-ts. Read: the README, the release qualification record `docs/reports/parity/CLEANUP_RELEASE_2026-10-16.md`, and the npm dependency lists (including `lmdb`). Not run. **Primary for its claims.**
- **K6. @kerits/core** 0.3.4, https://github.com/aaronp/kerits (README, npm metadata). **Summary only.** Also **cesr** 0.1.2 (https://github.com/lenkan/keri-js): npm metadata only.
- **K7. DID methods**, metadata only, not read: did:webs (https://github.com/trustoverip/tswg-did-method-webs-specification) and did:webvh (https://github.com/decentralized-identity/didwebvh). **Summary only.**
- **S01, S02** in `docs/sources/`: the P2P Trust Stack's `did:scid:vh` (Layer 1), and the OpenVTC libraries' `did:key` resolution.
- **This repository:** `projects/settle/src/protocol/log.ts` and `projects/settle/docs/design.md` §9 and §18; `packages/trust-core/src/` (`identity.ts`, `credentials.ts`, `tasks.ts`, `encoding.ts`, `statusList.ts`, `clock.ts`). `@noble/hashes` 2.4.0 in the workspace ships `blake3.js` and `hkdf.js`, as checked in `node_modules`.

## Decisions made (2026-11-06)

The open questions above were settled by the assistant, at the convener's request, so the MVP can be built. Each can be revisited.

1. **The principal holds a rotation key for every agent by default** (`nt = 1`, the principal's next key alongside the agent's). That gives recovery and a kill switch.
2. **Witnesses** are run by the platform in the MVP: three local witnesses. The principal's console can also run one in the browser.
3. **KERI version.** 1.0. Moving to 2.0 is deferred.
4. **keri-ts** is revisited at its 1.1 release.
5. **KERI delegation** for agents and **Merkle batching** for capture are deferred.
