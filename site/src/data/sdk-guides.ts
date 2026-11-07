export interface SdkGuide {
  intro: string;
  tasks: { title: string; body: string; symbols: string[] }[];
  lifecycle: string[];
  errors: { name: string; behavior: string; handling: string }[];
}

export const sdkGuides: Record<string, SdkGuide> = {
  "trust-core": {
    intro: "Build signed Trust Task requests, credentials, and sealed messages around an Ed25519 `did:key` identity. `Endpoint` sends TSP Direct envelopes; sender and recipient metadata remain visible to a direct transport or relay.",
    tasks: [
      {
        title: "Send a request and register its handler",
        body: "Create an identity with `identityFromSeed` from a securely generated 32-byte seed, choose a clock, and provide a `Transport`. Construct an `Endpoint` for each identity, register `handle(spec, handler)`, then call `request(to, spec, payload)`. The response is a Trust Task document: read its `payload`. Return a `Refusal` from a handler to send a signed task error; return `undefined` for no response.",
        symbols: ["identityFromSeed", "SystemClock", "Transport", "Endpoint", "ourSpec", "Refusal"],
      },
      {
        title: "Connect through a mailbox relay",
        body: "Construct `RelayTransport({ url, identity, outbox })`, call `start()`, and pass it to `Endpoint`. The URL must match the relay's advertised authentication URL exactly. Observe `onStatus` and inspect `pending()` for local outbox state. `notify` returns a delivery status; `queued` means the transport retained or handed off the message, while only a request response confirms application processing.",
        symbols: ["RelayTransport", "OutboxStore", "Endpoint", "Delivery"],
      },
      {
        title: "Verify a credential and retain replay protection",
        body: "Use `issueCredential` to sign VC-shaped claims and `verifyCredential` to check their proof and validity window. Check revocation separately with `checkStatus`. For an endpoint that must remember executed requests across restarts, supply `PersistentReplayGuard` backed by a durable `ReplayStore`; await `ready()` to observe initialization failures before serving traffic.",
        symbols: ["issueCredential", "verifyCredential", "checkStatus", "PersistentReplayGuard", "ReplayStore"],
      },
    ],
    lifecycle: [
      "Keep identity seeds and secret keys in application-managed protected storage. `seedFrom(label)` is deterministic and intended for reproducible identities; it does not add entropy to a guessable label.",
      "Call `Endpoint.close()` to detach its receiver, clear request timers, and reject pending requests with `TaskError` code `closed`. Stop a separately owned `RelayTransport` with `stop()` and invoke unsubscribe callbacks from status or clock subscriptions.",
      "Relay outboxes and endpoint replay records are in memory unless you supply stores. Persist both where restarts must retain pending sends and duplicate-execution history; a replay guard's finite capacity can evict records.",
    ],
    errors: [
      { name: "TaskError: timeout / undelivered / closed", behavior: "A request rejects when its reply deadline expires, the destination cannot be resolved or reached, or the endpoint closes. A queued message may still arrive after a timeout.", handling: "Catch `TaskError` and inspect `code`. Reconcile uncertain outcomes before issuing a new action; use a longer per-request `timeoutMs` for slow transports." },
      { name: "TaskError: proofInvalid / remote refusal code", behavior: "An invalid response proof rejects with `proofInvalid`; signed task errors reject with the remote payload's code, including `unsupportedType` for an unregistered request type.", handling: "Reject untrusted responses and register the correct spec handler. Treat application refusal codes according to the receiving service's contract." },
      { name: "CredentialCheck: ok false", behavior: "Credential verification reports `signatureInvalid`, `issuerMismatch`, `malformedProof`, `notYetValid`, or `expired` through `failure`.", handling: "Branch on `ok` before using claims. Obtain a valid credential or correct clock/issuer configuration; proof validity alone does not establish revocation status or application authorization." },
    ],
  },
  relay: {
    intro: "Run a Node WebSocket mailbox for opaque sealed messages. The relay authenticates Ed25519 `did:key` clients and stores messages in SQLite until recipient acknowledgement or expiry. It sees sender, recipient, time, and message size.",
    tasks: [
      {
        title: "Start a durable mailbox",
        body: "Call `startRelay({ port, host, dbPath, publicUrl })` with an application-owned SQLite path. Use `port: 0` for an assigned local port and read the returned `port` and `url`. Set `publicUrl` to the exact externally reachable WebSocket URL when a proxy changes the address; clients sign that URL during authentication. The WebSocket route is `/v1`.",
        symbols: ["startRelay", "RelayOptions", "Relay"],
      },
      {
        title: "Bound recipient queues and observe acceptance",
        body: "Override `limits` to cap messages per sender/recipient, total recipient messages, recipient bytes, authentication timeout, and the unacknowledged delivery window. Use `queued(did)` to count stored messages and `onStored` to observe each accepted message's metadata. A `live` acceptance still remains stored until the recipient acknowledges it.",
        symbols: ["RelayLimits", "StoredMessage", "MAX_MESSAGE_BYTES", "MAX_QUEUED_PER_RECIPIENT"],
      },
    ],
    lifecycle: [
      "Await `Relay.close()` during shutdown. It stops the expiry interval, terminates sockets, closes the WebSocket server, and closes SQLite. The caller owns the database path, backup strategy, and deployment's TLS/proxy configuration.",
      "The queue survives a process restart when `dbPath` names a persistent file. Messages expire after `QUEUE_TTL_MS` (30 days); expiry runs at startup and hourly. Acknowledged messages are deleted.",
      "One active connection is retained per DID. A newer authenticated connection closes the previous one with WebSocket code 4002; clients should coordinate multiple tabs or processes using the same identity.",
    ],
    errors: [
      { name: "auth", behavior: "Protocol error frames report missing, repeated, or invalid authentication. An invalid signature closes the socket with code 4001; unauthenticated sockets also have a deadline.", handling: "Use the identity matching the claimed DID and sign the relay's fresh challenge with its exact public URL. Correct URL/proxy configuration before reconnecting." },
      { name: "queueFull", behavior: "A send is refused when any configured recipient queue limit would be exceeded. The error frame includes the send's `cid` when provided.", handling: "Retain the sealed message and retry after the recipient drains its mailbox. Trust-core's `RelayTransport` already retains these messages and schedules a retry." },
      { name: "malformed / tooLarge", behavior: "Bad JSON, unknown frames, invalid recipients, empty wire data, and oversized wire data are refused. Decoded messages may not exceed `MAX_MESSAGE_BYTES` (256 KiB).", handling: "Correct the frame or recipient and reduce oversized payloads before resending. Catch startup rejection separately for database or socket-listen failures." },
    ],
  },
  cose: {
    intro: "Encode deterministic CBOR and sign attached-payload COSE_Sign1 messages with asynchronous Ed25519, P-256, WebCrypto, or WebAuthn signers. Verification returns a result union for malformed or cryptographically invalid messages.",
    tasks: [
      {
        title: "Encode and decode deterministic CBOR",
        body: "Pass plain objects to `encodeCbor` for text-key maps; use `Map` for integer or mixed keys and `Tagged` for CBOR tags. `decodeCbor` checks deterministic encoding by default. Set `useMaps: true` when every map must remain a `Map`; use `strict: false` only when your input contract accepts other well-formed CBOR encodings.",
        symbols: ["encodeCbor", "decodeCbor", "Tagged", "DecodeCborOptions"],
      },
      {
        title: "Sign bytes and verify trusted candidate keys",
        body: "Create `seedSigner(seed, kid)` or await `webCryptoSigner(pair, kid)`, then call `signCose1(payload, signer, options)`. At verification, supply an explicit algorithm allowlist and a `KeyLookup` that returns trusted keys for the `kid` and algorithm. Consume `result.value.payload` only when `result.ok` is true. If using `externalAad`, both sides must supply the same bytes.",
        symbols: ["seedSigner", "webCryptoSigner", "signCose1", "verifyCose1", "KeyLookup"],
      },
      {
        title: "Use a passkey for signing",
        body: "Construct `webAuthnSigner` with the registered credential ID, relying-party ID, public key, and key ID. Each signature requests a WebAuthn assertion with user verification. Verify algorithm `-65600` with an explicit `webauthnOrigins` allowlist; successful verification includes origin and authenticator flags in `value.webauthn`.",
        symbols: ["webAuthnSigner", "verifyCose1", "WebAuthnInfo", "ALG"],
      },
    ],
    lifecycle: [
      "The package does not persist keys or provide a signer disposal method. Own seed storage, WebCrypto key persistence, and the trusted mapping from key IDs to public keys. A key ID is a lookup hint, not a trust decision.",
      "Keep external AAD alongside the protocol context needed to reproduce it; it is bound into the signature but not transmitted in the COSE message. Detached payloads and critical headers are unsupported.",
    ],
    errors: [
      { name: "malformed / algNotAllowed", behavior: "`verifyCose1` returns `ok: false` for bad COSE structure, unsupported critical headers or detached payloads, and algorithms outside the supported or configured set.", handling: "Reject the message. Update an allowlist only after deciding that the algorithm is permitted by your protocol." },
      { name: "keyMismatch / signatureInvalid", behavior: "`keyMismatch` means lookup produced no key of the required curve; `signatureInvalid` means no suitable candidate verified.", handling: "Check trusted key history and key ID mapping. Verify AAD agreement; never accept the payload merely because it decoded." },
      { name: "webauthnChallenge / webauthnOrigin / webauthnFlags", behavior: "Passkey verification fails if the challenge/type, allowed origin or RP hash, or required user-presence/user-verification flags do not match.", handling: "Correct registration and origin configuration or obtain a fresh assertion. Keep origin checks enabled. Catch WebAuthn prompt failures and `KeyLookup` exceptions separately; those can reject the promise." },
      { name: "CBOR decoding exception", behavior: "Strict `decodeCbor` throws for noncanonical encoding, duplicate or unordered keys, invalid UTF-8, unsupported values, and trailing bytes.", handling: "Catch decoding exceptions at input boundaries. Relax strictness only when the surrounding format allows it." },
    ],
  },
  "web-vault": {
    intro: "Seal browser account seeds and named blobs using a passkey's PRF output or a passphrase-derived AES-GCM key. Unlocked seeds and keys are available to application code in memory; storage encryption does not make the running tab a protected execution environment.",
    tasks: [
      {
        title: "Create, unlock, and back up an account",
        body: "Create one vault per app prefix with `createVault({ prefix, rpName })`. Call `createAccount(name, { kind: 'passkey' })`; handle `PasskeyUnsupported` with an explicit passphrase flow. After reload, select an entry from `accounts()` and call `unlock(account, passphrase?)`. Store `backupCode(unlocked)` securely; restore by checking `seedFromBackup(code)` and passing the resulting seed to `createAccount` with new protection.",
        symbols: ["createVault", "VaultConfig", "Unlocked", "PasskeyUnsupported"],
      },
      {
        title: "Persist account data and non-extractable keys",
        body: "Use the vault's `writeJson`/`readJson` for structured data and `writeBlob`/`readBlob` for bytes. Blob names use lowercase letters, digits, and dashes; `seed`, `accounts`, and `keys` are reserved. Use `putCryptoKey`/`getCryptoKey` for browser `CryptoKey` objects in IndexedDB. For a legacy account with a clear seed, call `protect` before relying on sealed writes.",
        symbols: ["Vault", "Account", "Protection"],
      },
    ],
    lifecycle: [
      "The vault keeps accounts unlocked until `lockAll()` or reload. `lockAll()` clears its internal map; it does not erase seeds or keys retained in application variables. Release those references when locking the UI.",
      "Account records and blobs use localStorage; CryptoKeys use the IndexedDB database `<prefix>.keys`. Choose a distinct prefix per app on an origin. The vault closes its own IndexedDB connections after transactions.",
      "Await `removeAccount(id)` for attempted CryptoKey cleanup as well as immediate localStorage removal. IndexedDB cleanup failures are swallowed by this method. Removing local records does not delete the authenticator's passkey. A seed backup restores the identity, not saved blobs or separate CryptoKeys.",
    ],
    errors: [
      { name: "PasskeyUnsupported", behavior: "Passkey creation or unlocking throws when the authenticator provides no usable PRF secret. `passkeysAvailable()` checks basic browser/domain support, not PRF capability.", handling: "Offer passphrase protection when creating an account. Distinguish unsupported PRF from user cancellation or other WebAuthn failures." },
      { name: "Unlock or blob-open exception", behavior: "Wrong protection produces an unlock error. `readBlob` and sealed `readJson` throw when data is altered, belongs to another account/name, or cannot decrypt; a missing blob returns `null`.", handling: "Preserve the stored record for recovery and request valid protection. Do not silently overwrite unreadable data. `readState` deliberately returns `null` for both missing and unreadable state." },
      { name: "Validation / storage exception", behavior: "Invalid prefixes or blob names, a passphrase shorter than eight characters, and writing byte blobs before protection throw. Browser storage and IndexedDB operations can also fail.", handling: "Validate user input, protect legacy accounts, and report persistence failures. A `null` result from `seedFromBackup` means the code has the wrong prefix or does not decode to a 32-byte seed." },
    ],
  },
  mandates: {
    intro: "Issue constrained delegation credentials and evaluate actions against a chain using the bundled OPA policy. Decisions are `allow`, `escalate`, or `deny`; the caller remains responsible for enforcing the decision, reserving spend, and recording approval use.",
    tasks: [
      {
        title: "Issue and narrow a delegation chain",
        body: "Create a `StatusRegistry` per issuer, allocate a status entry, and call `issueMandate` with a registered profile, constraints, validity, and delegation limits. A leaf subject can call `delegate(parentChain, identity, clock, options)` to tighten inherited constraints or add new dimensions. Check whether the result contains `mandate` or `problems`; nothing is signed when narrowing fails. Use `checkChain` before accepting a received chain.",
        symbols: ["StatusRegistry", "issueMandate", "delegate", "MandateEngine", "registerProfile"],
      },
      {
        title: "Decide and reserve an action",
        body: "Load `MandateEngine` once and call `decide` with the root-first chain, presenter DID, action, clock, status resolver, and leaf spend statement. Inspect `outcome` before acting. After `allow`, use `SpendLedger.tryReserve` for an atomic check/reservation of the leaf's own budgets; persist the ledger before performing the external action. Release a reservation only when the action failed before anything moved.",
        symbols: ["MandateEngine", "defaultEngine", "SpendLedger", "Decision", "staticStatusResolver", "httpStatusResolver"],
      },
      {
        title: "Present authority and handle approval",
        body: "Use `present` to sign a presentation with the exact action hash, chain, counterparty audience, approvals, and optional status hints. At the counterparty, call `verifyPresentation` with the authenticated transport sender and your own DID. For `escalate`, obtain `approve` from the designated chain issuer, reevaluate the exact action, and record consumed approval IDs in the ledger. Pass `usedApprovals` when calling `decide` to reject reuse.",
        symbols: ["present", "actionHash", "approve", "verifyApproval", "MandateEngine", "SpendLedger"],
      },
    ],
    lifecycle: [
      "Persist `StatusRegistry.save()` and `SpendLedger.save()` after changes and restore them through their constructors. Re-sign and publish status lists frequently enough for the strictest applicable freshness limit; status resolvers do not publish lists for you.",
      "The engine loads bundled policy WASM from disk in Node or fetches it in a browser; you may supply bytes to `MandateEngine.load`. Retain decisions with their policy hash and inputs when reproducible audit records are needed. No explicit engine disposal API is exposed.",
      "`verifyPresentation` checks approval signatures and bindings but has no `usedApprovals` option. The counterparty must enforce single use separately if required. Spend statements are supplied state, not an independently reconciled balance.",
    ],
    errors: [
      { name: "delegate: problems", behavior: "Delegation returns `problems` for broken linkage, malformed dimensions, or widening instead of issuing a child credential.", handling: "Inspect each reason's code, link, and dimension; revise constraints or obtain a new parent mandate. `issueMandate` instead throws for malformed root input." },
      { name: "status.unavailable / status.stale / status.revoked", behavior: "Decision reasons identify missing, old, or revoked status. Invalid signatures or list ownership produce `status.wrongIssuer`.", handling: "Refresh from the issuer and retry verification when appropriate. Revocation and structural failures cannot be cleared by an approval." },
      { name: "budget.exceeded / approval.used / approval.wrongAction", behavior: "The engine reports policy reasons in decisions; `tryReserve` returns budget reasons without reserving on failure. Approval checks bind to one exact action and track reuse only when supplied that state.", handling: "Require `allow`, reserve successfully before acting, and persist approval consumption. Use `explain` to present reason codes; do not treat `escalate` as authorization." },
    ],
  },
  "anon-membership": {
    intro: "Prove membership in one of up to four groups with scoped nullifiers and signal binding. UltraHonk's mode is designed to be zero-knowledge; this is experimental cryptography, and the package README states that Noir is not yet for production use.",
    tasks: [
      {
        title: "Enroll members and publish signed roots",
        body: "Await `initHashing()` before constructing trees or computing membership hashes. Create a `GroupIssuer`, register its admission callback with `serve`, and let members derive a per-group `memberSecret` and call `enroll`. Publish a signed root and snapshot once per epoch after enrollment changes. Enrollment after an epoch's publication becomes usable under a later published root.",
        symbols: ["initHashing", "GroupIssuer", "memberSecret", "enroll", "ENROLL"],
      },
      {
        title: "Build and prove the verifier's statement",
        body: "Rebuild a snapshot with `treeFromRoot`, then call `membershipInputs` with the member secret, ordered groups, verifier-agreed scope and signal, current day, and any required leaf fields/predicates. Reuse a `MembershipProver` from `create()` for successive `prove` calls. In a browser, use the `/worker` entry's `MembershipWorkerClient` and `serveMembershipWorker` to keep proving off the page thread.",
        symbols: ["treeFromRoot", "membershipInputs", "scopeOf", "messageOf", "dayOf", "MembershipProver"],
      },
      {
        title: "Accept a proof and enforce nullifier policy",
        body: "Create a `MembershipVerifier` with accepted artifacts. Call `acceptMembership` with pinned group issuers and verification-key hashes, verified-policy settings, fetched root logs, and a scope/signal you computed independently. It checks root history, freshness, anonymity-set size, statement, and proof. After acceptance, use `NullifierBook.has`/`label` for duplicate or rate-limit handling; acceptance itself does not record nullifier use.",
        symbols: ["MembershipVerifier", "acceptMembership", "AcceptPolicy", "NullifierBook"],
      },
    ],
    lifecycle: [
      "Reuse warmed prover/verifier instances and await their `destroy()` methods when finished to free Barretenberg resources. For a worker client, await `destroy()` to free its backends and terminate the worker. Browser threading depends on cross-origin isolation; otherwise proving uses one thread.",
      "Persist `GroupIssuer.state()`, member secrets and recorded leaf fields, root logs, snapshots, and `NullifierBook.state()` where continuity matters. The issuer defaults to retaining 30 recent snapshots; its state also contains member DIDs and commitments and needs access controls.",
      "The bundled CRS avoids third-party CRS downloads at proving time; artifacts still need to be packaged and served by the app. Pin verification keys out of band. Changing a circuit or acceptance policy requires coordinating member and verifier inputs.",
    ],
    errors: [
      { name: "MembershipError", behavior: "`membershipInputs` or `prove` throws when the member is absent or the witness fails membership, validity, predicates, or rate-limit constraints.", handling: "Check the published snapshot, enrollment leaf fields, current day, and message index. Refresh membership data rather than retrying the same unsatisfiable witness." },
      { name: "VerifyResult: malformed / unknownCircuit / statementMismatch / proofInvalid", behavior: "Low-level `MembershipVerifier.verify` returns `ok: false` for proof shape, unpinned artifact identity, an unexpected statement, or failed cryptographic verification.", handling: "Reject the proof and preserve the reason for diagnostics. Do not replace a pinned key or expected statement with values supplied by the prover." },
      { name: "Acceptance: stale / tooSmall / scope / signal / equivocation", behavior: "`acceptMembership` can reject a cryptographically valid proof on policy grounds. `equivocation` includes two conflicting signed roots as evidence.", handling: "Refresh roots for staleness, require the configured minimum set size, and recompute context locally. Preserve equivocation evidence and refuse that acceptance; use the full `AcceptReason` union for remaining failures." },
    ],
  },
  eventlog: {
    intro: "Maintain a signed key-event log and content-addressed trails with rotations, witness receipts, and duplicity evidence. The main entry is browser-safe; file persistence and Node HTTP helpers are exported from `@toip-tools/eventlog/node`.",
    tasks: [
      {
        title: "Create a controller and append a witnessed trail entry",
        body: "Choose hot signers, commit future keys using `coldKeysFromSeed` or explicit next-key digests, and call `Controller.incept` with a store and clock. Open a trail with `openTrail(purpose)`. Use `appendWitnessed` when an external action must wait for receipts; ordinary `append` only signs and stores locally. Publish to witness clients and inspect missing receipts and evidence.",
        symbols: ["Controller", "coldKeysFromSeed", "Trail", "MemoryStore", "httpWitnessClient"],
      },
      {
        title: "Rotate keys and recover a log",
        body: "Call `Controller.rotate` with the committed future signers or retained cold keys. Rotation seals trail heads automatically. For recovery, `cutAfter` cuts later trail entries, and `supersede` can replace interaction events with a rotation. Persist newly active signers from `signers()` securely. Passing `next: []` abandons the identifier and prevents further controller events.",
        symbols: ["Controller", "RotateOptions", "nextKeyDigest", "keyQb64"],
      },
      {
        title: "Verify history and disclose selected content",
        body: "Run `verifyKel` and `verifyTrail` on received history, then inspect problems and witness status. Use `checkTrailRef` with a witness client to verify a referenced entry, or `verifySignature` to distinguish a valid signature from its current/retired and anchored status. Export selected bodies or entries with `exportBundle` and verify received bundles with `verifyBundle`. A `Watcher` can ingest first-seen copies and poll witnesses for conflicting histories.",
        symbols: ["verifyKel", "verifyTrail", "checkTrailRef", "verifySignature", "exportBundle", "verifyBundle", "Watcher"],
      },
    ],
    lifecycle: [
      "Persist logs, bodies, receipts, and evidence through a `LogStore`. `MemoryStore.dump()` can be restored through its constructor, but it is not durable by itself. Node's `JsonFileStore` batches writes; call `flush()` or `close()` at shutdown to write pending changes.",
      "Keep cold-key material separate from current hot keys. `Controller.load` re-verifies stored logs; supplying hot keys supports appending and interacting, while rotation additionally needs committed future signers or matching cold keys.",
      "`Trail.close()` records a signed end-of-trail event. It is a protocol operation, not a resource cleanup call. `Watcher.poll()` is caller-driven; own and cancel any application polling timer and close HTTP servers/file stores that you create.",
    ],
    errors: [
      { name: "WitnessError", behavior: "`appendWitnessed` throws if fewer than `max(1, bt)` witness receipts are held. The newly appended entry remains in the local log, pending.", handling: "Do not perform the dependent external action. Inspect `details.missing`, retry publishing the existing entry, and reconcile its receipt state instead of appending a duplicate action." },
      { name: "Problem: unsupported / signatureInvalid / notWitnessed", behavior: "Verification reports structured problems with a code, message, and optional log/sequence location. Unsupported protocol features are identified separately from invalid signatures or missing witness thresholds.", handling: "Check result problems before accepting history. Fetch missing receipts or use a compatible implementation for unsupported features; do not bypass signature checks." },
      { name: "SubmitResult: duplicity / unknownController / clockSkew / invalid", behavior: "Witness submission can refuse history and may return receipts for messages accepted before the refusal. Duplicity may include the first-seen conflicting stream.", handling: "Retain valid partial receipts and conflicting evidence. Supply the controller KEL before its trails, correct clock skew, and investigate conflicts before acting. `Controller.publish` collects such failures in its report." },
    ],
  },
  "mesh-transport": {
    intro: "Carry sealed TSP bytes through simulated or LoRa links and courier bundles using trust-core's `Transport` contract. Simulation tests cover delivery and adapters; the README still identifies real-radio limits, sync-word format, and turnaround timing as assumptions to verify on hardware.",
    tasks: [
      {
        title: "Run a Trust Task over simulated radio",
        body: "Import `SimMedium` from `/sim`, create a `VirtualScheduler`, connect named nodes, and construct `MeshTransport` with local identities and links. Start it and pass it to trust-core's `Endpoint`; advance virtual time with `scheduler.run(requestPromise)`. Select trust-core's `ctt1` body codec only when `supportsCompact(peer)` is true, and size request deadlines using `suggestedTimeoutMs`.",
        symbols: ["MeshTransport", "VirtualScheduler", "plans", "regions", "MeshOptions"],
      },
      {
        title: "Configure a real link and diagnose delivery",
        body: "Choose matching regional/channel plans for both ends. Import `RakP2PLink` from `/rak` with a `/serial` Web Serial port or `/node` serial wrapper; Node's `/node` or `/gwmp` entry provides `GwmpServer` for a gateway packet forwarder. Monitor link state, mesh `onEvent`, and `stats()`. A GWMP link is not ready to send until the gateway has sent PULL_DATA, even though `open()` resolves.",
        symbols: ["Link", "LinkState", "plans", "MeshEvent", "MeshStats", "AirtimeBudget"],
      },
      {
        title: "Hand messages to a gateway or courier",
        body: "Create `MeshGateway` with a mesh identity, relay transport, and custody store, then call `start()`. A custody receipt means the gateway or its relay outbox has responsibility, not that the recipient opened the task. For manual delivery, export pending messages with `mesh.exportBundle({ sealTo: courierDid })`, open them with `openBundle(bytes, courier)`, and pass items to `postBundle` through a relay.",
        symbols: ["MeshGateway", "GatewayStore", "exportBundle", "openBundle", "postBundle"],
      },
    ],
    lifecycle: [
      "Call `Endpoint.close()` to detach its application receiver, stop `ChallengeBeacon` and `MeshGateway` timers/handlers, then await `MeshTransport.stop()` to cancel mesh timers, unsubscribe link listeners, and close owned links. Gateway stop does not stop the mesh or relay transport; stop those separately.",
      "Contacts, outbox, and gateway custody records default to memory. Supply durable stores, or Node's `/node` file stores, to retain routing/introduction and delivery state across restarts. Pair the endpoint with a persistent replay guard when duplicate execution must survive reboot.",
      "Keep queued and custody items until your application's reconciliation policy resolves them. Check `pending()` and receipt/application responses; a transport return value is not proof that an external action occurred. Hardware adapters require deployment verification; Bluetooth, RNode link behavior, DOWN/PUBLIC delivery, and reliable-link mode are not implemented.",
    ],
    errors: [
      { name: "Delivery: undelivered / queued", behavior: "`post` returns `undelivered` for unusable local identities, unsplittable or mismatched TSP envelopes, unresolved recipients without a gateway, oversized packets, or explicit delivery refusal. Unconfirmed transmissions can remain `queued` for retry.", handling: "Check local identity/contact keys, packet size, route, and link state. Use transport events and application replies to distinguish refusal from a message still awaiting delivery." },
      { name: "MeshEvent: dropped", behavior: "Drop reasons include `regulatory`, `send-failed`, `incomplete`, `signature`, and `intro-refused`; counts appear in `stats().dropped`.", handling: "Investigate airtime/channel configuration and hardware errors for send failures, loss/MTU for incomplete packets, and peer keys/admission policy for signature or introduction failures. Never bypass airtime limits to force a retry." },
      { name: "Bundle-open exception", behavior: "`openBundle` throws for malformed/truncated bundles or a sealed bundle without the correct courier identity. `postBundle` reports counts of accepted and refused items.", handling: "Keep the original bundle, use the intended courier key, and inspect refused counts before considering the handoff complete." },
    ],
  },
};
