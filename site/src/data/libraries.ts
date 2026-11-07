// The libraries in packages/, as the toolkit pages describe them. Facts come from each package's README and src/index.ts.

export type LibStatus = "ready" | "in progress";

export interface Library {
  slug: string;
  name: string;
  dir: string;
  status: LibStatus;
  /** One line: what it does. */
  does: string;
  /** Paragraphs (markdown). */
  about: string;
  reachFor: string[];
  notFor?: string[];
  runsIn: string;
  snippet?: { file: string; caption: string; runs: boolean; note?: string };
  api: { area: string; names: string[] }[];
  usedBy: string[];
  concepts: string[];
  /** Extra imports beyond the main entry. */
  subpaths?: { path: string; what: string }[];
  /** Packages it is built on. */
  builtOn: string;
  specs?: string;
}

export const libraries: Library[] = [
  {
    slug: "trust-core",
    name: "@toip-tools/trust-core",
    dir: "packages/trust-core",
    status: "ready",
    does: "Identities, signed and encrypted Trust Tasks over TSP, credentials, status lists and local policy.",
    about: `
The shared foundation for identities, messaging, credentials, and policy. An \`Identity\` combines an Ed25519 signing key, its \`did:key\` identifier, and a derived X25519 encryption key. An \`Endpoint\` sends Trust Tasks in TSP Direct messages. Each document carries a Data Integrity proof (\`eddsa-jcs-2022\`) and is encrypted for its recipient with HPKE. The receiver checks the signature, recipient, timestamp, and replay history before calling your handler.

The protocol implementation comes from the OpenVTC TypeScript libraries: \`@openvtc/vti-tsp-js\`, \`@openvtc/trust-tasks\`, \`@openvtc/trust-tasks-tsp\`, and \`@openvtc/trust-tasks-proof\`. Choose a \`Transport\` for delivery: the in-memory \`Bus\` for tests and demos, or \`RelayTransport\` for a WebSocket relay.
`,
    reachFor: [
      "Two parties need to exchange messages that prove who sent them and that only the recipient can read.",
      "You want request/response or one-way messages with typed payloads and signed refusals.",
      "You issue or check W3C-style credentials and revocation lists without a server.",
      "You want to decide locally with a Rego policy compiled to WebAssembly.",
    ],
    notFor: [
      "Resolving DID methods other than Ed25519 `did:key`. There is no resolver and no network lookup.",
      "Keys that must stay in WebCrypto or a secure element. The libraries need raw key bytes.",
    ],
    runsIn: "Browsers and Node 22.",
    snippet: { file: "trust-core.ts", caption: "A signed quote, request and response", runs: true },
    api: [
      { area: "Identity", names: ["identityFromSeed", "seedFrom", "resolveDidKey", "Identity"] },
      { area: "Messaging", names: ["Endpoint", "ourSpec", "Refusal", "TaskError", "Traffic"] },
      { area: "Transports", names: ["Bus", "RelayTransport", "Transport", "Delivery", "OutboxStore"] },
      { area: "Credentials", names: ["issueCredential", "verifyCredential", "signDocument", "verifyDocument", "Credential"] },
      { area: "Status lists", names: ["StatusList", "checkStatus", "isRevokedIn", "StatusListDoc"] },
      { area: "Sealing data for several readers", names: ["sealItem", "openItem", "resealText"] },
      { area: "Policy", names: ["Policies"] },
      { area: "Time and encoding", names: ["SystemClock", "DemoClock", "toB64u", "fromB64u", "canonicalJson"] },
    ],
    usedBy: ["shared-todo", "settle", "tipline", "agora", "agents", "trail", "capture", "mesh"],
    concepts: ["dids", "credentials", "tsp", "trust-tasks"],
    builtOn: "`@openvtc/*` for TSP and Trust Tasks, `@noble/*` for cryptography, `@open-policy-agent/opa-wasm` for Rego.",
  },
  {
    slug: "relay",
    name: "@toip-tools/relay",
    dir: "packages/relay",
    status: "ready",
    does: "A WebSocket mailbox that stores and delivers encrypted TSP messages.",
    about: `
A relay lets parties exchange messages even when they aren't online together. Devices authenticate with their \`did:key\` by signing a challenge bound to the relay's URL. Messages are delivered immediately to connected recipients and stored in SQLite until acknowledged, with limits per sender and recipient.

The relay can see sender and recipient identifiers, timing, and message sizes. Contents stay encrypted. It delivers TSP Direct messages; it does not implement TSP Routed Mode.
`,
    reachFor: [
      "Parties are often offline, and messages must wait for them.",
      "You want a transport you can run anywhere with Node and point clients at with one URL.",
    ],
    notFor: ["Hiding who talks to whom. The relay learns which DIDs connect, who messages whom, when and how much."],
    runsIn: "Node 22.13 or later (it uses `node:sqlite`). Clients use `RelayTransport` from trust-core, in browsers or Node.",
    snippet: { file: "relay.ts", caption: "Start a relay and connect to it", runs: true },
    api: [
      { area: "Server", names: ["startRelay", "Relay", "RelayOptions", "RelayLimits"] },
      { area: "Limits", names: ["MAX_MESSAGE_BYTES", "MAX_QUEUED_PER_RECIPIENT", "QUEUE_TTL_MS"] },
      { area: "Client (in trust-core)", names: ["RelayTransport", "RelayStatus", "OutboxStore"] },
    ],
    usedBy: ["shared-todo", "settle", "tipline", "agora", "agents"],
    concepts: ["tsp"],
    builtOn: "`ws`, `node:sqlite` and trust-core.",
  },
  {
    slug: "cose",
    name: "@toip-tools/cose",
    dir: "packages/cose",
    status: "ready",
    does: "Deterministic CBOR and COSE_Sign1, with Ed25519, P-256, WebCrypto and passkey signers.",
    about: `
Sign and verify compact binary messages. \`encodeCbor\` produces RFC 8949 Core Deterministic Encoding; \`decodeCbor\` requires that form by default. The COSE_Sign1 implementation (RFC 9052) accepts asynchronous signers, so keys can come from a seed, a non-extractable WebCrypto key, or a passkey.

The tests reproduce the COSE working group's Ed25519 example byte for byte and verify RFC 9052's ES256 example.
`,
    reachFor: [
      "A device signs readings or manifests and every byte counts (radio links, QR codes).",
      "The key lives in WebCrypto or a passkey and must never be exported.",
    ],
    notFor: ["Detached payloads and critical headers. They are refused as malformed."],
    runsIn: "Browsers and Node. The main entry has no Node-only imports.",
    snippet: { file: "cose.ts", caption: "Sign and verify a sensor reading", runs: true },
    api: [
      { area: "CBOR", names: ["encodeCbor", "decodeCbor", "Tagged", "DecodeCborOptions"] },
      { area: "Signers", names: ["seedSigner", "webCryptoSigner", "webAuthnSigner", "AsyncSigner", "ALG", "curveOf"] },
      { area: "COSE_Sign1", names: ["signCose1", "verifyCose1", "sigStructure", "KeyLookup", "VerifyResult", "CoseFailure"] },
    ],
    usedBy: ["capture", "mesh"],
    concepts: ["dids"],
    builtOn: "`cborg`, `@noble/curves` and `@noble/hashes`.",
  },
  {
    slug: "web-vault",
    name: "@toip-tools/web-vault",
    dir: "packages/web-vault",
    status: "ready",
    does: "Browser storage for identity seeds and account data, encrypted with a passkey or passphrase.",
    about: `
Keep a user's identity seed encrypted in their browser. The vault derives an AES-GCM key from a passkey's PRF output, or uses PBKDF2 with a passphrase when PRF is unavailable. Credentials, state, and receipts can share that encryption key, with each stored item bound to its account and name. A backup code restores the account in another browser.

The passkey unlocks the seed; signing happens with the seed in memory while the account is open.
`,
    reachFor: ["A browser app whose users hold their own keys.", "You need several apps on one origin, each with its own accounts."],
    notFor: ["Signing with the passkey itself. The seed is unsealed in memory while the account is open."],
    runsIn: "Browsers. Tests run in Node with stand-ins for storage and the authenticator.",
    snippet: { file: "web-vault.ts", caption: "Sign up with a passkey, fall back to a passphrase", runs: false, note: "Typechecked, not run: it needs a browser." },
    api: [
      { area: "Vault", names: ["createVault", "PasskeyUnsupported"] },
      { area: "Accounts", names: ["accounts", "createAccount", "unlock", "lockAll", "protect", "removeAccount", "passkeysAvailable"] },
      { area: "Sealed data", names: ["writeBlob", "readBlob", "writeJson", "readJson", "readState", "writeState", "storageKey"] },
      { area: "Keys and backups", names: ["putCryptoKey", "getCryptoKey", "backupCode", "seedFromBackup"] },
    ],
    usedBy: ["settle", "tipline", "agora", "capture"],
    concepts: ["dids"],
    builtOn: "WebAuthn, WebCrypto and trust-core.",
  },
  {
    slug: "mandates",
    name: "@toip-tools/mandates",
    dir: "packages/mandates",
    status: "ready",
    does: "Revocable delegation with spending limits, policy checks, and approvals.",
    about: `
A mandate is a signed credential that gives someone authority to act for a principal: a person, company, or device owner. It defines permitted actions, spending limits, expiry, and whether the delegate may pass on narrower authority. Anyone can check an action against the full delegation chain and receive **allow**, **escalate**, or **deny**, with an explanation.

Decisions run through a compiled Rego policy and record its hash so the same policy can be used in a later review. Trust Tasks carry approval requests to the designated approver; each approval authorizes one specific action.
`,
    reachFor: [
      "An AI agent spends money or sends messages for someone, within limits.",
      "A device acts for its owner: a camera that may sign photos only on assignment.",
      "A counterparty must check an agent's authority before doing work for it.",
    ],
    runsIn: "Browsers and Node.",
    snippet: { file: "mandates.ts", caption: "An owner limits what a camera may sign", runs: true },
    api: [
      { area: "Issuing", names: ["issueMandate", "delegate", "narrows", "mandateHash"] },
      { area: "Deciding", names: ["MandateEngine", "defaultEngine", "actionHash", "POLICY_ID", "DEFAULT_REQUIREMENTS"] },
      { area: "Explaining", names: ["explain", "REASON_CODES", "hasSentence"] },
      { area: "Approvals and presentations", names: ["approve", "verifyApproval", "present"] },
      { area: "Revocation and spend", names: ["StatusRegistry", "staticStatusResolver", "httpStatusResolver", "isRevoked", "SpendLedger"] },
      { area: "Profiles", names: ["SETTLE_1", "CAPTURE_1", "registerProfile", "getProfile"] },
      { area: "Trust Tasks", names: ["serveMandateTasks", "sendMandate", "notifyRevoked", "requestApproval", "grantApproval", "denyApproval"] },
    ],
    usedBy: ["agents", "capture"],
    concepts: ["credentials", "governance", "trust-tasks"],
    builtOn: "trust-core and a Rego policy compiled with OPA.",
    specs: "mandates",
  },
  {
    slug: "anon-membership",
    name: "@toip-tools/anon-membership",
    dir: "packages/anon-membership",
    status: "ready",
    does: "Prove group membership and attribute requirements without revealing which member you are.",
    about: `
A member proves that they belong to an accepted group and meet its attribute requirements, without revealing their membership record. Each proof is bound to a message and includes a *nullifier*: a value that stays the same for that member within a chosen scope. A verifier can use it to count distinct memberships or enforce one vote or pseudonym per membership.

Issuers maintain a Merkle tree of membership commitments and publish a signed root for each epoch in a hash-chained log. Proofs use a Noir circuit and Barretenberg's UltraHonk in zero-knowledge mode. This is experimental cryptography: that mode is **designed to be zero-knowledge**, but the library authors found no published proof of that property, and Noir is not yet intended for production use.
`,
    reachFor: [
      "Anonymous but gated speech: whistleblowing, forums for licensed professionals, resident-only polls.",
      "Rate limits or one-per-person rules without identifying anyone.",
    ],
    notFor: ["Selective disclosure of individual credential fields (BBS+, SD-JWT). This is group membership only."],
    runsIn: "Node and browsers, proving in a Web Worker. Proving takes about 0.15 s on an Apple M1 Max; phones aren't measured.",
    snippet: { file: "anon-membership.ts", caption: "An employee proves membership to a newsroom", runs: true },
    api: [
      { area: "Issuer", names: ["GroupIssuer", "enroll", "ENROLL", "EnrollRequest", "EnrollResponse"] },
      { area: "Member", names: ["memberSecret", "membershipInputs", "treeFromRoot", "scopeOf", "messageOf", "dayOf"] },
      { area: "Proving", names: ["MembershipProver", "MembershipVerifier", "parseMembershipProof", "CIRCUIT_ID", "vkHashOf"] },
      { area: "Accepting", names: ["acceptMembership", "AcceptPolicy", "NullifierBook"] },
      { area: "Trees and roots", names: ["GroupTree", "verifyPath", "checkRootLog", "findEquivocation", "GroupRoot"] },
      { area: "Hashing", names: ["initHashing", "poseidon2", "commitmentOf", "leafHash", "nullifierOf"] },
    ],
    subpaths: [{ path: "@toip-tools/anon-membership/worker", what: "serveMembershipWorker and MembershipWorkerClient, for proving off the main thread" }],
    usedBy: ["tipline", "agora"],
    concepts: ["zk"],
    builtOn: "Noir 1.0.0, Barretenberg's bb.js 6.0.0, Poseidon2 over BN254, and trust-core.",
    specs: "anon-membership",
  },
  {
    slug: "eventlog",
    name: "@toip-tools/eventlog",
    dir: "packages/eventlog",
    status: "ready",
    does: "KERI key histories and witnessed audit trails that make tampering detectable.",
    about: `
The library provides two append-only logs. A **key event log (KEL)** records a KERI identifier's inception, key rotations, interaction events, and witness receipts. Interoperability tests verify that KERIpy 1.3.6 derives the same key state. A **trail** is the toolkit's own audit log, controlled by a KERI identifier: signed headers commit to private entry bodies, and each key rotation seals the open trails.

Witnesses sign receipts for the first event they see at each position. Watchers compare histories to detect *duplicity*: conflicting signed versions. Exported bundles can be verified offline. Delegated identifiers, weighted thresholds, and KERI 2.0 are currently unsupported and rejected.
`,
    reachFor: [
      "An agent's or device's actions must be reviewable later, and the writer must not be able to rewrite history.",
      "Keys rotate, and old signatures must still verify against the key state of their time.",
      "You need KERI interop for key histories.",
    ],
    runsIn: "Browsers and Node. A file store and an HTTP witness are in the Node entry.",
    snippet: { file: "eventlog.ts", caption: "A witnessed trail across a key rotation", runs: true },
    api: [
      { area: "Writing", names: ["Controller", "Trail", "MemoryStore", "coldKeysFromSeed", "signerFromIdentity"] },
      { area: "Witnessing", names: ["Witness", "localWitnessClient", "httpWitnessClient", "serveWitnessTasks", "taskWitnessClient"] },
      { area: "Watching", names: ["Watcher", "verifyEvidence"] },
      { area: "Verifying", names: ["verifyKel", "verifyTrail", "verifySignature", "checkTrailRef", "keyAt", "isCurrentAt"] },
      { area: "Bundles and bindings", names: ["exportBundle", "verifyBundle", "makeBinding", "verifyBinding"] },
      { area: "Encodings", names: ["toStream", "fromStream", "toCompact", "fromCompact", "saidify"] },
    ],
    subpaths: [{ path: "@toip-tools/eventlog/node", what: "JsonFileStore, serveHttp and startWitness" }],
    usedBy: ["trail", "agents", "capture"],
    concepts: ["keri"],
    builtOn: "`@noble/curves`, `@noble/hashes` and trust-core.",
    specs: "trail",
  },
  {
    slug: "mesh-transport",
    name: "@toip-tools/mesh-transport",
    dir: "packages/mesh-transport",
    status: "ready",
    does: "Deliver TSP messages over LoRa radio or portable files when the internet is unavailable.",
    about: `
\`MeshTransport\` brings trust-core's \`Transport\` interface to radio links. Your \`Endpoint\` uses the same handlers as it would over a relay. On the air, fresh 4-byte address tags replace the visible TSP identifiers; the receiver reconstructs the original envelope. Trust Task bodies use CTT1, a compact CBOR encoding that preserves the signed document. A guest-pass presentation shrinks from about 1.8 KB to about 500 bytes.

Fragmentation, selective acknowledgements, and retries handle lossy, half-duplex links. A scheduler enforces configured regional airtime limits. Gateways forward the original TSP bytes to an internet relay, and portable bundle files provide delivery when no link is available.

Tests run on simulated radios. Adapters are implemented for a LoRaWAN gateway's packet forwarder (GWMP) and a RAK3172 module's AT commands; the Mesh project documents the remaining hardware bring-up.
`,
    reachFor: ["Trust interactions where there is no internet: a door, a cabin, a field sensor.", "Carrying sealed messages by hand until a gateway is back."],
    notFor: ["Hiding where you are. A transmitting radio can be located.", "Large payloads: a radio frame holds about 250 bytes."],
    runsIn: "Browsers and Node. The `/gwmp`, `/detect` and `/node` entry points are Node only.",
    snippet: { file: "mesh-transport.ts", caption: "A sealed Trust Task over simulated radios", runs: true },
    api: [
      { area: "Transport and gateway", names: ["MeshTransport", "MeshGateway", "ChallengeBeacon"] },
      { area: "Simulation (`/sim`)", names: ["SimMedium", "SimLink", "VirtualScheduler"] },
      { area: "Radios", names: ["GwmpServer", "GwmpLink", "RakP2PLink", "detectRadios"] },
      { area: "Off-line", names: ["exportBundle", "openBundle", "postBundle"] },
      { area: "Wire", names: ["splitTsp", "joinTsp", "encodePacket", "decodePacket", "fragment"] },
    ],
    usedBy: ["mesh", "capture"],
    concepts: ["tsp"],
    builtOn: "trust-core, `cborg`, `serialport` (Node only) and `@openvtc/vti-tsp-js`.",
  },
];

export const libBySlug = (s: string) => libraries.find((l) => l.slug === s)!;
