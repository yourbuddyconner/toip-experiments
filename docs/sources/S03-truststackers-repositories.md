# S03: TrustStackers repositories (the P2P Trust Stack's own code)

URL: https://github.com/TrustStackers. Repositories: `p2p-trust-stack` (the `@p2p-trust-stack/core` and `@p2p-trust-stack/app-api` packages, 0.2.0 on npm), `utility-server`, `bootstrap`, `agent-app`, `agent-app-mobile`.
Read: 2026-11-05. Shallow clones in a scratch directory. Only the top-level README, file lists and two file headers were read, then the clones were deleted. Trust: primary, but barely read.

## What it says

- This is the P2P Trust Stack's implementation, in TypeScript. `core` holds the protocol engine (crypto, `did:peer:4` and `did:scid:vh`, an encrypted SQLite keystore, "TSP v3", libp2p transport, relationships and OOBI, VTCs and VRCs, a policy engine, Trust Task support). `app-api` holds `createAgentStack()` and typed domains (identity, relationships, messaging, credentials, communities, names, profiles, contexts, delegations).
- Node 22.5 or later only (`node:sqlite`). "There is no browser build."
- Its policy engine is its own structured JSON document format (`LocalPolicyEngine`, `engine: 'p2pts'`), projected onto "the trusttasks.org decision vocabulary". It is not Rego. That corrects S02's inference, which came from the trusttasks.org registry's `policy/upsert` spec, not from this code.
- **License: GPL-3.0-only, or a commercial license.**

## Decision

Not used. The convener doesn't want GPL code in this repository (2026-11-05). Don't depend on these packages or copy from them. Community Rides stays on the Apache-2.0 OpenVTC libraries (S02), which implement the same ToIP specs. Whether the two implementations interoperate on the wire was not checked.
