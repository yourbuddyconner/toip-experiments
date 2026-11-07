// Short, task-focused how-tos. Each one answers one question with one runnable program in
// site/examples/guides/<slug>.ts, which `npm run check` runs and `npm run examples:record` records.

export interface Guide {
  slug: string;
  /** The question, as the page's heading. */
  title: string;
  /** The <title>, for search. */
  seoTitle: string;
  /** The search snippet. At most about 160 characters. */
  description: string;
  /** One sentence, for lists and llms.txt. */
  summary: string;
  /** Library slugs it uses, the first one primary. */
  libraries: string[];
  /** Markdown before the code. */
  intro: string;
  /** Markdown points after the output: what happened and why. */
  how: string[];
  /** Markdown: what it doesn't do, or what to do differently in production. */
  notes: string[];
  /** Public API names it uses, by library, linked to their reference pages. */
  apis: { library: string; names: string[] }[];
  /** Concept anchors on /concepts/. */
  concepts: string[];
  related: string[];
  /** Node needs this to run the example; npm installs these. */
  packages: string[];
}

export const guides: Guide[] = [
  {
    slug: "did-key-sign-document",
    title: "Create a did:key and sign a JSON document in TypeScript",
    seoTitle: "Create a did:key and sign JSON in TypeScript (Ed25519, Data Integrity)",
    description: "Generate an Ed25519 did:key identity, sign a JSON document with an eddsa-jcs-2022 Data Integrity proof, and verify it from the DID alone. Runnable TypeScript.",
    summary: "Generate an Ed25519 did:key, sign a JSON document with a Data Integrity proof, and verify it from the DID alone.",
    libraries: ["trust-core"],
    intro: `
A \`did:key\` is a decentralized identifier that *is* its public key, written out. There is nothing to register and nothing to look up: anyone holding the DID can check your signatures. That makes it the quickest way to give a person, device or service a verifiable identity.

This program creates one from 32 random bytes, signs a small JSON document, and verifies the signature. It then changes one field to show that verification fails.
`,
    how: [
      "`identityFromSeed` turns a 32-byte seed into an Ed25519 key pair, its `did:key` identifier, and a derived X25519 key for encryption. The seed is the secret: store it as you would a password hash's key, not in source code.",
      "`resolveDidKey` decodes the public key from the DID itself, with no network access. This is what a verifier does.",
      "`signDocument` adds a W3C Data Integrity proof with the `eddsa-jcs-2022` cryptosuite: the document is canonicalized with JCS (RFC 8785) and signed with Ed25519. The document's `issuer` must be the signer's DID; the proof's `verificationMethod` points at the key inside that DID.",
      "`verifyDocument` recomputes the canonical form and checks the signature, allowing five minutes of clock skew on the proof's creation time. It returns `{ valid, failure }` rather than throwing.",
    ],
    notes: [
      "A `did:key` can't rotate its key. If the seed leaks, you need a new identifier. For identifiers that outlive their keys, see the [KERI audit log guide](/guides/tamper-evident-audit-log/).",
      "Only Ed25519 `did:key` identifiers are supported. There is no resolver for other DID methods.",
      "`seedFrom(label)` hashes a label into a seed. It is for repeatable demos and tests: a guessable label gives a guessable key.",
    ],
    apis: [{ library: "trust-core", names: ["identityFromSeed", "resolveDidKey", "signDocument", "verifyDocument", "SystemClock"] }],
    concepts: ["dids"],
    related: ["issue-verify-credential", "tsp-encrypted-message"],
    packages: ["@toip-tools/trust-core"],
  },
  {
    slug: "issue-verify-credential",
    title: "Issue and verify a W3C verifiable credential in TypeScript",
    seoTitle: "Issue and verify a W3C verifiable credential in TypeScript (VC 2.0, did:key)",
    description: "Issue a verifiable credential in the W3C VC Data Model 2.0 shape with a Data Integrity proof, then verify its proof, issuer, subject and validity in TypeScript.",
    summary: "Issue a credential in the W3C VC 2.0 shape with a Data Integrity proof, then check its proof, issuer, subject and validity window.",
    libraries: ["trust-core"],
    intro: `
A verifiable credential is a signed statement by an issuer about a subject: "this DID holds a BSc from this university". The holder keeps it and shows it when asked; the verifier checks it without calling the issuer.

This program issues a degree credential from one \`did:key\` to another, prints it, and runs four presentations through a verifier: the real one, the same credential presented by someone else, a copy with the degree changed, and one the graduate signed themselves.
`,
    how: [
      "`issueCredential` fills in `@context` (`https://www.w3.org/ns/credentials/v2`), a `urn:uuid` id, the issuer's DID and `validFrom`, then signs the whole credential with an `eddsa-jcs-2022` Data Integrity proof.",
      "`verifyCredential` checks the proof, that the proof's key belongs to the `issuer`, and the `validFrom`/`validUntil` window. It returns `{ ok: true }` or `{ ok: false, failure }`, where `failure` is one of `signatureInvalid`, `issuerMismatch`, `malformedProof`, `notYetValid` or `expired`.",
      "A valid signature only says *who* made the claim. Deciding whether that issuer is an authority for it is your policy: here, a set of trusted issuer DIDs.",
      "Comparing `credentialSubject.id` with the holder only means something if the holder proved control of that DID. In practice, compare it with the authenticated sender of the message that carried the credential, as the [quickstart's step 4](/quickstart/#credentials) does over TSP.",
    ],
    notes: [
      "Credentials have one issuer and one proof. JSON-LD contexts are not processed or validated, and other proof formats (VC-JWT, SD-JWT, BBS) are not supported.",
      "Revocation is a separate check: see [Revoke a credential with a status list](/guides/revoke-credential-status-list/).",
    ],
    apis: [{ library: "trust-core", names: ["issueCredential", "verifyCredential", "Credential", "CredentialCheck"] }],
    concepts: ["credentials"],
    related: ["revoke-credential-status-list", "did-key-sign-document"],
    packages: ["@toip-tools/trust-core"],
  },
  {
    slug: "revoke-credential-status-list",
    title: "Revoke a verifiable credential with a status list",
    seoTitle: "Revoke a verifiable credential with a status list in TypeScript",
    description: "Give each credential a bit in a signed status list, revoke it by setting the bit and re-signing, and check status as a verifier. Runnable TypeScript.",
    summary: "Give each credential a bit in a signed status list, revoke by setting the bit and re-signing, and check status as a verifier.",
    libraries: ["trust-core"],
    intro: `
Credentials are checked offline, so an issuer can't take one back by deleting a database row. Instead it publishes a signed list with one bit per credential it has issued. A verifier fetches the latest list, checks the issuer's signature, and reads the credential's bit.

One list covers many credentials, so fetching it doesn't tell the issuer which credential is being checked, or where.
`,
    how: [
      "`StatusList` holds the bits (1024 by default). `allocate()` gives a new credential its slot, which goes in the credential's `credentialStatus.statusListIndex`.",
      "`sign(issuer, clock)` produces the publishable document: the bits in base64url, the issuer, a timestamp and a Data Integrity proof. Publish it wherever verifiers can fetch it.",
      "`checkStatus(list, index, expectedIssuer, clock)` returns `signatureValid` (signed by the expected issuer), `revoked` (the bit), and `ageSeconds`, so you can refuse a list that is too old.",
      "To revoke, call `revoke(slot)`, sign again and publish the new copy. Anyone holding an old copy still sees the old answer, which is why the age matters.",
    ],
    notes: [
      "The list document is this library's own format, modeled on the W3C Bitstring Status List; credentials reference it with a `BitstringStatusListEntry`. It is not a W3C `BitstringStatusListCredential`, and other verifiers won't read it.",
      "The list isn't compressed. A 1024-entry list is 128 bytes of bits.",
      "For delegation, `@toip-tools/mandates` has a `StatusRegistry` that enforces how fresh a list must be: see [the mandates guide](/guides/delegate-to-ai-agent/).",
    ],
    apis: [{ library: "trust-core", names: ["StatusList", "checkStatus", "isRevokedIn", "StatusListDoc", "issueCredential"] }],
    concepts: ["credentials"],
    related: ["issue-verify-credential", "delegate-to-ai-agent"],
    packages: ["@toip-tools/trust-core"],
  },
  {
    slug: "tsp-encrypted-message",
    title: "Send an end-to-end encrypted message with TSP (the Trust Spanning Protocol)",
    seoTitle: "Send an end-to-end encrypted message with TSP in TypeScript (Trust Spanning Protocol)",
    description: "Send a signed, end-to-end encrypted Trust Task between two did:key identities with TSP Direct mode, and see what the network can and can't read. TypeScript.",
    summary: "Send a signed, end-to-end encrypted Trust Task with TSP Direct mode between two did:key identities, and see what the network sees.",
    libraries: ["trust-core"],
    intro: `
The Trust Spanning Protocol (TSP), from the Trust over IP Foundation, is a message format for two parties identified by their identifiers (VIDs, here \`did:key\`s). Each message is signed by the sender and encrypted to the recipient, whatever carries it: a relay, a WebSocket, a radio, a USB stick.

This program sends a one-way message from Alice to Bob over an in-memory network that records every message, then shows what an observer saw and what happens to a message changed in transit.
`,
    how: [
      "An `Endpoint` wraps a JSON Trust Task document in a TSP Direct message: signed with the sender's Ed25519 key and sealed to the recipient's X25519 key with HPKE. The TSP implementation is the OpenVTC library `@openvtc/vti-tsp-js`.",
      "A message type is a plain object: it names the type (a URI you choose) and what the receiver demands of every message of that type: a proof, a recipient, a timestamp, and not a bearer token.",
      "Bob's handler runs only after the message decrypts, the signature matches the sender's DID, it is addressed to Bob, it is fresh, and it hasn't been seen before (replay protection).",
      "`notify()` is one-way and returns how it was delivered. `request()` waits for a signed reply; a handler can return `new Refusal(code, message)` to send a signed refusal instead.",
    ],
    notes: [
      "TSP Direct mode hides contents, not metadata: the sender's and recipient's identifiers travel in clear, as do size and timing. These libraries use only Direct mode, not TSP Routed mode.",
      "The `Bus` is for tests and demos. For real delivery, use `RelayTransport` with a relay: see [Run a TSP relay](/guides/run-tsp-relay/).",
    ],
    apis: [{ library: "trust-core", names: ["Endpoint", "Bus", "RelayTransport", "Refusal", "ourSpec"] }],
    concepts: ["tsp", "trust-tasks"],
    related: ["run-tsp-relay", "trust-tasks-over-lora"],
    packages: ["@toip-tools/trust-core"],
  },
  {
    slug: "run-tsp-relay",
    title: "Run a TSP relay: a mailbox for encrypted messages",
    seoTitle: "Run a TSP relay in Node: a mailbox for encrypted Trust Spanning Protocol messages",
    description: "Run @toip-tools/relay, a WebSocket mailbox that stores sealed TSP messages in SQLite until the recipient connects, with DID authentication and limits.",
    summary: "Run a WebSocket mailbox that stores sealed TSP messages in SQLite until the recipient connects, survives restarts, and sees only metadata.",
    libraries: ["relay", "trust-core"],
    intro: `
People and devices are rarely online at the same time. A relay holds encrypted messages for a recipient until it connects and acknowledges them. It can't read them: they are sealed to the recipient's key before they reach it.

To run one from the command line:

\`\`\`bash
npx @toip-tools/relay
\`\`\`

It listens on port 8787 and keeps its queue in \`./relay.db\`. Set \`PORT\`, \`HOST\`, \`RELAY_DB\` and \`RELAY_PUBLIC_URL\` to change that. The program below starts a relay in code instead, leaves a note for an offline recipient, restarts the relay on the same database, and delivers the note when the recipient connects.
`,
    how: [
      "`startRelay` serves WebSockets at `/v1` and stores messages in SQLite with `node:sqlite`, which is why it needs Node 22.13 or later. `port: 0` picks a free port; read the real one from `relay.url`.",
      "Clients connect with `RelayTransport` from trust-core. Each one signs a fresh challenge from the relay with its `did:key`, bound to the relay's URL, so the relay knows which mailbox is whose.",
      "A message to a connected recipient goes out at once (`live`); otherwise it waits (`queued`). Either way the relay keeps it until the recipient acknowledges it, and deletes it then. Unacknowledged messages expire after 30 days.",
      "`onStored` shows what an operator can see for each message: sender, recipient, size and time. Never the contents.",
      "`limits` caps what one sender can queue for one recipient, and the total messages and bytes per recipient. A send over a limit is refused with `queueFull`; `RelayTransport` keeps the message and retries.",
    ],
    notes: [
      "In production, run it behind TLS and set `RELAY_PUBLIC_URL` (or `publicUrl`) to the exact `wss://` URL clients use: the URL is part of what they sign.",
      "The relay learns who talks to whom, when, and how much. It delivers TSP Direct messages and does not implement TSP Routed mode.",
      "Keep one connection per DID. A newer connection for the same DID closes the older one.",
    ],
    apis: [
      { library: "relay", names: ["startRelay", "RelayOptions", "RelayLimits", "StoredMessage", "Relay"] },
      { library: "trust-core", names: ["RelayTransport", "Endpoint"] },
    ],
    concepts: ["tsp"],
    related: ["tsp-encrypted-message", "trust-tasks-over-lora"],
    packages: ["@toip-tools/relay", "@toip-tools/trust-core"],
  },
  {
    slug: "delegate-to-ai-agent",
    title: "Delegate bounded authority to an AI agent with mandates",
    seoTitle: "Delegate bounded authority to an AI agent: spending limits and approvals (TypeScript)",
    description: "Give an AI agent a signed mandate: allowed actions and merchants, per-purchase and weekly limits, approval for one exact action, and revocation. TypeScript.",
    summary: "Give an AI agent a signed mandate with allowed actions, spending limits, one-time approvals and revocation, and decide each action against it.",
    libraries: ["mandates", "trust-core"],
    intro: `
An agent that can act for you needs limits it can't talk its way past: which actions, with whom, how much each time and per week. A **mandate** is a signed credential that says exactly that. Anyone can check an action against it, on their own, and get a decision with reasons.

This program gives a shopping agent a mandate, then decides five purchases and a revoked one: an allowed purchase, a merchant outside the list, one over the per-purchase limit that the owner approves, one that would break the weekly budget, and one after revocation.
`,
    how: [
      "A profile (`registerProfile`) is the action vocabulary: here one action type, `shopping/buy`, which must name a merchant and an item. Every action also carries `spend`, in integer units.",
      "`issueMandate` signs the constraints: `anyOf` sets for the action type and merchant, `max` per purchase, and a rolling `budget` over seven days (`P7D`). It also says how many more links may follow, which failures the owner may approve, and how fresh the revocation list must be.",
      "`MandateEngine.decide` checks the signature, validity window and revocation status, then evaluates the constraints with a Rego policy compiled to WebAssembly. It returns `allow`, `escalate` or `deny` with reasons, and every decision carries the policy's hash.",
      "`escalate` means only approvable limits failed. The owner signs an `approve` for that exact action (it is bound to the action's hash), and the engine allows it once. Record used approvals so they can't be replayed.",
      "`SpendLedger.tryReserve` checks the budget and reserves in one step before you pay, so two purchases can't both take the last of it. `explain` turns reasons into sentences.",
    ],
    notes: [
      "The engine decides; your code enforces. Check for `allow` and reserve the spend before the agent acts.",
      "A delegate can pass on a narrower mandate with `delegate()`: every link can only narrow its parent, and a widening is refused without signing anything.",
      "Spending totals come from your ledger, not from the engine. Persist the ledger and the status registry (`save()`), and publish the signed status list where verifiers fetch it.",
    ],
    apis: [
      { library: "mandates", names: ["issueMandate", "MandateEngine", "SpendLedger", "StatusRegistry", "approve", "explain", "registerProfile", "staticStatusResolver", "delegate"] },
    ],
    concepts: ["credentials", "governance"],
    related: ["tamper-evident-audit-log", "revoke-credential-status-list"],
    packages: ["@toip-tools/mandates", "@toip-tools/trust-core"],
  },
  {
    slug: "tamper-evident-audit-log",
    title: "Keep a tamper-evident audit log with KERI key event logs",
    seoTitle: "Tamper-evident audit log in TypeScript with KERI key event logs and witnesses",
    description: "Write an append-only audit log under a KERI identifier, with witness receipts and key rotation, export it, and detect an edited entry offline. TypeScript.",
    summary: "Write an append-only, witnessed audit log under a KERI identifier, rotate keys with pre-rotation, and detect an edited entry offline.",
    libraries: ["eventlog", "trust-core"],
    intro: `
An ordinary log can be edited by whoever runs it. A tamper-evident log can't be changed quietly: every entry is signed and chained, independent witnesses receipt the first version they see, and anyone can verify a copy offline.

This program creates a KERI identifier for a service, appends three audit entries (waiting for a witness receipt on the one that matters), rotates its keys, exports a bundle and verifies it. Then it rewrites one entry and verifies again.
`,
    how: [
      "`Controller.incept` creates a KERI identifier (an AID) and its key event log. The KEL's events are KERI 1.0; the package's tests hand them to KERIpy 1.3.6, which computes the same key state.",
      "Pre-rotation: inception publishes only a digest of the *next* keys (`cold`). `rotate()` switches to them, so someone who steals today's key still can't take over the identifier.",
      "A trail is an audit log owned by the AID. Each entry is a small signed header that commits to a private body by its digest. Rotation seals every open trail at its head, so a retired key can't extend it.",
      "`appendWitnessed` waits until enough witnesses (`bt`) have receipted the entry. Witnesses receipt the first version they see at each position, so two different histories can't both collect receipts.",
      "`exportBundle` packs the KEL, the trails, the receipts and the chosen bodies; `verifyBundle` checks all of it offline and returns problems instead of throwing. Here it reports `bodyMismatch` for the edited entry.",
    ],
    notes: [
      "Trails are this project's own format, built from KERI's rules and CESR primitives; no other KERI implementation reads them. The KEL itself is plain KERI.",
      "Use persistent stores in production: `JsonFileStore` from `@toip-tools/eventlog/node`, and witnesses run by parties other than the writer.",
      "Delegated identifiers, weighted thresholds and KERI 2.0 are not supported.",
    ],
    apis: [
      { library: "eventlog", names: ["Controller", "Witness", "MemoryStore", "coldKeysFromSeed", "ed25519Signer", "signerFromIdentity", "localWitnessClient", "exportBundle", "verifyBundle"] },
    ],
    concepts: ["keri"],
    related: ["delegate-to-ai-agent", "did-key-sign-document"],
    packages: ["@toip-tools/eventlog", "@toip-tools/trust-core"],
  },
  {
    slug: "sign-cose",
    title: "Sign and verify COSE messages in TypeScript",
    seoTitle: "Sign and verify COSE_Sign1 in TypeScript: Ed25519, P-256 and WebCrypto",
    description: "Sign compact COSE_Sign1 messages over deterministic CBOR with an Ed25519 seed or a non-extractable WebCrypto P-256 key, and verify them against trusted keys.",
    summary: "Sign COSE_Sign1 messages over deterministic CBOR with Ed25519 or a non-extractable WebCrypto P-256 key, and verify them against trusted keys.",
    libraries: ["cose"],
    intro: `
COSE (CBOR Object Signing and Encryption, RFC 9052) is the compact, binary counterpart of JOSE. A COSE_Sign1 message is a few dozen bytes plus its payload, which suits sensors, radio links, QR codes and anything else where bytes count.

This program signs one sensor reading with two kinds of key, verifies both against a table of trusted keys, then shows a tampered message and a signature by an untrusted key both failing.
`,
    how: [
      "`encodeCbor` writes RFC 8949 Core Deterministic Encoding, so the same value always gives the same bytes. `decodeCbor` insists on that form by default.",
      "`seedSigner` signs with Ed25519 from a 32-byte seed (algorithm `-19`). `webCryptoSigner` wraps a WebCrypto key pair; generated with `extractable: false`, the private key never leaves WebCrypto. A P-256 key signs as ESP256 (`-9`) unless you ask for ES256 (`-7`).",
      "`verifyCose1` takes a `KeyLookup`: you map the message's key ID to keys you already trust. The key ID is only a hint; a message signed by any other key fails.",
      "Pass an explicit `allowedAlgs` list, and use the payload only when `result.ok` is true. Failures are values: `malformed`, `algNotAllowed`, `keyMismatch`, `signatureInvalid` and the WebAuthn checks.",
    ],
    notes: [
      "Detached payloads and critical headers are refused as malformed.",
      "`webAuthnSigner` signs with a passkey (algorithm `-65600`); verify those messages with an explicit `webauthnOrigins` list.",
      "The tests reproduce the COSE working group's Ed25519 example byte for byte and verify RFC 9052's ES256 example.",
    ],
    apis: [{ library: "cose", names: ["signCose1", "verifyCose1", "seedSigner", "webCryptoSigner", "encodeCbor", "decodeCbor", "KeyLookup", "ALG", "webAuthnSigner"] }],
    concepts: ["dids"],
    related: ["trust-tasks-over-lora", "did-key-sign-document"],
    packages: ["@toip-tools/cose"],
  },
  {
    slug: "trust-tasks-over-lora",
    title: "Send Trust Tasks over LoRa radio",
    seoTitle: "Send signed, encrypted Trust Tasks over LoRa radio in TypeScript (TSP mesh)",
    description: "Send a signed, encrypted TSP Trust Task over LoRa with no internet: fragmented into 250-byte frames, acknowledged and reassembled. Runs on a simulated radio.",
    summary: "Send a signed, encrypted Trust Task over LoRa with no internet: compacted, fragmented into radio frames, acknowledged and reassembled.",
    libraries: ["mesh-transport", "trust-core"],
    intro: `
LoRa radios carry a few hundred bytes at a time over kilometers, with no internet. \`@toip-tools/mesh-transport\` carries TSP over them: the same signed, encrypted Trust Tasks an \`Endpoint\` sends over a relay, so a field sensor or a door lock can check a credential offline.

This program runs on the package's simulated radio, so it needs no hardware: a sensor sends a soil-moisture reading to a base station, which answers with a signed reply.
`,
    how: [
      "`MeshTransport` implements trust-core's `Transport`, so the `Endpoint`, the message type and the handler are the same as over a relay. The bytes the base station opens are exactly the TSP bytes the sensor sealed.",
      "CTT1 (`ctt1`, in trust-core) is a compact CBOR body that decodes to the identical document, so the Data Integrity proof still verifies.",
      "The TSP envelope names both identifiers in clear, so it never goes on the air. A packet carries the encrypted parts and a fresh 4-byte tag that only the recipient can match to the sender.",
      "Packets are cut into frames no larger than the link's MTU (250 bytes here), acknowledged with a bitmap, and only the missing fragments are resent. A scheduler keeps each link inside its airtime budget (10% of channel time in the US region profile).",
      "`VirtualScheduler.run()` advances simulated time while the request waits. Real radio adapters run in real time and don't need it.",
    ],
    notes: [
      "No sealed Trust Task fits in one 250-byte frame; two frames is the floor.",
      "Adapters for real hardware: a LoRaWAN gateway's packet forwarder (`GwmpServer`, Node), a RAK3172 in LoRa P2P mode (`RakP2PLink`), and USB or Web Serial ports. See the [library page](/toolkit/mesh-transport/).",
    ],
    apis: [
      { library: "mesh-transport", names: ["MeshTransport", "plans", "regions"] },
      { library: "trust-core", names: ["Endpoint", "ctt1"] },
    ],
    concepts: ["tsp", "trust-tasks"],
    related: ["tsp-encrypted-message", "sign-cose"],
    packages: ["@toip-tools/mesh-transport", "@toip-tools/trust-core"],
  },
  {
    slug: "zero-knowledge-membership",
    title: "Prove group membership with zero knowledge (Noir)",
    seoTitle: "Prove group membership with a zero-knowledge proof in TypeScript (Noir, UltraHonk)",
    description: "Prove you belong to a group without revealing which member, with Noir and UltraHonk in TypeScript. Scoped nullifiers count one vote per member. Node and browsers.",
    summary: "Prove membership in a group without saying which member, with a Noir circuit and UltraHonk proofs, and count one voice per member with nullifiers.",
    libraries: ["anon-membership", "trust-core"],
    intro: `
Sometimes the verifier should learn only "this is one of our members", not which one: a whistleblower, a union vote, a forum for licensed nurses. A zero-knowledge membership proof says exactly that. A *nullifier* tied to a scope lets the verifier notice the same member twice in that scope, still without learning who it is.

This program enrolls three members with an issuer, has two of them vote, has one vote again, and shows that someone who never enrolled can't produce a proof.
`,
    how: [
      "Each member derives a secret from their own seed and enrolls only a commitment to it, over a TSP Trust Task. The issuer adds it to a Merkle tree (depth 20, up to about a million members) and signs one root per day.",
      "The member proves, in a Noir circuit, that their commitment is in a tree under a signed root, and outputs a nullifier: a hash of their secret and the scope. The proof is bound to the exact message (`signal`).",
      "`acceptMembership` checks the proof, the issuer's signed roots, how old the root may be (`maxEpochAge`), the smallest acceptable group (`minSize`), and the scope and signal. `NullifierBook` gives each distinct nullifier a stable label.",
      "Proofs use UltraHonk from Barretenberg in its zero-knowledge mode. The proving setup data is bundled: nothing is downloaded when proving or verifying.",
    ],
    notes: [
      "This is experimental cryptography. UltraHonk's zero-knowledge mode is *designed* to be zero-knowledge; the package README knows of no published proof that it is, and Noir says it is not yet for production use.",
      "In a browser, prove in a Web Worker with `@toip-tools/anon-membership/worker`, and serve the page cross-origin isolated (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`) for multithreaded proving. The package's tests prove and verify in Chromium.",
      "A small group gives little anonymity: set `minSize` to what your users need.",
    ],
    apis: [
      { library: "anon-membership", names: ["GroupIssuer", "MembershipProver", "MembershipVerifier", "acceptMembership", "NullifierBook", "membershipInputs", "enroll", "memberSecret", "scopeOf", "messageOf"] },
    ],
    concepts: ["zk"],
    related: ["issue-verify-credential", "delegate-to-ai-agent"],
    packages: ["@toip-tools/anon-membership", "@toip-tools/trust-core"],
  },
];

export const guideBySlug = (slug: string): Guide => {
  const g = guides.find((x) => x.slug === slug);
  if (!g) throw new Error(`no guide ${slug}`);
  return g;
};
