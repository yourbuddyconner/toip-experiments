# S02: Trust Tasks registry, OpenVTC libraries, and the stack's pages in full

Read: 2026-11-05, after IIW day 3.

## What was read, and how

- **The stack's Layer 3 and Layer 4 pages and the glossary** (`https://www.fpndtg.com/stack/layer3-tasks.html`, `.../layer4-applications.html`, `/developers/glossary.html`). Read through a fetch tool that summarizes pages. Trust: summary only, but a fuller summary than S01.
- **The trusttasks.org registry.** The site is a single-page app. Its data files were downloaded and searched directly: `/assets/tasks.generated.js` (12 MB, every spec's metadata and schemas), `/assets/data.js`, `/assets/ceremonies.js`, `/assets/libraries.js` and `/assets/ecosystem.js`. Trust: primary for what the registry *publishes*. It does not say which tasks are implemented anywhere.
- **npm packages**, installed in a scratch directory with `--ignore-scripts` and their READMEs and type declarations read: `@openvtc/trust-tasks` 0.28.17, `@openvtc/trust-tasks-tsp` 0.1.2, `@openvtc/trust-tasks-proof` 0.1.6, `@openvtc/vti-tsp-js` 0.2.0 (0.4.0 is the latest). Trust: primary for the packages' stated APIs. Not run.
- **GitHub repository metadata** through `gh repo view`: `OpenVTC/openvtc`, `OpenVTC/verifiable-trust-infrastructure`, `OpenVTC/dtg-credentials`, `trustoverip/dtgwg-trust-tasks-tf`. All public, mostly Rust, updated on 2026-11-05. The code itself was not read.

## What it says

### The stack (corrects and adds to S01)

- Layer 4 "has not started". The Personal Network Manager is "modeled in" the Agent App, and the Community Network Manager is "covered by" the Utility Server. Both are references, not products.
- Planned developer tooling: a TypeScript SDK for Layer 2, a REST API for VTA, VTC and VRC management, webhooks, and simulation tools.
- Built in Layer 3: an M-of-N co-signed VRC type, `createVtc()`, `issueVrc()`, `verifyVrc()`, a minimal governance document, and a personhood ceremony in the testbed. Membership flows, OOBI invitations and general governance are planned.
- Glossary: VIDs are `did:peer:4` in the current implementation. X25519 keys are derived from Ed25519 keys. HPKE-Auth uses X25519 and ChaCha20/Poly1305. An OOBI is a small non-secret JSON object (VID and transport address) shared by QR code or link.

### The Trust Tasks registry

- About 1,400 spec entries across categories including `vtc` (367), `vta` (221), `rooms` (107), `persona` (57), `voting` (25), `policy` (14), `acl`, `consent`, `credential-exchange`, `vrc` and `vtn` (Verifiable Trust Networks, which federate communities).
- The framework envelope is at `trust-task/0.6.0`. A document has `id`, `type` (a spec URI such as `https://trusttasks.org/spec/vtc/endorsements/issue/0.1`), `issuer`, `recipient`, `issuedAt`, `expiresAt`, an optional `proof`, and the payload. Responses use the type URI with `#response`.
- One ceremony definition: `vtc/member-onboarding/0.1` (application, decision, and the reciprocal membership credential), status draft.
- **The policy engine is Rego.** `policy/upsert` 0.3: "Create or update a Rego policy module on the maintainer". `policy/evaluate` and `vtc/policies/test` dry-run decisions.
- **Zero-knowledge proofs are already in use.** In "hidden vetting", `vta/pcs/prove` 0.1 has a member's VTA prove "that distinct eligible vetters attested for it", bound to a single-use challenge from `vtc/vetting/pcs-challenge`. The proof system is not named in what was read.
- Tasks relevant to a community app: `vtc/join-requests/submit` 0.3, `vtc/endorsements/issue` 0.1 (a DTG Verifiable Statement Credential under a registered predicate such as `https://registry.trustoverip.org/dtg/vsc/endorses/1`, with a status-list slot for revocation), `vtc/endorsement-types/register`, `vtc/roles/define`, `vtc/directory/introduce` (introductions through a fresh pairwise DID; "The answer is always `accepted`, so the request reveals nothing"), `vtc/rooms/community/create`, `rooms/records/put`, `vrc/relationships/issue`, `vtc/relationships/revoke`, `peer-check/ask`, `credential-exchange/present` (OID4VP), `vtc/recognition/check`.

### The TypeScript libraries

- `@openvtc/vti-tsp-js`: pure TypeScript TSP, "byte-compatible with affinidi-tsp", on `@noble`. No WebCrypto, no WASM. Runs in browsers, Node and React Native. `pack` and `unpack` for Direct messages, and `packRouted` and `packNested` for Routed and Nested ones. VID-to-key resolution is left to the caller.
- `@openvtc/trust-tasks`: generated payload types for every spec, plus `consumeInbound`, the SPEC §7.2 consumer pipeline (freshness, replay guard, proof policy, payload policy), and `respondWith` and `rejectWith`. The prebuilt per-spec modules are deprecated in favor of pinning tasks in `trust-tasks.lock` and generating them with `@openvtc/trust-tasks-gen`.
- `@openvtc/trust-tasks-tsp`: `packTrustTask` and `TspConsumer`, which seal a Trust Task document as a Direct TSP message and run the pipeline on receipt. It depends on `@openvtc/vti-tsp-js` `^0.2.0`.
- `@openvtc/trust-tasks-proof`: W3C Data Integrity proofs, `eddsa-jcs-2022` and `ecdsa-jcs-2019`, with keys carried as `did:key` verification methods. `signTrustTask` and `DataIntegrityProofVerifier`.
- Also on npm, not inspected: `@openvtc/pnm-core`, `@openvtc/rp-sdk`, `@openvtc/vti-rooms-wasm` (MLS data rooms in the browser), `@openvtc/vti-didcomm-js`, `@openvtc/trust-tasks-capability-client`.
- Implementations of the same framework also exist in Rust (`trust-tasks-rs`), Go and Dart.

## Caveats

- These are fast-moving: several packages changed on the day they were read. Pin versions.
- What a spec publishes is not what any server implements.
