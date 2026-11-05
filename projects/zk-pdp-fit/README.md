# zk-pdp fit

Ideation, not research yet: applying zero-knowledge proofs to the P2P Trust Stack, starting from zk-pdp. Notes only. No code.

zk-pdp (`~/code/zk-pdp`, github.com/yourbuddyconner/zkPDP) compiles Cedar policies to zero-knowledge circuits, so a client can decide a policy over signed facts and prove the decision. At IIW on 2026-11-05, the zk-pdp session's view was that client-side proving is too slow today for web authorization, and may be viable in 1 to 3 years. In the P2P Trust Stack session that followed, the convener's view was that client-side proving fits peer-to-peer trust better: there is no central decision point, peers hold their own credentials, and trust interactions are rarer, so a few seconds of proving matters less. zk-pdp was at commit `24a19db` when this started.

1. `ideas.md`: the opportunities, with what each needs.
2. `open-questions.md`: what to ask the P2P Trust Stack people, and our own unknowns.
3. `reuse.md`: what already exists in zk-pdp, with paths and its commit.

Sources are in the shared `docs/sources/`. S01 is a summary only. S02, read later, corrects parts of it: see "Corrections from S02" in `ideas.md`.
