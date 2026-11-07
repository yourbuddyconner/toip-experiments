# @toip-tools/anon-membership

Anonymous membership proofs. A member proves "I am in one of these groups, my attributes meet these predicates, and this is my nullifier for this scope", bound to one signal. The proof does not say which member, or which group.

Tipline (`projects/tipline`) and Agora (`projects/agora`) use it. It runs in Node and in browsers, and it proves in a Web Worker.

The proof system is UltraHonk from Barretenberg (bb.js 6.0.0), always in its zero-knowledge mode. The circuit is Noir 1.0.0. The hash is Poseidon2 over BN254, the same in the circuit and in TypeScript.

## Install

```sh
npm install @toip-tools/anon-membership
```

## Zero knowledge: how strong the claim is

UltraHonk's zero-knowledge mode is **designed to be zero-knowledge**. We found no published proof that it is. Earlier releases had a soundness flaw in this mode, fixed before 5.0.0. Noir says it is not yet for production use. Say "designed to be zero-knowledge" in any UI or document that uses this library.

The library never makes or accepts a proof without zero knowledge. The tests check that a proof made in the no-zk mode fails verification.

## What the circuit proves

One circuit, `anon-membership/v1/gate-d20`, a Merkle tree of depth 20 (up to 1,048,576 members).

Private: the secret `s`, the group slot `g`, the leaf's fields (`validUntilDay`, `registeredDay`, `attrs[4]`), the Merkle path, and the rate-limit index `k`.

Public: `groupIds[4]`, `roots[4]`, `schemaId`, `today`, `registeredBy`, `ops[4]`, `operands[4]`, `scope`, `limit`, `signal`. Output: `nullifier`.

The circuit checks:

1. `C = H(1, s, groupIds[g])`.
2. `leaf = H(4, C, schemaId, validUntilDay, registeredDay, attrs[0..3])`.
3. The leaf is under `roots[g]`, and `roots[g] != 0`. `g` stays hidden.
4. `validUntilDay >= today` and `registeredDay <= registeredBy`, as 64-bit integers.
5. For each slot: op 0 any, 1 equal, 2 at least, 3 at most. Ops 2 and 3 compare 64-bit values, and the circuit checks both values fit in 64 bits.
6. `k < limit`, with `1 <= limit <= 65536`.
7. `scope != 0`.
8. `nullifier = H(2, s, scope, k)`.

`signal` is in no constraint. It is a public input, so it is in the proof's transcript. A test changes each of the 23 public inputs of a valid proof and checks that verification fails.

`H` is Noir's `Poseidon2::hash(inputs, n)` from `noir-lang/poseidon` v0.4.0. In TypeScript it is bb.js's `poseidon2Hash`. Tags: 1 commitment, 2 nullifier, 3 tree node `H(3, left, right)`, 4 leaf. An empty leaf is 0.

## Example

```ts
import {
  GroupIssuer, MembershipProver, MembershipVerifier, acceptMembership, NullifierBook,
  initHashing, memberSecret, enroll, membershipInputs, treeFromRoot, scopeOf, messageOf, dayOf,
} from "@toip-tools/anon-membership";

await initHashing();

// The issuer: enroll, publish one signed root per day.
const issuer = new GroupIssuer({ identity: acme, clock, name: "employees" });
issuer.serve(acmeEndpoint, (did) => roster.has(did));          // anon-membership/enroll over TSP
const { root, snapshot } = issuer.publish();

// The member: one secret per group, from the wallet's seed.
const secret = memberSecret(seed, issuer.groupId);
await enroll(memberEndpoint, acme.did, issuer.groupId, secret);

// Proving, against the newest root that holds the leaf.
const scope = scopeOf("tipline/v1", dropboxDid, storyId);
const signal = messageOf("tipline/v1", { kind: "tip", tipId, replyTo, body: bodyHash });
const tree = treeFromRoot(root, snapshot);                        // checks the snapshot against the signed root
const { statement, witness } = membershipInputs({ secret, groups: [{ group: issuer.groupId, tree }], scope, signal, today: dayOf(Date.now()) });
const prover = await MembershipProver.create();
const proof = await prover.prove(statement, witness);             // JSON-safe

// The verifier.
const verifier = await MembershipVerifier.create();
const policy = { groups: [{ group: issuer.groupId, issuer: acme.did }], vkHashes: verifier.vkHashes(), maxEpochAge: 3, minSize: 50 };
const r = await acceptMembership(proof, { policy, logs: { [issuer.groupId]: rootLog }, verifier, scope, signal, clock });
if (r.ok) book.label(issuer.groupId, scope, r.nullifier);         // "Source A", "Source B", …
```

Agora's gate passes more: up to 4 groups, `leaf` fields, `schemaId`, `registeredBy`, `predicates`, `limit` and `messageIndex`. The policy then sets `schemaId`, `predicates`, `minRegisteredDays`, `limit` and, for polls, `pinnedRoots`.

In a browser, prove in a Web Worker:

```ts
// prover.worker.ts
import { serveMembershipWorker } from "@toip-tools/anon-membership/worker";
serveMembershipWorker();

// page
const client = new MembershipWorkerClient(new Worker(new URL("./prover.worker.ts", import.meta.url), { type: "module" }));
await client.warm();
const proof = await client.prove(statement, witness, (p) => showProgress(p));
```

Serve the page with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. Without them the prover gets one thread.

## API

- **Fields:** `Field`, `FIELD_MODULUS`, `fieldToHex`, `fieldFromHex`, `toField`, `fieldFromBytes`, `fieldToBytes`, `fieldFromBytes32`.
- **Hashing:** `initHashing`, `poseidon2`, `hash`, `TAG`, `nodeHash`, `commitmentOf`, `leafHash`, `plainLeaf`, `nullifierOf`, `Leaf`, `NEVER_EXPIRES`, `MAX_LIMIT`.
- **Encodings:** `scopeOf`, `messageOf`, `groupIdOf`, `groupFieldOf`, `memberSecret`, `deriveSecret`, `encodeMembershipCode`, `decodeMembershipCode`, `dayOf`, `dayFromIso`, `isoFromDay`.
- **Tree:** `GroupTree` (`append`, `set`, `remove`, `leaf`, `indexOf`, `root`, `size`, `length`, `path`, `snapshot`, `leaves`, `fromLeaves`, `fromSnapshot`), `verifyPath`, `zeroHashes`, `DEPTH`.
- **Roots:** `GroupRoot`, `epochOf`, `epochIndex`, `rootDocHash`, `snapshotMatches`, `treeFromRoot`, `checkRootLog`, `findEquivocation`.
- **Issuer:** `GroupIssuer` (`enroll`, `revoke`, `member`, `tree`, `publish`, `log`, `snapshot`, `nextEpoch`, `serve`, `state`), `ENROLL`, `enroll`, `EnrollRequest`, `EnrollResponse`, `Enrollment`, `encodeLeaf`, `decodeLeaf`.
- **Statements:** `Statement`, `Witness`, `Predicate`, `simpleStatement`, `checkStatement`, `whyUnsatisfied`, `encodeStatement`, `decodeStatement`, `sameStatement`, `membershipInputs`.
- **Proving:** `MembershipProver` (`create`, `prove`, `destroy`), `MembershipVerifier` (`create`, `verify`, `vkHashes`, `destroy`), `MembershipProof`, `parseMembershipProof`, `MembershipError`, `PROOF_SYSTEM`, `loadArtifacts`, `CIRCUIT_ID`, `vkHashOf`, `bundledCrs`, `CrsSource`.
- **Acceptance:** `acceptMembership`, `AcceptPolicy`, `Acceptance`, `NullifierBook`.
- **Worker** (`@toip-tools/anon-membership/worker`): `serveMembershipWorker`, `MembershipWorkerClient`.

Verifiers pin `vkHash`, the SHA-256 of the verification key.

## Setup data is bundled

bb.js normally downloads its CRS (curve points) from Aztec's servers and caches it in IndexedDB. This library does not let it. It starts bb.js with `skipSrsInit` and loads the points itself from `artifacts/crs.json`: 8,192 points, 512 KB, taken from bb's CRS and checked in the tests against its first point and the known G2 point. Nothing is fetched at proving or verifying time, in Node or in a browser.

The tests check this two ways. In Node, `fetch` is replaced with one that fails, for the whole proving test file. In Chromium, a test builds a page with Vite, proves in a Web Worker, verifies on the page, and records every request the page and its workers make. All of them go to the page's own origin. After the session there is no IndexedDB database, localStorage entry or Cache Storage entry.

## Performance

Apple M1 Max, 10 cores, Node 22, bb.js 6.0.0 WebAssembly backend. Median of 10 runs. Full statement: 4 groups, 3 predicates, `limit` 10. From `npm run bench`, written to `results/bench.json`.

| | Node, 10 threads | Node, 1 thread | Chromium, 10 threads |
|---|---|---|---|
| Prover setup | 302 ms | 154 ms | 469 ms |
| Prove | 161 ms | 290 ms | 141 ms |
| Verifier setup | 312 ms | 152 ms | 213 ms |
| Verify | 12 ms | 13 ms | 14 ms |

- Circuit: 5,047 gates (`bb gates`).
- Proof: 14,656 bytes.
- Building a 5,000-member tree from a snapshot: about 0.2 s.

Phones are not measured.

## Files

- `circuits/lib`: the Noir library (the statement, hashes, tests, hash vectors). `circuits/gate_d20`: the depth-20 circuit.
- `artifacts/`: the compiled circuit, its verification key and gate count, and the CRS points. Committed, so nothing needs nargo.
- `npm run build:circuits` rebuilds them with `nargo` 1.0.0 and `bb` 6.0.0.
- `npm run vectors` rewrites `tests/vectors.json` and `circuits/lib/src/vectors.nr`. Vitest checks the vectors against bb.js, and `nargo test` checks the same vectors in Noir. The vitest suite also runs `nargo test` when nargo is installed.

## Differences from the designs

The two designs are tipline's §6 and §13.1 and agora's §5.1 and §14.1 to §14.2. Where they differed, the library takes the more general form.

**One circuit for both.**
- The circuit is agora's gate statement, named `anon-membership/v1/gate-d20` (tipline: `anon-membership/v1/d20`, a smaller statement). Tipline uses it with one group, a plain leaf and `limit` 1.
- The commitment is `H(1, s, groupId)`, per group, as agora asks (tipline: `H(1, s)`). Tipline already derives one secret per group, so nothing is lost.
- The tree holds leaf hashes, `H(4, C, schemaId, validUntilDay, registeredDay, attrs)`, not bare commitments. Tipline uses `plainLeaf`: schema 0, never expires, registered on day 0, no attributes. A source can still find its own leaf from the secret alone.
- The nullifier is `H(2, s, scope, k)` (tipline: `H(2, s, scope)`). Tipline uses `k = 0`.
- Domain tags keep tipline's values (1 commitment, 2 nullifier, 3 node) and add 4 for leaves. Agora's tags (1 ID, 2 leaf, 3 nullifier, 4 scope) are not used.
- Agora's scope `H(T_SCOPE, f(label), f(parts))` is replaced by tipline's `scopeOf(app, ...parts)`, a SHA-256 over JCS. Scopes are public, so they don't need the circuit's hash. Parts may be strings, numbers or fields.
- `deriveSecret` is HMAC-SHA256, not agora's HKDF-SHA256. `memberSecret` is tipline's construction on top of it.

**Words.** Tipline's "message" is called `signal` everywhere: in the statement, in `acceptMembership`'s context, and in the refusal reason. `messageOf` keeps its name.

**Proofs and verification.**
- A `MembershipProof` carries its whole statement, so it is JSON-safe as made. It has no `group`, `epoch` or `rootDoc` fields (tipline §8.3). `acceptMembership` finds each root in the verified log by value and returns the root documents. There is nothing for the sender to misstate.
- `MembershipVerifier.verify` returns agora's `VerifyResult` (with reasons `malformed`, `unknownCircuit`, `statementMismatch`, `proofInvalid`), not a boolean. It takes an optional expected statement.
- `MembershipProver.prove(statement, witness, onProgress)` replaces tipline's `prove({ secret, tree, root, scope, message })`. `membershipInputs` builds the statement and witness from trees. It is also how a member finds their leaf.
- Agora's `createProver` and `createVerifier` are `MembershipProver.create` and `MembershipVerifier.create`. `create` is the warm-up; the worker client has `warm()`. Agora's `encodeProof`/`decodeProof` are `parseMembershipProof`, `encodeStatement` and `decodeStatement`.
- The circuit id is a name plus `vkHash`, not one hash of the circuit and key. The key fixes the circuit.

**Acceptance.**
- `AcceptPolicy` takes `groups` (1 to 4, in slot order) instead of one `group` and `issuer`.
- `minSize` applies to the sum of the groups' sizes, which is the anonymity set.
- A root's age counts from the newest root document carrying it. The head's root is always fresh. With daily roots this is tipline's rule. It also lets a registrar publish only when something changed, as agora's do.
- `today` may be the verifier's day or the day before, as agora says.
- Added reasons: `malformed`, `log` (a log that fails `checkRootLog` for a reason other than equivocation, or is missing), and `statement` (`today`, `schemaId`, predicates, `registeredBy` or `limit` differ from the policy). Pinned roots that don't match give `unknownRoot`.

**Roots and the issuer.**
- A root document also has `groupId` (the circuit's field) and `period`. Epochs are periods: a UTC day by default, or any number of seconds for agora's cadence. One root per epoch, as tipline says.
- Agora's `added`, `removed`, `counts` and `leavesHash` are not fields. `publish(ext)` signs any such fields under `ext`.
- The root log is this package's `checkRootLog`. Trail's event-log library is not in this branch.
- `EnrollRequest` may carry a `credential`. `admit()` may return leaf fields, which is how an issuer puts attributes in the leaf. `EnrollResponse` also returns the `leaf`, so the member can check it.
- `admit()` may also return a trust-core `Refusal`, to refuse with its own code (Agora's `alreadyMember`). `EnrollRequest` may set `replace: true`, and `enroll(…, { replace: true })` sends it: the member asks to swap the leaf they have for a new commitment. `admit()` decides, for example by counting rotations.
- `GroupIssuer` keeps the last 30 snapshots by default.
- Agora's registrar package (`anon-groups`: credential checks, rotation limits, status-list polling) is not built here. `GroupIssuer` and `admit()` are what it would build on.

**Tree.** `GroupTree` takes any depth from 1 to 32, for tests; only depth 20 has a circuit. It adds `set`, `leaf` and `leaves`. `fromLeaves(leaves, depth)` takes its arguments in that order (agora: `depth, leaves`). `size()` is a method.

**Setup data.** `CrsSource` is `{ kind: "bundled" }` (the default) or `{ kind: "bytes", crs }`. Tipline's `baseUrl` and `directory` forms are gone: the points ship inside the package, and bb.js 6.0.0 takes them directly. There is no request rerouting. The bundle is 8,192 points (tipline guessed 2^15), and no Grumpkin points are needed. In Node the library uses bb.js's WebAssembly backend, not the native `bb` binary, because the native binary downloads its own CRS.

## Not done

- Depths 16 and 24.
- Phone measurements.
- Syncing a tree near 2^20 members without the whole snapshot.
