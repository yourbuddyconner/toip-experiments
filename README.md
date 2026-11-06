# TOIP Experiments

A monorepo of ideas and straw-man builds for the Trust over IP (ToIP) model and the P2P Trust Stack. Each project stands on its own.

## Projects

| Project | What | State |
|---|---|---|
| `projects/zk-pdp-fit/` | Applying zero-knowledge proofs to ToIP, starting from zk-pdp (`~/code/zk-pdp`), which compiles Cedar policies to circuits. | Ideation, notes only. |
| `projects/shared-todo/` | A shared to-do list with no trusted server, showing the basic ToIP ideas. Built first. | Working web app with a relay (v2, decision 0004). |
| `projects/community-rides/` | A straw-man ride-share app for a local community, built on the Apache-2.0 OpenVTC libraries for TSP and Trust Tasks. For show and tell. | Design written, not built. |

Each project has its own `README.md`. A project may be notes only, or notes and code.

Code shared between projects lives in `packages/`: `packages/trust-core/` holds the trust plumbing (decision 0003), and `packages/relay/` is the DID-authenticated message relay.

Run `npm install`, then `npm run dev` to start the relay and the Shared To-Do app.

## Shared

- `docs/provenance.md`: how sources, decisions and the notebook are kept. It applies to every project.
- `docs/sources/`: what we read about the stack, and how reliable that reading is.
- `docs/decisions/`: numbered records of choices that change direction, across projects.
- `docs/notebook/`: one dated file per working day, append-only.

## How it started

At IIW on 2026-11-05, after sessions on zk-pdp and on the P2P Trust Stack. The repository began as the zk-pdp thread and became a monorepo when the convener wanted to try other ideas on the stack (decision 0001).
