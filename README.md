# zk-toip

Ideation, not research yet: where the zk-pdp approach could fit the Trust over IP (ToIP) model and the P2P Trust Stack.

zk-pdp (`~/code/zk-pdp`, github.com/yourbuddyconner/zkPDP) compiles Cedar policies to zero-knowledge circuits, so a client can decide a policy over signed facts and prove the decision. This repository keeps the ideas about applying that to peer-to-peer trust apart from zk-pdp's research record.

## Why

At IIW on 2026-11-05, the zk-pdp session's view was that client-side proving is too slow today for web authorization, and may be viable in 1 to 3 years. In the P2P Trust Stack session that followed, the convener's view was that client-side proving fits peer-to-peer trust better. There is no central decision point, peers hold their own credentials, and trust interactions are rarer, so a few seconds of proving matters less.

## Start here

1. `docs/ideas.md`: the opportunities, with what each needs.
2. `docs/open-questions.md`: what to ask the P2P Trust Stack people, and our own unknowns.
3. `docs/reuse.md`: what already exists in zk-pdp, with paths and its commit.
4. `docs/sources/`: what we read about the stack, and how reliable that reading is.
5. `docs/notebook/`: one dated file per working day, append-only.

## Status

Notes only. No code. zk-pdp was at commit `24a19db` when this started.
