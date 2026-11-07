# TOIP Experiments

A monorepo of ideas and working builds for the Trust over IP (ToIP) model and the P2P Trust Stack: a toolkit of shared libraries, and projects built on it. Each project stands on its own.

The developer site is https://toip.tools: a quickstart, concepts, a page per library and per project, and a page for every Trust Task type defined here.

## Get started

```bash
npm install
npm test          # every package and project
npm run settle    # or agents, agora, capture, mesh, tipline, trail: each prints its URLs
```

## Projects

| Project | What | State | Run |
|---|---|---|---|
| `projects/settle/` | An open payments layer: a Trust Task vocabulary for conditional payments, a 2-of-3 stablecoin escrow on Solana that nobody controls alone, a processor and arbiter, payment links and hosted checkout. | Working. Local Solana cluster, or devnet, where the program is deployed. | `npm run settle` |
| `projects/agents/` | Passports and mandates for AI agents. Agents hire people and other agents on Settle; a guard checks every action against the mandate chain, escalates to a human for one exact action, and records everything in a witnessed audit trail. | Working, with scripted models (real Claude models with an API key). | `npm run agents` |
| `projects/trail/` | Verifiable audit trails: KERI key event logs with witnesses and watchers, an explorer, and a red team whose tampering, forks, rogue witness and stolen key are all caught. Checked against KERIpy. | Working. | `npm run trail` |
| `projects/tipline/` | A whistleblower drop box. A source proves "I'm a member of this organization" with a zero-knowledge proof, without saying which member, sends a tip, and reads replies with a code kept on paper. | Working. | `npm run tipline` |
| `projects/agora/` | Credential-gated anonymous forums: "only licensed RNs post here". One pseudonym per person per forum, unlinkable across forums, with secret polls and moderation by pseudonym. | Working. | `npm run agora` |
| `projects/capture/` | Cameras and sensors with identities: signed photos with edit chains and verifiable redaction, signed sensor readings over a simulated LoRa link, and a verifier for any file (C2PA files included). | Working. | `npm run capture` |
| `projects/mesh/` | Trust Tasks without the internet: over LoRa radio and on a USB stick. A guest pass checked at a door offline, a Settle attestation relayed by a gateway, and a radio visualizer. | Working on a simulated radio; real-radio steps in `HARDWARE.md`. | `npm run mesh` |
| `projects/shared-todo/` | A shared to-do list with no trusted server, showing the basic ToIP ideas. Built first. | Working (decision 0004). | `npm run dev` |
| `projects/zk-pdp-fit/` | Applying zero-knowledge proofs to ToIP, starting from zk-pdp (`~/code/zk-pdp`), which compiles Cedar policies to circuits. | Notes only. | |
| `projects/commons/` | Apps for an apartment building: guest passes with a door kiosk, expenses, maintenance requests, votes, a board, lists. | Design only. | |
| `projects/community-rides/` | A ride-share app for a local community, on the OpenVTC TypeScript libraries for TSP and Trust Tasks. | Design only. | |

Each project has its own `README.md` and a design in `docs/design.md`. Most have `npm run demo --workspace <project>` (a narrated terminal run) and `npm run e2e --workspace <project>` (the app in a real browser).

## Libraries

Shared code lives in `packages/` (decisions 0003 and 0006):

| Package | What |
|---|---|
| `packages/trust-core/` | did:key identities, signed and encrypted Trust Tasks over TSP, credentials, status lists, local policy, and a compact wire form. |
| `packages/relay/` | A DID-authenticated mailbox for sealed TSP messages. |
| `packages/cose/` | Deterministic CBOR and COSE_Sign1 with Ed25519, P-256 and passkey signers. |
| `packages/web-vault/` | Keeps an account's key in the browser, sealed by a passkey or a passphrase. |
| `packages/mandates/` | Delegation credentials that can only narrow, with a decidable constraint language, budgets, approvals and revocation. |
| `packages/anon-membership/` | Zero-knowledge group membership (Noir): prove you're in a group and meet its rules without saying who you are. |
| `packages/eventlog/` | KERI-compatible key event logs and witnessed audit trails. |
| `packages/mesh-transport/` | TSP and Trust Tasks over LoRa radio and files carried by hand. |

## Shared

- `docs/provenance.md`: how sources, decisions and the notebook are kept. It applies to every project.
- `docs/sources/`: what we read about the stack, and how reliable that reading is.
- `docs/decisions/`: numbered records of choices that change direction, across projects.
- `docs/notebook/`: one dated file per working day, append-only.

## How it started

At IIW on 2026-11-05, after sessions on zk-pdp and on the P2P Trust Stack. The repository began as the zk-pdp thread and became a monorepo when the convener wanted to try other ideas on the stack (decision 0001).
