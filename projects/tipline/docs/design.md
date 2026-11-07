# Tipline: design

A drop box for whistleblowers. A source proves to a journalist "I am a current member of organization X" without saying which member. The journalist checks the proof, receives the tip, and can reply. The source uses a fresh, unlinkable DID for each tip. Date: 2026-11-06. Status: design written, not built.

Choices marked **(our call)** are the assistant's and open to change. A guess is labeled a guess. Claims about other people's software cite section 17.

## 1. What Tipline is, and why

A journalist who gets a leak wants to know two things before anything else: is this person really an insider, and is it one insider or several? Today the journalist finds out by learning who the source is. That knowledge is what an employer, a court or an attacker later tries to take.

Tipline changes the order. The source proves membership first and never reveals identity:

1. **The organization issues membership in a form that supports anonymous proofs.** Each member holds a secret. The organization publishes, once a day, a signed Merkle root over all members' commitments.
2. **The source proves "my commitment is under today's root"** with a zero-knowledge proof, in the browser. The proof also gives a **nullifier**: a number that is the same every time this member sends a tip on this story, and unrelated to any number they make for any other story or drop box.
3. **The journalist verifies the proof** and sees "Source A, a current member of Acme's employee group (4,812 members) as of 2026-11-06". A second tip from the same member on the same story shows up as Source A again. A different member shows up as Source B.
4. **They talk over TSP.** The tip, the files and the replies are Trust Task documents sealed between the journalist's drop box DID and the source's fresh DID, through the repository's relay.

The same proof, "a current member of this group, once per scope", is what `projects/agora` needs for credential-gated forums. Section 13 proposes it as a shared library, `packages/anon-membership`, with the proof system decided here (section 6).

## 2. Who uses it

| Who | What they do |
|---|---|
| **Source** | A member of the organization. Enrolls once in the membership group with their own wallet. Later, from a private browser window, sends a tip and comes back for replies with a tip code. |
| **Journalist** | Runs a drop box inbox on their own device. Publishes a signed drop box descriptor. Reads tips, counts distinct sources, replies. |
| **Organization (issuer)** | Keeps the membership group: enrolls members, removes leavers, signs one root a day. In the threat model it is also the adversary. |
| **Outlet's website** | Serves the source app, the drop box descriptor, and a mirror of the organization's root log. Untrusted for anonymity (section 4). |
| **Relay operator** | Runs `packages/relay`. Sees sealed messages and who sends to whom. May be the organization. |

The organization's motive to run a group is real but not certain: internal anonymous surveys, ethics hotlines and union ballots need the same group, and agora shows a licensing body running one. Section 16 asks whether employers would.

## 3. Goals, non-goals, anti-goals

**Goals**

1. A source proves current membership of a named group, and nothing else about who they are.
2. One member counts as one source per story. The journalist can count distinct insiders.
3. A member's nullifiers on different stories or drop boxes can't be linked to each other.
4. A member who has left can't prove membership once the organization has published a root without them and the journalist's window has passed.
5. Two-way conversation with an anonymous source, who can return days later with a code and nothing stored on their device.
6. The organization learns nothing from the protocol about who tipped, even if it runs the relay and the outlet's web host.
7. Reuse the trust core: did:key identities, TSP through `Endpoint`, Trust Task documents, `signDocument`/`verifyDocument`, the relay.
8. A proof that a browser makes in a few seconds and verifies in milliseconds.

**Non-goals (for now)**

- Network anonymity. The MVP does not ship Tor or a mixnet. It tells the source to use Tor Browser and shows what the relay sees.
- Newsroom inboxes shared by several journalists.
- Cleaning PDFs and office documents. The MVP cleans images and warns about other files.
- Proving membership with a credential the organization already issues for other purposes, without its cooperation (section 6.9, phase 2).
- Paying sources (section 14).
- Phones as provers, beyond measuring them.

**Anti-goals**

- **The organization can identify the source from protocol data.** If any message, log, root or proof lets it, the design has failed.
- **Anything stored on the source's device.** No account, no passkey, no cookie, no IndexedDB entry, no service worker after the session.
- **The organization's software holds the member secret.** The secret is made and kept by the member's own wallet.
- **Trusting a root because the drop box says so.** Roots are trusted because the organization signed them, in one public log, one per day.
- **Calling a proof zero-knowledge where it is only succinct.** The no-zk mode is never used.

## 4. Threat model

### 4.1 Adversaries

| Who | Can | Can't (by design) |
|---|---|---|
| **The organization** | Knows which employee owns which commitment. Adds and removes members, including fake ones. Signs roots. Runs the relay. Watches its own networks and managed devices. Pressures or coerces employees. Colludes with the outlet's web host. Sends fake tips as a member. | Compute a member's nullifier without their secret. Tell from a proof which leaf it used. Read TSP messages. |
| **The outlet's web host and mirror** | Serves the source app's code, the descriptor and the root-log mirror. Sees who loads them (IP, time). Could serve a tampered snapshot or app. | Forge the organization's signature on a root. Forge the journalist's signature on the descriptor. |
| **The relay operator** | Sees the tip DID, the drop box DID, sizes, times and the source's IP. Drops, delays or reorders messages. Fills the drop box's queue. | Read or change sealed content. |
| **Network observers** (ISP, corporate proxy) | See that a device talks to the relay or the outlet. | Read content (TLS, TSP). |
| **Non-members** | Send messages to the drop box. | Make a valid proof. |
| **Members** | Send many tips. | Appear as more than one source on one story, within one group. |

### 4.2 Trusted

- The journalist, and the device running the inbox.
- The source's own device and browser, at the time of use. A device the organization manages is not trusted, and the source app says so.
- The cryptography: SHA-256, Poseidon2 as a pseudorandom function, Ed25519, and UltraHonk's soundness and zero-knowledge (section 6.7 says how strong that last one is).
- The source app's code as served. This is the weakest assumption. Mitigations: a static bundle whose hash the outlet publishes, and an option to download and open it locally (section 9).

### 4.3 Out of scope

- A compromised source device.
- A global observer correlating traffic. Tor helps; the MVP doesn't solve it.
- Identification from the content: a document only three people saw names a three-person set, whatever the proof says.
- Coercion. An employer that forces each member to compute their nullifier for a story, and gets the nullifiers from a colluding journalist, finds the source. Nothing in the MVP stops this (section 16).
- The journalist betraying the source. The journalist can't reveal a name they never learn.

### 4.4 What each party learns

| | Learns | Does not learn |
|---|---|---|
| Organization | Roster ↔ commitments. That some DID sent N padded bytes to the drop box at time T, if it runs the relay. | Which member, the nullifier, the scope, the content. |
| Journalist | Group, root epoch, group size, nullifier for this story, tip DID, content, coarse time (to the hour). | The member's identity, commitment or leaf index. Their nullifiers elsewhere. |
| Outlet host | IP and time of whoever loads the source app or the mirror. | Anything sealed. |
| Relay | Tip DID, drop box DID, sizes (bucketed), times, IP. | Content, nullifier, group. |

## 5. Architecture

### 5.1 Parties and components

```
 Member's wallet ── enroll (TSP) ──► Acme issuer ── signed root + snapshot (HTTP, daily) ──► public
                                         │                                                    │
                                         ▼                                                    ▼
                                    root log (public)                           outlet mirror (verifies, re-serves)
                                                                                              │
 Source app (private window, nothing stored) ◄── descriptor, mirror, app bundle ──────────────┘
      │  proves in the browser (Noir + bb.js)
      ▼
   relay (maybe Acme's) ◄────── TSP, sealed ──────► Journalist's inbox (verifies, labels sources, replies)
```

| Component | Runs where | Holds |
|---|---|---|
| **Member wallet** | The member's own device (a web page in the MVP). Not Tipline-branded: any employee has one. | The member's long-term DID (employee identity) and a wallet seed, sealed with a passkey as in Settle's `web/src/vault.ts`. Shows the membership code. |
| **Issuer service** | The organization's server. | Roster (employee DID → leaf index), the group tree, its signing identity, the root log. Serves `log.json` and daily snapshots over HTTP. Handles `anon-membership/enroll` over TSP. |
| **Source app** | A private browser window, ideally Tor Browser. Static bundle from the outlet. | Nothing persistent. Membership code and tip code are typed in and kept in memory only. |
| **Inbox** | The journalist's device (a web page in the MVP). | Drop box identity, tips, threads, the nullifier book, the root logs it fetched. Sealed with a passkey. |
| **Outlet site** | The outlet's web host. | The signed descriptor, the source app bundle, the mirrored root log and snapshots. |
| **Relay** | `packages/relay`, unchanged. | Sealed messages until collected. |

The drop box DID is the inbox's own did:key. There is no server that holds tips in the clear.

### 5.2 MVP process layout

One command, `npm run tipline`, starts everything on one machine, as `npm run settle` does:

- the relay, labeled in the demo as **operated by Acme**;
- the Acme issuer service, with an HR console (`/acme`) for the roster and revocations;
- the outlet site: `/tip/:dropbox` (source app), `/dropbox/:id/descriptor.json`, `/dropbox/:id/mirror/...`;
- the inbox (`/inbox`) and the member wallet (`/wallet`);
- a dev clock with **Skip ahead**, for epochs and windows.

Code layout:

| Path | What |
|---|---|
| `packages/anon-membership/circuits/` | The Noir library and the depth-20 binary circuit, with compiled `circuit.json` and `vk` committed, as Settle commits `program/dist/`. |
| `packages/anon-membership/src/` | Fields and hashing, the tree, root documents and the log check, prover, verifier, acceptance, nullifier book, the enroll Trust Task, CRS loading. |
| `projects/tipline/src/protocol/` | Descriptor, tip and message payloads, message binding, chunking and padding, tip codes. |
| `projects/tipline/src/agents/` | `issuer.ts` (Acme), `inbox.ts`, `source.ts`, `mirror.ts`. |
| `projects/tipline/src/sanitize/` | Image metadata removal (browser). |
| `projects/tipline/src/platform/` | The one-process platform and its HTTP routes. |
| `projects/tipline/web/` | Wallet, source app, inbox, HR console. `web/e2e.ts` drives them in a real browser. |
| `projects/tipline/src/demo.ts` | The narrated terminal demo. |

## 6. The anonymous membership construction

### 6.1 Decision

**A Semaphore-style group in Noir, proved with Barretenberg's UltraHonk in its zero-knowledge mode (our call).** Each member's commitment is a leaf in a fixed-depth Poseidon2 Merkle tree. The organization signs the root outside the circuit with its Ed25519 did:key. The circuit proves knowledge of a secret whose commitment is a leaf under a public root, and outputs `nullifier = Poseidon2(secret, scope)`. This follows Semaphore v4's design (S5) with our own hashing and circuit.

### 6.2 Options weighed

| | **Group of commitments (chosen)** | **Issuer's Ed25519 signature in the circuit** | **BBS signatures with pseudonyms** |
|---|---|---|---|
| What the issuer does | Runs the group, signs a root daily | Nothing new: its ordinary credentials and status list | Issues BBS credentials, blind-signing each member's pseudonym secret |
| Can the source see the anonymity set? | Yes: the snapshot lists every leaf | No: the issuer's count of holders is unknown | No |
| Revocation | The next root drops the leaf | Prove the status bit at a private index is 0 against the public list | Short-lived credentials reissued each epoch, or an accumulator |
| Member ↔ issuer traffic after enrolling | None | None | Each epoch, if reissued; the issuer sees who checks in |
| Circuit | About 22 Poseidon2 permutations. Semaphore Noir at depth 20 measured 25,617 gates with an EdDSA key inside (S6); ours has none, so fewer (guess) | Over 1M gates (guess): the Ed25519 check alone is 436,722 (zk-pdp E13), plus proving ownership of the holder's key, SHA-256 over the JCS credential, and parsing it | No circuit |
| Browser proving | About 1 to 2 s at depth 7 to 11 on an older bb.js (S6) | Likely over 10 s and over 2 GB (guess from E13's 2.0 GB native) | Milliseconds |
| Proof size | About 14.7 KB in ZK mode (E13) | The same | Under 1 KB (guess) |
| Maturity | Our circuit, about 40 lines, on Noir 1.0.0 and bb 6.0.0 | Our unaudited Ed25519 verifier | IRTF drafts; pseudonyms at draft 03 (S8); one JavaScript library implements them (S9) |
| Extends to Cedar policies later (zk-pdp) | Yes, same toolchain | Yes | No |

Why the group wins:
- **The anonymity set is visible.** The source counts the leaves before proving. With BBS or in-circuit signatures, an issuer could have issued to three people and the source would not know.
- **No periodic contact with the adversary.** After enrolling, the member never talks to the issuer again. Fetching a public snapshot can go through the outlet's mirror and Tor.
- **Revocation is cheap and public.** A removed member's leaf becomes 0 in the next root.
- **Proving is fast enough** on a browser today, and the circuit is short enough to read in full.
- **One toolchain** with zk-pdp, so a later step can add a Cedar predicate to the same proof.

What it costs: the organization must run the group. Section 6.9 keeps the in-circuit signature as phase 2 for when it won't.

Semaphore's own JavaScript packages are not used. Their tree hashes with Poseidon over BN254 as circomlib does, not the Poseidon2 that Barretenberg computes natively, and their proof package is built on circom and Groth16. Hashcloak's Semaphore Noir packages pin bb.js 0.82.2 and Noir 1.0.0-beta.3, older than zk-pdp's pins, and pull in the same circom proof package (checked with `npm view`, 2026-11-06).

### 6.3 Fields, hashing and encodings

- **Field:** BN254's scalar field Fr, the native field of Noir on Barretenberg. Encoded as `0x` plus 64 lowercase hex digits, big-endian. Values at or above the modulus are refused.
- **H:** Poseidon2 as `Poseidon2::hash(inputs, n)` in `noir-lang/poseidon` v0.4.0: a sponge of rate 3 over Barretenberg's Poseidon2 permutation, with initial value `n · 2^64`. In TypeScript, bb.js's `poseidon2Hash`. That the two agree is checked by test vectors (section 12), not assumed.
- **toField(bytes):** the first 31 bytes of a 32-byte digest, read big-endian. 248 bits, always below the modulus.
- **JCS:** RFC 8785 canonical JSON, through trust-core's `canonicalJson`.

Domain tags are field constants:

| Tag | Value | Used in |
|---|---|---|
| `COMMIT` | 1 | `commitment = H([1, secret])` |
| `NULLIFIER` | 2 | `nullifier = H([2, secret, scope])` |
| `NODE` | 3 | `node = H([3, left, right])` |

All three fit in one permutation, so the tags cost nothing.

### 6.4 Member secret, commitment, scope and message

- **Wallet seed:** 32 random bytes, kept by the member's wallet.
- **Group id:** `<issuer DID>#<name>`, for example `did:key:z6Mk…#employees`.
- **Secret:** `secret = toField(HMAC-SHA256(seed, JCS(["anon-membership/v1/secret", groupId])))`. One secret per group, so the same person's commitments in two groups differ and two issuers can't match them.
- **Commitment:** `H([1, secret])`. The wallet sends only this to the issuer.
- **Membership code:** what the member copies into the source app. Crockford base32 of `secret` (31 bytes) followed by the first 2 bytes of `SHA-256(groupId || secret)`, in groups of 4 characters. The checksum catches typos and a code for the wrong group.
- **Scope:** `toField(SHA-256(JCS(["anon-membership/v1/scope", app, ...parts])))`. Tipline uses `app = "tipline/v1"` and `parts = [dropboxDid, storyId]`. Agora would use its forum id.
- **Message:** `toField(SHA-256(JCS(["anon-membership/v1/message", app, value])))`, where `value` is a JSON object. It binds the proof to one use (section 7.3).

### 6.5 The circuit

`packages/anon-membership/circuits/membership_d20`. Depth `D = 20`, so up to 1,048,576 leaves. Other depths are separate compiled circuits sharing one Noir library (agora may need 24). The MVP builds 20 only.

Inputs:

| Name | Visibility | Meaning |
|---|---|---|
| `secret` | private | The member secret |
| `index` | private | The leaf index, below 2^D |
| `siblings[D]` | private | The Merkle path, leaf level first |
| `root` | public | The group root the proof is against |
| `scope` | public | The nullifier scope |
| `message` | public | The binding to this use |
| returns `nullifier` | public | `H([2, secret, scope])` |

Statement, in Noir-like pseudocode:

```
fn main(secret: Field, index: Field, siblings: [Field; D],
        root: pub Field, scope: pub Field, message: pub Field) -> pub Field {
    let leaf = H([COMMIT, secret]);
    let bits: [u1; D] = index.to_le_bits();          // also constrains index < 2^D
    let mut node = leaf;
    for i in 0..D {
        let (l, r) = if bits[i] == 1 { (siblings[i], node) } else { (node, siblings[i]) };
        node = H([NODE, l, r]);
    }
    assert(node == root);
    assert(scope != 0);
    H([NULLIFIER, secret, scope])
}
```

Notes:
- Public inputs, in order: `root`, `scope`, `message`, then the returned `nullifier`. The verifier never takes them from the sender: it computes `scope` and `message` itself and looks `root` up in the log.
- `message` is not used in a constraint. UltraHonk puts public inputs into its transcript, so a proof made with one `message` should not verify with another. Semaphore adds a dummy square for circom's sake (S5). Rather than rely on either, a test changes each public input of a valid proof and requires failure (section 12).
- An empty leaf is 0. Proving under it needs a secret with `H([1, s]) = 0`, which is a preimage of 0. Removed leaves are also set to 0.
- The tree has a fixed depth, so a node can't pass for a leaf.

Toolchain: `nargo` 1.0.0 to compile, `noir-lang/poseidon` v0.4.0 for `Poseidon2::hash`, `bb` 6.0.0 to write the verification key at build time. The circuit id is `anon-membership/v1/d20`, and `vkHash = SHA-256(vk)` in hex. Verifiers pin `vkHash`.

### 6.6 The tree, snapshots and root documents

**The tree.** Fixed depth 20, sparse. Zero values: `Z[0] = 0`, `Z[i+1] = H([3, Z[i], Z[i]])`. Leaves are appended in enrollment order and indices are never reused. Removing a member sets their leaf to 0. Re-enrolling (a lost secret) zeroes the old leaf and appends a new one.

**The snapshot** is the full leaf list, indices 0 to `length - 1`, as 32-byte big-endian values concatenated. 5,000 members make 160 KB. The source downloads the whole snapshot and finds its own leaf, so no request ever names an index.

**The root document** is signed with trust-core's `signDocument` (eddsa-jcs-2022), like the status list:

```
{
  id: "urn:uuid:…",
  type: "anon-membership/root",
  v: 1,
  issuer: <issuer did:key>,
  group: "<issuer DID>#employees",
  circuit: "anon-membership/v1/d20",
  epoch: "2026-11-06",          // UTC day
  seq: 41,                      // 0 for the first root of this group
  prev: "<hex SHA-256 of JCS of the previous signed root document>" | null,
  root: "0x…",
  length: 5003,                 // next leaf index
  size: 4812,                   // non-zero leaves
  snapshotHash: "<hex SHA-256 of the snapshot bytes>",
  issuedAt: "2026-11-06T00:00:05Z",
  proof: { … }
}
```

**The root log** is the list of root documents for a group, oldest first. Rules (our call):
- **One root per epoch.** The issuer publishes exactly one root each UTC day, even if nothing changed, so a stale root shows the issuer stopped.
- **A chain.** `seq` rises by one and `prev` hashes the previous document.
- **Equivocation is evidence.** Two validly signed root documents for the same group with the same `epoch` or `seq` and different contents prove the issuer misbehaved. Whoever sees them refuses the group from that epoch on and shows both documents.

The log is a small signed, hash-chained event log. If `projects/trail`'s shared event-log library exists when this is built, the root log uses it; otherwise `anon-membership` has a minimal `checkRootLog` and moves to trail's later (section 13).

**Publication.** The issuer serves `GET /groups/<name>/log.json` and `GET /groups/<name>/snapshot/<epoch>.bin`. The outlet's mirror fetches both every hour, checks signatures, the chain and `snapshotHash`, and re-serves them. The inbox fetches from the issuer directly too.

### 6.7 Zero knowledge: what holds and how it is switched on

- bb.js's `UltraHonkBackend.generateProof` takes a `verifierTarget`. `noir-recursive`, `evm` and `noir-rollup` are zero-knowledge. Their `-no-zk` variants are sound but "the witness (private inputs) may be recoverable from the proof" (S2).
- **The library always uses `verifierTarget: "noir-recursive"` (our call),** for proving and for verifying, and does not expose the option. A proof made with `noir-recursive-no-zk` fails to verify under it (tested). `noir-recursive` hashes its transcript with Poseidon2 and leaves room for recursive batching later.
- **How strong the claim is.** UltraHonk's ZK mode is designed to hide the witness. zk-pdp's literature review found no published proof of that property (S11). The ZK flavor had a critical soundness flaw in every release before 5.0.0, which permitted forged ZK proofs (S11). Aztec also reported an undisclosed proving-system flaw on 2026-08-07 (S11). bb.js 6.0.0 was published on 2026-10-22, after both (`npm view`, 2026-11-06). Noir's own security page says it is "not recommended for use in production" (S3). The docs and the UI say "designed to be zero-knowledge", not "zero-knowledge".
- **Pins.** `@aztec/bb.js` resolved to `@aztec-foundation/bb.js@6.0.0`, as zk-pdp's `bench/web` does. `@noir-lang/noir_js` 1.0.0. The `@aztec/bb.js` name's own latest is 5.3.0, a different line.

### 6.8 Nullifiers, scopes and revocation

**Scopes.** Tipline's scope is per drop box and per story: `scope = scopeOf("tipline/v1", dropboxDid, storyId)`. So:
- one member makes one nullifier per story, and the inbox labels it Source A, B, C in order of first appearance;
- the same member on another story, or at another journalist's drop box, makes an unrelated nullifier. Linking them needs the secret, assuming Poseidon2 is a pseudorandom function;
- distinct nullifiers on a story count distinct members of that group. A person in two accepted groups counts once per group, and the inbox counts per group.

**What counting can't tell.** The organization can enroll fake members and send tips as them. "Three distinct members" includes any the organization controls. The inbox says this next to the count.

**Revocation and freshness.** The journalist's acceptance policy (per group, in the descriptor) has:
- `maxEpochAge`: the oldest root epoch accepted, in days before today. Default 3 (our call). A leaver can still prove against an older root for up to that long after the first root without them.
- `minSize`: the smallest group accepted. Default 50 (our call). The source app refuses below this, before the journalist would.

The source app proves against the newest root in the log that contains its leaf. The inbox shows the epoch: "a member as of 2026-11-06". If the journalist wants to know the source is still a member later, `tipline/proof/request` asks for a new proof with the same scope against a newer root. It gives the same nullifier, so it is visibly the same source.

### 6.9 Phase 2: membership from a credential the organization already issues

If an organization won't run a group, a source could prove "I hold a credential this issuer signed, and its status bit is 0" in the circuit. The status list is public, so the circuit can take the whole bitstring as a public input and check the bit at a private index. The cost is the problem: the Ed25519 check, proving ownership of the holder's key (needed so the nullifier comes from a secret only the holder knows), and SHA-256 over the canonical credential. That is over a million gates by our guess.

A cheaper shape: prove that once, to register a commitment with a group run by someone else (a union, a press-freedom group), with a registration nullifier so each credential registers once. Later tips are ordinary group proofs. Deferred: it depends on zk-pdp's Ed25519 work getting cheaper, and on a W3C credential parser in Noir.

### 6.10 Performance and the CRS

- **Budget (our call, to measure):** proving at most 3 s in desktop Chrome and 10 s on a mid-range phone, after setup; verification at most 100 ms after setup. Semaphore Noir reports 1.3 to 1.8 s in a browser at depths 7 to 11 on bb.js 0.82.2 (S6). The MVP records real numbers in `results/` from the e2e run.
- **bb.js fetches its CRS from the network.** In browsers, bb.js 6.0.0's `Barretenberg.new` downloads curve points from `https://crs.aztec-cdn.foundation` (fallback `https://crs.aztec-labs.com`) and caches them in IndexedDB under the keys `g1Data` and `g2Data`. It also loads a Grumpkin CRS of 2^16 points (read in bb.js's `dest/browser/crs/`, S10). For a source this is a request to a third party at the moment of proving, and a stored artifact.
- **So the source app bundles the CRS (our call).** It serves the points from its own origin, sized from the measured circuit (about 2^15 points, guess). Before calling `Barretenberg.new` it routes requests for those two hosts to the bundled bytes, and after the session it deletes bb.js's IndexedDB database. An e2e test asserts no request leaves the allowlist and no storage remains (section 12). If a later bb.js lets a browser pass the CRS directly, use that instead.
- **Threads.** The outlet serves the source app with COOP and COEP headers, so the page is cross-origin isolated and bb.js can use threads, as zk-pdp's `bench/web` does.

## 7. The protocol as Trust Tasks

All tasks use `ourSpec(name)`, so type URIs are `https://zk-toip.example/spec/<name>/0.1`, signed and sealed by `Endpoint`. All are one-way (`notify`) except enrollment, as in Settle, because the inbox is often offline and the source app may close.

### 7.1 Message types

| Task | From → to | Carries |
|---|---|---|
| `anon-membership/enroll` | member's employee DID → issuer | `{ group, commitment }`. Request and response. |
| `anon-membership/enroll#response` | issuer → member | `{ group, index, firstEpoch }`. The wallet later checks its leaf is at `index` in that epoch's snapshot. |
| `tipline/tip/submit` | tip DID → drop box | The tip: story, body, attachment manifest, membership proof (7.2). |
| `tipline/tip/chunk` | tip DID → drop box | One piece of one attachment. |
| `tipline/tip/receipt` | drop box → tip DID | `{ tipId, status: "verified" \| "rejected", reason?, missing?: [{attachment, index}] }` |
| `tipline/message` | either way | `{ tipId, seq, text, attachments? }`. Replies and follow-ups. |
| `tipline/thread/request` | tip DID → drop box | `{ tipId, since }`. Asks the inbox to resend messages, for a source who comes back with nothing stored. |
| `tipline/proof/request` | drop box → tip DID | `{ tipId, challenge }`. Asks for a fresh proof against a newer root. |
| `tipline/proof/present` | tip DID → drop box | `{ tipId, challenge, membership }` |

The drop box descriptor (8.1) is a signed document, not a task.

### 7.2 `tipline/tip/submit` payload

```
{
  v: 1,
  tipId: "urn:tipline:<32 hex>",       // from the tip code (8.4)
  story: "acme-valve-failures",
  body: { subject: "…", text: "…" },
  attachments: [
    { id: "a1", name: "attachment-1.jpg", mediaType: "image/jpeg",
      bytes: 412331, sha256: "<hex>", chunks: 3, cleaned: "reencoded" | "none" }
  ],
  padding: "<b64u random>",            // brings the sealed message to its size bucket (section 9)
  membership: <MembershipProof>        // section 8.3
}
```

The document's `issuer` is the tip DID, its `recipient` the drop box DID, and its Data Integrity proof is by the tip DID.

### 7.3 Message binding

The proof's `message` is:

```
messageOf("tipline/v1", {
  kind: "tip",
  dropbox: <drop box DID>, story, tipId,
  replyTo: <tip DID, which must equal the document's issuer and the TSP sender>,
  body: <hex SHA-256 of JCS(body)>,
  attachments: [ { id, sha256, bytes } … ]
})
```

For `tipline/proof/present`, `kind: "present"` with `{ dropbox, story, tipId, replyTo, challenge }`.

So a relay or anyone else who copies a proof can't attach it to another DID, another body or other files. The inbox recomputes `message` from what arrived and refuses a mismatch.

### 7.4 Sequence: a tip and a reply

1. **Enrollment (once, long before).** The member's wallet derives `secret` for the group and sends `anon-membership/enroll` from the employee DID. The issuer checks the DID is on its roster, appends the commitment, and answers with the index. The next daily root includes it. The wallet later checks that its own leaf is in the snapshot and that it made the secret itself.
2. **The journalist opens a story.** The inbox adds a story to its descriptor, signs it, and uploads it to the outlet site.
3. **The source opens the source app** at `/tip/<dropbox>` in a private window. The app:
   1. fetches and verifies the descriptor;
   2. fetches the group's root log and the newest snapshot from the mirror, and, if the source agrees, from the issuer's URL too, and requires both to match;
   3. checks the log (signatures, chain, one root per epoch), the snapshot against `snapshotHash`, and the size against `minSize`;
   4. takes the membership code, finds the leaf in the snapshot, and shows "you are 1 of 4,812".
4. **The source writes the tip** and adds files. Images are re-encoded to drop metadata (section 9).
5. **The app makes a tip code** (8.4), derives the tip DID and `tipId`, and shows the code to write down.
6. **It proves** in the browser: `scope` for this story, `message` as in 7.3, against the newest root with the leaf.
7. **It sends** over the relay as the tip DID: one `tipline/tip/submit`, then the chunks, all padded to fixed sizes. Optionally it waits a random 1 to 12 hours first, with the tab open.
8. **The inbox** collects from the relay when the journalist opens it. It verifies the submit (section 7.5), labels the source by nullifier, collects the chunks, checks each attachment's SHA-256, and sends `tipline/tip/receipt`.
9. **The journalist replies** with `tipline/message`. It waits on the relay, up to the relay's 30-day limit.
10. **The source returns** days later in a new private window, types the tip code, and the app derives the same tip DID, connects to the relay, collects the receipt and replies, and can answer. `tipline/thread/request` gets older messages resent.
11. **A follow-up** from the same tip DID needs no new proof: TSP and the document proof show it is the same sender.

### 7.5 What the inbox checks on a submit

In order. The first failure decides the `reason` in the receipt.

1. TSP unsealing and the document proof by the sender, as `Endpoint` does. The document's `issuer` equals the TSP sender.
2. `story` is open in the descriptor, and the group named in the proof is accepted for it.
3. The proof's `circuit` and `vkHash` are pinned.
4. The root: the root document named by the proof is in the inbox's verified log for the group, signed by the pinned issuer DID, with no equivocation known, `epoch` within `maxEpochAge`, and `size` at least `minSize`.
5. `scope` equals `scopeOf("tipline/v1", dropbox, story)`, and `message` equals the value recomputed from the document (7.3).
6. The UltraHonk proof verifies, in ZK mode, with public inputs `[root, scope, message, nullifier]`.
7. The nullifier book labels the source: a new label if the nullifier is new for this scope, else the existing one.

Chunks for a `tipId` the inbox hasn't accepted are held for one hour, then dropped.

## 8. Data formats

### 8.1 Drop box descriptor

Signed by the drop box DID with `signDocument`. Served at `/dropbox/<id>/descriptor.json`.

```
{
  id: "urn:uuid:…",
  type: "tipline/dropbox",
  v: 1,
  issuer: <drop box DID>,
  outlet: "The Ledger",
  journalist: { name: "Sam Ortiz" },
  relay: "wss://relay.example/v1",
  appBundle: { url: "/tip/app-1.0.0.js", sha256: "<hex>" },
  circuits: [ { id: "anon-membership/v1/d20", vkHash: "<hex>" } ],
  stories: [
    { id: "acme-valve-failures", title: "Valve failures at Acme's Riverside plant",
      opens: "2026-11-06", closes: "2027-02-01",
      groups: [ { group: "<Acme DID>#employees", issuer: "<Acme DID>",
                  log: "https://acme.example/groups/employees/log.json",
                  mirror: "/dropbox/<id>/mirror/acme-employees/",
                  minSize: 50, maxEpochAge: 3 } ] }
  ],
  limits: { maxAttachments: 8, maxAttachmentBytes: 16777216 },
  issuedAt, proof
}
```

The issuer DID is pinned by the journalist out of band, for example from the organization's own website. The trust core resolves did:key only.

### 8.2 Snapshot and root document

See 6.6.

### 8.3 Membership proof

```
{
  v: 1,
  system: "ultrahonk-zk/noir-recursive",
  circuit: "anon-membership/v1/d20",
  vkHash: "<hex>",
  group: "<issuer DID>#employees",
  epoch: "2026-11-06",
  rootDoc: "<hex SHA-256 of JCS of the signed root document>",
  root: "0x…", scope: "0x…", message: "0x…", nullifier: "0x…",
  proof: "<b64u, about 14.7 KB raw>"
}
```

`root`, `scope` and `message` are there for debugging and quick refusal. The verifier recomputes or looks up each and refuses if they differ.

### 8.4 Tip code

- 16 random bytes, shown as 26 Crockford base32 characters in groups of 4, for example `7K3Q-M2XD-…`.
- Tip DID seed: `HMAC-SHA256(tipCodeBytes, "tipline/v1/tip-did")`, then trust-core's `identityFromSeed`.
- Tip id: `"urn:tipline:" + first 16 bytes of HMAC-SHA256(tipCodeBytes, "tipline/v1/tip-id")`, in hex.
- Nothing else is needed to return. Anyone with the code can read replies and write as the source, as with SecureDrop's codenames (S7), and the app says so.

### 8.5 Chunks and padding

- Attachments are cut into chunks of exactly 147,456 bytes (144 KiB), the last one padded with random bytes. Encoded in base64url, a chunk with its envelope stays under the relay's 256 KiB limit.
- Chunk payload: `{ tipId, attachment, index, count, data }`.
- The number of chunks per tip is padded up to the next of 1, 2, 4, 8, 16, 32, 64 or 128, with dummy chunks marked `attachment: "pad"` inside the sealed payload.
- The submit is padded to a multiple of 16 KiB.
- The MVP cap is 16 MiB of attachments per tip, which fits the relay's 64 MiB queue per recipient a few times over.

## 9. Privacy leaks and mitigations

| Leak | Who sees it | Mitigation (MVP) | Deferred |
|---|---|---|---|
| **Enrollment is a signal.** If few members enroll, the enrolled list is a short suspect list. | Organization | The wallet is generic, not Tipline's. The source app shows the group size and refuses below `minSize`. | Enrollment as routine for every member, through uses the organization wants (surveys, hotlines); groups run by third parties (section 16). |
| **The organization holds or generates the secret.** | Organization | Only the member's own wallet makes the secret. The wallet refuses to import one. The source app warns against company devices. | |
| **Tailored roots.** A root built for one member (them plus fakes) identifies them when they use it. | Organization, colluding mirror | One root per epoch in a signed chain. Equivocation is evidence. The source app checks the mirror against the issuer's URL, and refuses a group below `minSize`. | Public witnesses for root logs, as in certificate transparency. |
| **Fake members** inflate the set and pose as sources. | Organization | Shown next to every count. | |
| **IP address** | Relay, outlet host, network | The app tells the source to use Tor Browser, never a work network or device. The demo shows the relay's view. | An onion service for the relay and the outlet site. |
| **Timing.** A tip soon after a document was accessed narrows the set. | Organization (relay), journalist's infrastructure | Optional random delay of 1 to 12 hours before sending. Timestamps in documents and proofs are rounded down to the hour (a coarse clock). | Sending through a mixnet. |
| **Sizes** | Relay | Fixed chunk size, chunk count padded to a power of two, submit padded to 16 KiB steps. | |
| **File metadata** (EXIF GPS, camera serial, author, edit history) | Journalist and anyone they share with | JPEG, PNG and WebP are decoded and re-encoded on a canvas, which drops EXIF, XMP and ICC data. Other files get a warning and a list of what was found. Files are renamed `attachment-n`. | PDFs rasterized to images; office documents converted. |
| **Content tells.** Canary traps (each person given a slightly different copy), printer tracking dots, screenshots showing a username, writing style. | Organization, once published | A checklist in the app before sending. The inbox flags images for review before publication. | |
| **Signed media.** A photo signed by a device (as in `projects/capture`) names the device. | Journalist, organization | Re-encoding drops embedded signatures. The app says so. | |
| **Forensic traces on the source's device** | Anyone with the device | No storage, no passkey, no service worker. The CRS is bundled and bb.js's IndexedDB cache is deleted. A private window is required. | |
| **Code served by the outlet** could be changed to leak the membership code. | Outlet host, organization | The descriptor names the bundle's SHA-256. The bundle is static and can be downloaded and opened locally. | Reproducible builds; a browser extension that checks the hash. |
| **Proof leaks the witness** if made without ZK. | Journalist and anyone who sees the proof | ZK target only, enforced by the library and tested. | |
| **Nullifier across stories** | Journalist | Scopes differ per story and drop box. | |
| **Coercion** | Organization | None. | Deniable designs (section 16). |
| **Spam and queue filling.** Fresh DIDs are free, so anyone can fill the drop box's relay queue. | Relay, anyone | The relay's per-recipient limits. The inbox drops unproved tips quickly. | A relay that admits messages to a drop box only with a membership proof under a relay scope, `scopeOf("relay/v1", relayUrl, day)`. That lets it limit each member per day without learning which member, and that scope can't be linked to the tip's. |

## 10. MVP scope

**Built and demoed**

1. `packages/anon-membership`:
   - the depth-20 circuit with its compiled artifacts and verification key;
   - the TypeScript API in section 13: fields, hashing, tree, snapshots, root documents and the log check, `GroupIssuer`, prover, verifier, `acceptMembership`, the nullifier book, the `anon-membership/enroll` task;
   - a bundled CRS for the source app.
2. `projects/tipline`:
   - the Acme issuer service with an HR console: roster, enroll, revoke, daily publishing on the dev clock, HTTP log and snapshots;
   - the member wallet: make the seed, enroll, check the leaf, show the membership code;
   - the source app: descriptor, mirror check, size check, image cleaning, proving, tip code, sending with padding and an optional delay, returning with a tip code, replies;
   - the inbox: descriptor editor, verification, source labels and counts, attachments, replies, proof requests, equivocation alerts;
   - the outlet site with its mirror;
   - a relay panel showing what the relay stored;
   - `npm run tipline`, `npm run demo --workspace @zk-toip/tipline`, `npm run e2e --workspace @zk-toip/tipline`.

**Deferred**

Tor and onion services. Mixnets. Root-log witnesses. Cleaning PDFs and office files. Shared newsroom inboxes (trust-core's `sealItem` already seals to several readers). Phase 2 membership from existing credentials. BBS. Relay admission by proof. Depths 16 and 24. Native phone proving. Paying sources through Settle. Delivery over `projects/mesh`.

## 11. Demo script

Cast: **Acme Chemicals** (the issuer, which also runs the relay), 60 employees (58 enrolled by a seeding script, 2 real), **Priya** (a safety engineer at Acme's Riverside plant), **Marcus** (a maintenance lead), **Sam Ortiz**, a reporter at **The Ledger**.

1. **Acme's group.** On the HR console, Acme shows 60 enrolled employees. It publishes today's root. Show the signed root document: epoch, size 60, and the snapshot hash.
2. **Priya enrolls** in her own wallet (done "last month"). The HR console shows Priya's DID next to her commitment. Point out that this is all Acme ever learns about her from the protocol.
3. **Sam opens a story,** "Valve failures at Acme's Riverside plant", accepting Acme's employee group with `minSize` 50. The descriptor is signed and uploaded.
4. **Priya tips.** In a private window: the source app checks the mirror against Acme's log and shows "1 of 60". She pastes her membership code, writes the tip and attaches a photo of a valve log. The app shows the photo's EXIF (GPS, phone model), then the cleaned file. It proves (time shown), gives her a tip code and sends.
5. **Acme's relay panel** shows a fresh `did:key` sending four messages of identical size to the drop box. Nothing else.
6. **Sam's inbox:** "Source A, a member of Acme Chemicals employees (60 members) as of 2026-11-06, designed-to-be-zero-knowledge proof verified". The photo has no metadata.
7. **Sam replies** with a question. Priya closes her window.
8. **Skip ahead one day.** Priya opens a new private window, types the tip code, reads the reply and answers. Sam sees it in the same thread.
9. **Priya tries to look like two sources.** She makes a new tip code and sends a second tip on the same story. The inbox shows Source A again.
10. **Marcus tips** on the same story. Source B. The inbox: "2 distinct members of this group. The issuer could control some of them."
11. **Acme fires Marcus** and revokes him. Skip ahead four days, so the roots without him are newer and the old ones are past `maxEpochAge`. Marcus's wallet finds no leaf in the newest root. A tip proved against an old root is refused as stale. His earlier tip stays, marked "member as of 2026-11-06".
12. **Acme cheats.** It signs a second root for today, with only Priya's leaf and 59 fakes, and puts it on the outlet's mirror. Priya's source app refuses, because the mirror and Acme's own log differ. Sam's inbox shows both signed roots as evidence of equivocation and refuses the group for that epoch.
13. **What Acme knows** at the end: its roster and commitments, and the relay's list of DIDs, sizes and times. The demo searches Acme's state and the relay database for Priya's DID, her commitment and her nullifier, and finds them only where expected (the roster).

## 12. Test plan

### 12.1 What the tests must prove

1. A member can prove and a non-member can't.
2. A proof is bound to its root, scope, message and nullifier: changing any one public input fails verification.
3. The same member and scope always give the same nullifier. Different scopes give different ones.
4. The library never makes or accepts a no-zk proof.
5. A removed member can't prove against a root without them, and old roots expire by policy.
6. Equivocating or broken root logs are detected.
7. A copied proof can't be reused for another sender, body or file.
8. No protocol data that the organization or relay can see contains the employee DID, the commitment, the nullifier or the scope.
9. The source app leaves no storage and makes no request outside its allowlist.
10. TypeScript and Noir hashing agree.

### 12.2 Unit (`packages/anon-membership`)

- **Hash vectors.** A vector file of Poseidon2 inputs and outputs (lengths 1, 2, 3, 4), commitment, node and nullifier values. `nargo test` checks them in Noir and vitest checks bb.js's `poseidon2Hash`.
- **Encodings.** `toField`, `fieldFromHex` (refuses at or above the modulus), `scopeOf`, `messageOf`, `memberSecret`, membership-code round trip and checksum failure.
- **Tree.** Against a naive full-tree computation for random sets: append, remove, root, paths that verify, snapshot round trip, zero values, capacity of 2^20, an index never reused.
- **Root documents.** Sign and verify; wrong issuer; changed root, size or snapshot hash. `checkRootLog`: a gap in `seq`, a broken `prev`, two roots in one epoch (equivocation returned with both documents), a snapshot that doesn't match.
- **Circuit** (`nargo test`): a valid witness; wrong root; wrong secret; a changed sibling; flipped index bits; an index of 2^20; `scope = 0`; the nullifier equals the TypeScript value.
- **Prover and verifier** (Node, bb.js): a valid proof verifies. Each of root, scope, message and nullifier changed fails. A proof made with `noir-recursive-no-zk` fails under the verifier. Two proofs of the same statement differ. The proof bytes contain none of the 32-byte encodings of the secret, the leaf or any sibling (a smoke test, not a proof of ZK). A different verification key fails.
- **Acceptance.** Each `reason`: circuit, group, unknown root, stale, too small, equivocation, scope, message, proof.
- **Nullifier book.** Labels in order, counts per scope and group, survives `toJSON` and back.

### 12.3 Unit (`projects/tipline`)

- **Message binding.** Changing `replyTo`, `tipId`, body, an attachment hash or the story changes `message`.
- **Chunking and padding.** Sizes fall in their buckets. Reassembly. A bad SHA-256 is refused. Dummy chunks are dropped.
- **Codes.** Tip code to DID and `tipId` is deterministic. Typos are caught.
- **Image cleaning** (browser test): a JPEG with EXIF GPS comes out with no APP1 segment. A PNG loses `eXIf`, `tEXt`, `iTXt` and `zTXt` chunks.
- **Descriptor.** Sign and verify. A changed story is refused.
- **Coarse clock.** `issuedAt` and the proof's `created` are rounded down to the hour.

### 12.4 Integration (Node, real relay, real proofs)

- **The whole flow:** enroll 60, publish, prove, send over the relay, verify, label Source A, receipt, reply. The source reconnects from the tip code alone and gets the reply.
- **Sources:** same member and story twice gives Source A twice. Another member gives Source B. The same member on another story gives a nullifier unrelated to the first.
- **Revocation:** after a revoke and a new root, the member's leaf is 0 and proving fails. A proof against the old root is accepted within `maxEpochAge` and refused after.
- **Non-member:** a secret not in the group can't make a proof (the prover throws).
- **Lifted proof:** a valid proof re-sent from another DID, or with a changed body, is refused for its message. Re-sending the same document is refused by the replay guard.
- **Bad roots:** a proof against a root not in the log is refused. An equivocating issuer makes the inbox refuse the group and keep both documents.
- **Partition:** a mirror serving a snapshot that differs from the issuer's makes the source agent refuse.
- **What the organization and relay see:** search the relay database, every wire, and the issuer's state for the employee DID string, the commitment and the nullifier, as hex and base64url. The DID and commitment appear only in the issuer's roster. The nullifier appears nowhere outside the inbox.
- **Offline inbox:** tips wait on the relay and are processed when the inbox starts.

### 12.5 End to end (browser, Playwright, like Settle's `web/e2e.ts`)

- The demo script, steps 1 to 12, with screenshots.
- The source app proves in Chromium. Proving, verification and setup times go to `results/`.
- **Network allowlist:** every request from the source page goes to its own origin or the relay. None to the CRS hosts.
- **Storage:** after the source session, its origin has no localStorage, IndexedDB, cookies, Cache Storage or service workers.

## 13. Shared library needs

### 13.1 `packages/anon-membership` (new; used by tipline and agora)

Name kept from the working name: it says what it does, and it isn't tied to one proof system. Package `@zk-toip/anon-membership`.

```ts
import type { Clock, Endpoint, Identity } from "@zk-toip/trust-core";
import type { SpecPolicy } from "@openvtc/trust-tasks/runtime";

// ── Fields and hashing ──────────────────────────────────────────────
export type Field = bigint;                       // BN254 Fr
export const FIELD_MODULUS: bigint;
export function fieldToHex(f: Field): string;      // "0x" + 64 hex
export function fieldFromHex(hex: string): Field;  // throws at or above the modulus
export function toField(digest: Uint8Array): Field; // first 31 bytes, big-endian

/** Loads Barretenberg once for hashing. Call before any function below. */
export function initHashing(): Promise<void>;
export function poseidon2(inputs: Field[]): Field; // = Noir Poseidon2::hash(inputs, inputs.length)
export function commitmentOf(secret: Field): Field;              // H([1, secret])
export function nullifierOf(secret: Field, scope: Field): Field; // H([2, secret, scope])
export function scopeOf(app: string, ...parts: string[]): Field;
export function messageOf(app: string, value: unknown): Field;

// ── Members ─────────────────────────────────────────────────────────
export function groupIdOf(issuerDid: string, name: string): string; // "<did>#<name>"
export function memberSecret(seed: Uint8Array, groupId: string): Field;
export function encodeMembershipCode(secret: Field, groupId: string): string;
export function decodeMembershipCode(code: string, groupId: string): Field | null;

// ── The tree ────────────────────────────────────────────────────────
export type Depth = 20;                            // 16 and 24 later
export interface MerklePath { index: number; siblings: Field[] }
export class GroupTree {
  constructor(depth: Depth);
  static fromSnapshot(snapshot: Uint8Array, depth: Depth): GroupTree;
  append(commitment: Field): number;               // returns the index
  remove(index: number): void;                     // leaf becomes 0
  indexOf(commitment: Field): number;              // -1 if absent
  root(): Field;
  size(): number;                                  // non-zero leaves
  length(): number;                                // next index
  path(index: number): MerklePath;
  snapshot(): Uint8Array;
}
export function verifyPath(leaf: Field, path: MerklePath, root: Field): boolean;

// ── Root documents and the log ──────────────────────────────────────
export interface GroupRoot { /* section 6.6 */ }
export function epochOf(ms: number): string;       // UTC day, "2026-11-06"
export function rootDocHash(doc: GroupRoot): string;
export function snapshotMatches(doc: GroupRoot, snapshot: Uint8Array): boolean;
export type RootLogCheck =
  | { ok: true; head: GroupRoot }
  | { ok: false; reason: "signature" | "issuer" | "chain" | "equivocation"; evidence?: [GroupRoot, GroupRoot] };
export function checkRootLog(log: GroupRoot[], expectedIssuer: string, clock: Clock): Promise<RootLogCheck>;

// ── The issuer ──────────────────────────────────────────────────────
export class GroupIssuer {
  constructor(opts: { identity: Identity; clock: Clock; name: string; depth: Depth; state?: GroupIssuerState });
  readonly groupId: string;
  /** Adds or replaces `subject`'s commitment. The old leaf, if any, becomes 0. */
  enroll(subject: string, commitment: Field): { index: number };
  revoke(subject: string): void;
  /** Signs this epoch's root. Throws if this epoch already has one. */
  publish(): { root: GroupRoot; snapshot: Uint8Array };
  log(): GroupRoot[];
  snapshot(epoch: string): Uint8Array | undefined;
  /** Registers the enroll handler; `admit` decides whether a DID may join. */
  serve(endpoint: Endpoint, admit: (did: string) => boolean | Promise<boolean>): void;
  state(): GroupIssuerState;                       // JSON, for persistence
}
export const ENROLL: SpecPolicy;                   // ourSpec("anon-membership/enroll")
export interface EnrollRequest { group: string; commitment: string }
export interface EnrollResponse { group: string; index: number; firstEpoch: string }
/** Member side: enrolls and returns the index the issuer gave. */
export function enroll(endpoint: Endpoint, issuerDid: string, groupId: string, secret: Field): Promise<EnrollResponse>;

// ── Proving and verifying ───────────────────────────────────────────
export interface CircuitArtifacts { id: string; depth: Depth; circuit: object; vk: Uint8Array; vkHash: string }
export function loadArtifacts(depth: Depth): Promise<CircuitArtifacts>;
export type CrsSource =
  | { kind: "bundled"; baseUrl: string }           // browser: points served from our origin
  | { kind: "directory"; path: string };           // Node: bb.js crsPath
export interface MembershipProof { /* section 8.3 */ }
export class MembershipProver {
  static create(opts: { artifacts: CircuitArtifacts; crs: CrsSource; threads?: number }): Promise<MembershipProver>;
  /** Always the ZK target. Throws if the secret's leaf isn't in `tree` or `tree` doesn't match `root`. */
  prove(input: { secret: Field; tree: GroupTree; root: GroupRoot; scope: Field; message: Field }): Promise<MembershipProof>;
  /** Frees memory and deletes bb.js's browser cache. */
  destroy(): Promise<void>;
}
export class MembershipVerifier {
  static create(opts: { artifacts: CircuitArtifacts[]; crs: CrsSource }): Promise<MembershipVerifier>;
  verify(proof: MembershipProof): Promise<boolean>;
  destroy(): Promise<void>;
}

// ── Acceptance and nullifiers ───────────────────────────────────────
export interface AcceptPolicy { group: string; issuer: string; vkHashes: string[]; maxEpochAge: number; minSize: number }
export type Acceptance =
  | { ok: true; nullifier: Field; epoch: string; size: number; root: GroupRoot }
  | { ok: false; reason: "circuit" | "group" | "unknownRoot" | "stale" | "tooSmall" | "equivocation" | "scope" | "message" | "proof" };
export function acceptMembership(proof: MembershipProof, ctx: {
  policy: AcceptPolicy; log: GroupRoot[]; verifier: MembershipVerifier;
  scope: Field; message: Field; clock: Clock;
}): Promise<Acceptance>;

export class NullifierBook {
  constructor(state?: NullifierBookState);
  /** "Source A", "Source B", … per (group, scope), in order of first sight. */
  label(group: string, scope: Field, nullifier: Field): { label: string; first: boolean };
  count(group: string, scope: Field): number;
  state(): NullifierBookState;
}
```

How each project uses it:
- **Tipline:** the issuer uses `GroupIssuer`. The wallet uses `memberSecret`, `enroll` and `encodeMembershipCode`. The source app uses `checkRootLog`, `GroupTree.fromSnapshot`, `MembershipProver`. The inbox uses `acceptMembership` and `NullifierBook`. Scope per drop box and story.
- **Agora:** a licensing body runs a `GroupIssuer` of licensed nurses. For one account per person, the scope is the forum, and the proof's `message` binds a pseudonymous did:key: `messageOf("agora/v1", { kind: "account", forum, accountDid })`. The nullifier is then the account's identity on the forum, and later posts are signed by `accountDid` with no new proof. Re-proving against a newer root, with the same nullifier, shows the poster is still licensed.

Dependencies it adds: `@aztec/bb.js` as `npm:@aztec-foundation/bb.js@6.0.0`, `@noir-lang/noir_js` 1.0.0. Build-time: `nargo` 1.0.0, `bb` 6.0.0, Noir library `noir-lang/poseidon` v0.4.0. Everything else comes from trust-core.

### 13.2 Others

- **An event log** (from `projects/trail`). The root log needs: append a signed entry with `seq` and `prev`; verify a chain; detect and return two conflicting signed entries. If trail's library offers that, `checkRootLog` becomes a thin wrapper over it.
- **`packages/web-vault`** (extracted from Settle's `web/src/vault.ts`). The inbox and the member wallet seal their keys with a passkey or passphrase, as Settle does. Agora's client needs the same. The source app must not use it.
- **`CoarseClock` in trust-core.** A `Clock` that rounds `now()`, `iso()` and `date()` down to a granularity, so `Endpoint` writes coarse `issuedAt` and proof times. Small; agora's posts need it too.
- **An ephemeral outbox for `RelayTransport`.** Its `OutboxStore` must be in memory only for the source app. Already possible; the shared code should make it the obvious choice.

## 14. Integration points

- **Settle: paying a source (deferred).** An outlet or a whistleblower fund pays a Settle escrow whose payee is the tip DID. The source's app derives a Settle payment key from the tip code, as Settle derives payment keys from an identity seed. The chain shows nothing linking the payment to the tip. Turning the money into cash is the leak: an off-ramp knows its customer, and moving funds to a known wallet links them on-chain (Settle design §9). Many outlets also refuse to pay sources at all. The integration is technically small and is deferred for those reasons.
- **Agora:** the same library (13.1).
- **Trail:** the root log (13.2). Trail's audit logs could also anchor the inbox's record of receipts.
- **Capture:** signed media identifies its device. The source app strips it by default. A source who wants to prove a photo came from a plant camera could keep it, knowingly.
- **Mesh:** a source where the internet is cut off could send a tip store-and-forward. The proof is about 15 KB, which is large for LoRa. Deferred.

## 15. Shape of the work

1. `packages/anon-membership`: hash vectors first, then the tree, the circuit and its tests, root documents, prover and verifier in Node, acceptance.
2. Browser proving with the bundled CRS, and the allowlist and storage tests, before any UI.
3. Tipline's protocol module and agents, with the integration tests over a real relay.
4. The platform, the four web apps and the relay panel.
5. The demo, the e2e run, and measured timings.

## 16. Open questions

**For the user**
1. Would an employer run a group like this? If not, who should: a union, a professional body, an industry regulator? This decides whether phase 2 (proving from an ordinary credential, 6.9) is needed early.
2. Is a daily root, with a 3-day acceptance window, the right trade between revocation speed and the source's time to prepare? An employee fired today can tip for up to 4 days.
3. Should the source app refuse to run outside Tor Browser, or only warn?
4. How strong must the ZK claim be? UltraHonk's ZK mode has no published proof that we found. If that is not enough, the alternatives are a system with a machine-checked proof (zk-pdp's GordieHowe) or BBS once its drafts settle.
5. Coercion: is it in scope? An employer can force each member to compute their nullifier for a story. Designs that resist this exist in voting research but add a lot.
6. Paying sources through Settle: wanted at all, given journalism's norms and the off-ramp leak?

**Design**
- Should the circuit take `minSize` into account, for example by committing to the size in the root, so a journalist can't be shown a small group without the circuit noticing? Today the size is in the signed root document, checked outside the circuit.
- Should the relay support proof-gated admission (section 9) in `packages/relay`, so spam can't fill a drop box?
- Should one tip be able to prove membership of several groups at once ("an Acme employee and a licensed engineer")? That is two proofs today.
- How do sources learn the issuer's DID safely? did:web would help; the trust core resolves did:key only.

**For the ToIP community**
- Is there interest in `anon-membership/*` as Trust Tasks? The stack's "hidden vetting" (`vta/pcs/prove`, S1) is the nearest thing. What proof system does it use?
- How should a group root relate to a VTC's membership? A community's Network Manager could publish one.

## 17. Sources

All read on 2026-11-06.

| # | What | How read | Trust |
|---|---|---|---|
| S1 | Repository source note S02: the Trust Tasks registry, including `vta/pcs/prove` and `vtc/directory/introduce` (`docs/sources/S02-trust-tasks-registry-and-openvtc.md`) | Read in full | As that note says |
| S2 | Barretenberg CLI options, verifier targets and `-no-zk`: https://github.com/AztecProtocol/aztec-packages/blob/next/barretenberg/docs/docs/cli_options.md | Through a fetch tool that summarizes pages | Summary only |
| S3 | Noir v1.0.0 `SECURITY.md`: https://github.com/noir-lang/noir/blob/v1.0.0/SECURITY.md | Fetch tool | Summary only |
| S4 | zk-pdp at commit `d9b9649`: `bench/circuit/ed25519`, `bench/web/main.js`, decisions 0005 and 0027, E13, and `projects/zk-pdp-fit/` in this repository | Read locally | Primary for what zk-pdp did |
| S5 | Semaphore v4 specification: https://github.com/ethereum/access-layer-specs/blob/main/specs/3-semaphore-v4/README.md (moved from https://github.com/zkspecs/zkspecs/blob/main/specs/3/README.md) | Fetch tool | Summary only |
| S6 | Hashcloak, Semaphore Noir benchmarks: https://hashcloak.github.io/semaphore-noir-final-report/benchmarks.html | Fetch tool | Summary only |
| S7 | SecureDrop threat model: https://docs.securedrop.org/en/stable/threat_model/threat_model.html | Fetch tool | Summary only |
| S8 | BBS per-verifier linkability (pseudonyms), draft 03: https://datatracker.ietf.org/doc/draft-irtf-cfrg-bbs-per-verifier-linkability/ | Fetch tool | Summary only |
| S9 | `@digitalbazaar/bbs-signatures` 3.1.0 README, which lists the BBS, blind-signature and pseudonym drafts it follows | `npm view … readme` | Primary for what it states |
| S10 | `@aztec-foundation/bb.js` 6.0.0 code: `dest/browser/crs/net_crs.js`, `dest/browser/crs/browser/cached_net_crs.js`, `dest/browser/barretenberg/index.js`, `dest/node/barretenberg/backend.d.ts`, from `~/code/zk-pdp/bench/web/node_modules` | Read locally | Primary |
| S11 | zk-pdp literature note `docs/literature/research_notes/ZK policy evaluation prior art/zkvm_and_proof_security.md`, which cites zkVerify PR 441 (https://github.com/zkVerify/zkVerify/pull/441), Certora (https://www.certora.com/blog/payy-exploit-forged-zk-proof-attack) and Aztec (https://aztec.network/blog/alpha-v5-proving-system-vulnerability) | Read locally; the cited pages were not re-read | Secondary |
| S12 | `noir-lang/poseidon` v0.4.0, `src/poseidon2.nr`, from the local nargo cache (`~/nargo/github.com/noir-lang/poseidon/v0.4.0`) | Read locally | Primary |
| S13 | npm registry metadata (versions, publication dates, dependencies) for `@aztec/bb.js`, `@aztec-foundation/bb.js`, `@noir-lang/noir_js`, `@semaphore-protocol/*`, `@hashcloak/semaphore-noir-proof`, `@digitalbazaar/bbs-signatures`, `@mattrglobal/pairing-crypto` | `npm view` | Primary for the metadata |
| S14 | `@openvtc/trust-tasks` 0.28.17 `src/_runtime/freshness.ts`: default freshness has no maximum age and 60 s of skew | Read locally in `node_modules` | Primary |
