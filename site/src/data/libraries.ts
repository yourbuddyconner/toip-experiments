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
The plumbing every project here shares. An \`Identity\` is an Ed25519 key with its \`did:key\`, and an X25519 encryption key derived from it, as the P2P Trust Stack derives them. An \`Endpoint\` sends and receives Trust Task documents as TSP Direct messages: each one is signed with a Data Integrity proof (\`eddsa-jcs-2022\`), sealed to the recipient with HPKE, and checked on arrival for signature, addressing, freshness and replay before your handler runs.

It wraps the OpenVTC TypeScript libraries (\`@openvtc/vti-tsp-js\`, \`@openvtc/trust-tasks\`, \`@openvtc/trust-tasks-tsp\`, \`@openvtc/trust-tasks-proof\`) rather than reimplementing TSP. Messages travel over a \`Transport\`: the in-memory \`Bus\` for tests and demos, or \`RelayTransport\` for a real relay.
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
    does: "A mailbox for sealed TSP messages. It sees who writes to whom, never what.",
    about: `
A WebSocket server that holds sealed messages until their recipient collects them. Devices sign in as their \`did:key\` by signing a challenge bound to the relay's URL. The relay delivers live when the recipient is connected, keeps the message in SQLite until the recipient acknowledges it, and applies per-sender and per-recipient limits.

It is this repository's stand-in for the stack's own transports. It is not TSP Routed Mode and not the P2P Trust Stack's libp2p relays.
`,
    reachFor: [
      "Parties are often offline, and messages must wait for them.",
      "You want a transport you can run anywhere with Node and point clients at with one URL.",
    ],
    notFor: ["Hiding who talks to whom. The relay learns which DIDs connect, who messages whom, when and how much."],
    runsIn: "Node 22.5 or later (it uses `node:sqlite`). Clients use `RelayTransport` from trust-core, in browsers or Node.",
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
Small signed binary messages. \`encodeCbor\` writes RFC 8949 Core Deterministic Encoding, and \`decodeCbor\` refuses anything that isn't in that form unless you ask it not to. \`signCose1\` and \`verifyCose1\` implement COSE_Sign1 (RFC 9052) with async signers, so the key can be a seed, a non-extractable WebCrypto key, or a passkey.

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
    does: "Keeps an account's identity seed in the browser, sealed by a passkey or a passphrase.",
    about: `
A web app that holds its users' keys has to keep them somewhere. The vault seals the identity seed with an AES-GCM key from a passkey's PRF output (Touch ID, Windows Hello, a security key), or from a passphrase through PBKDF2 when the passkey can't do PRF. Other data for the account (credentials, state, receipts) is sealed under the same key and bound to the account and its name. A backup code restores the account in another browser.

It was Settle's vault, moved into a package so other apps can share it.
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
    does: "Delegation credentials: bounded, revocable authority that can only narrow down a chain.",
    about: `
A principal (a person, a company, a device owner) gives a delegate (an agent, a sub-agent, a camera) a mandate: a signed credential saying what it may do, how much it may spend, until when, and whether it may pass on a narrower mandate. Anyone can check an action against the whole chain on their own and get **allow**, **escalate** or **deny**, with reasons and plain sentences.

The decision runs a compiled Rego policy, and every decision carries the policy's hash, so it can be re-run later. Escalations go to the right approver over Trust Tasks, and an approval clears exactly one action.
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
    does: "Prove you belong to a group, and meet its rules, without saying which member you are.",
    about: `
A member proves: "I am in one of these groups, my attributes meet these predicates, and this is my nullifier for this scope", bound to one message. The verifier learns that the statement is true and gets a nullifier that is the same each time this member acts in this scope, so it can count distinct members and enforce one vote or one pseudonym per person. It doesn't learn which member.

Issuers keep a Merkle tree of commitments and sign one root per epoch in a hash-chained log. Proofs are UltraHonk (Barretenberg) over a Noir circuit, always in zero-knowledge mode. That mode is **designed to be zero-knowledge**; the library's authors found no published proof that it is, and Noir says it is not yet for production use.
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
    does: "KERI key event logs and signed, witnessed audit trails that their writer can't quietly change.",
    about: `
Two kinds of append-only log. A **KEL** is a KERI 1.0 key event log for one identifier (an AID): inception, rotations with pre-rotation, interaction events, witness receipts. KERIpy 1.3.6 computes the same key state from these logs; the tests hand them to KERIpy to check. A **trail** is this repository's own audit log, owned by an AID: each entry is a small signed header committing to a private body, and a key rotation seals every open trail.

Witnesses receipt the first version they see at each position, watchers compare versions and record duplicity, and bundles verify offline. Delegated identifiers, weighted thresholds and KERI 2.0 are refused as unsupported.
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
    status: "in progress",
    does: "TSP and Trust Tasks over LoRa radio, Bluetooth LE and files carried by hand.",
    about: `
Being built now, from the Mesh design. It will implement trust-core's \`Transport\` over radio links: a compact form of Trust Task documents that keeps every proof valid, the TSP envelope replaced on the air by random-looking address tags and rebuilt byte for byte on arrival, fragmentation and retries for lossy links, routes through gateways to the internet relay, and airtime budgets that keep to each region's rules. Every test runs on a simulated radio.

The API below is the design's (section 19.1), not code you can import yet.
`,
    reachFor: ["Trust interactions where there is no internet: a door, a cabin, a field sensor."],
    notFor: ["Hiding where you are. A transmitting radio can be located."],
    runsIn: "Planned: browsers and Node, with Node-only adapters for serial radios.",
    api: [
      { area: "Transport (planned)", names: ["MeshTransport", "MeshOptions", "MeshEvent"] },
      { area: "Time (planned)", names: ["Scheduler", "realScheduler", "VirtualScheduler"] },
      { area: "Radio (planned)", names: ["Link", "LoRaSetting", "ChannelPlan", "loraAirtimeMs", "plans", "regions"] },
      { area: "Stores (planned)", names: ["Contact", "ContactStore", "MeshOutboxStore", "memoryContacts", "memoryOutbox"] },
    ],
    usedBy: ["mesh", "capture"],
    concepts: ["tsp"],
    builtOn: "Planned: trust-core, `cborg`, `@noble/*` and `@openvtc/vti-tsp-js`.",
  },
];

export const libBySlug = (s: string) => libraries.find((l) => l.slug === s)!;
