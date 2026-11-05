# What exists in zk-pdp

Paths are in `~/code/zk-pdp`, at commit `24a19db` or later. Depend on them at a pinned commit rather than copying them.

| What | Where | State |
|---|---|---|
| Cedar to Noir compiler | `bench/compiler` | 5 of 7 sample policy sets. No dates, arithmetic or tags. 40 of 40 requests match Cedar. |
| The same compiled policy on GordieHowe | `bench/gordiehowe/policy.cc` | 43 ms native proving. Runs in Chrome at about 1.2 s once warm, one policy tried (E12). |
| Record commitment and fixed layout | `bench/envelope`, decision 0026 | Merkle tree over fixed-shape records. Ancestor lists hold Cedar's `in`. |
| Signed facts, P-256 | `bench/circuit/tinytodo_signed`, decision 0025 | 415,020 gates, 2.07 s. |
| Signed facts, Ed25519 | `bench/circuit/ed25519`, `bench/circuit/tinytodo_signed_ed25519`, decision 0027, E13 | Our own verifier, unaudited. 801,516 gates, 4.1 s. RFC 8032 tests 1 to 3 pass. |
| Browser proving page | `bench/web` | Noir in Chrome, 4 to 8 s. GordieHowe page under `bench/web/gordiehowe`. |
| AuthZEN envelope | `docs/protocol.md` | The proof rides in the response's `context`. |

Caveats carried over: unreviewed, one laptop, and no published proof that Noir's or RISC Zero's proofs are zero-knowledge. The compiler is tested, not proved.
