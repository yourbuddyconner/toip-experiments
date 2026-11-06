# Settle

An open payments layer for the Trust over IP world: conditional payments between parties who don't trust each other, settled in stablecoins by an escrow that nobody controls alone, not even the processor.

Design: `docs/design.md`. Status: working on a local Solana chain.

## Run the demo

```bash
npm install                                 # at the repository root
npm run demo --workspace @zk-toip/settle
```

The demo plays a repair job twice, end to end:
- **The job gets done:** Joe the plumber invoices the landlord with his contractor license as a credential. They agree terms, and the landlord funds a USDC escrow. Alice, the tenant, attests the work is complete. The landlord's policy refuses to pay until the 7-day dispute window has passed. Then two signatures release the money: Joe gets 336.60, and the processor its 1% fee.
- **The job isn't done right:** Alice reports a leak. The landlord disputes, and Settle Arbitration rules a split. Two signatures carry out the ruling: Joe gets 198.00 and the landlord 140.00 back.

After each story, the demo shows the on-chain balances, what anyone watching the chain could see (unlinked payment keys, amounts, a terms hash; no DIDs or purposes), and a check of the processor's transparency log.

Everything is real except the network and the money:
- **The escrow program:** compiled Rust, running in LiteSVM, a Solana VM inside the Node process, with the real SPL Token program and Ed25519 precompile.
- **The messaging:** real TSP messages through a local copy of the relay from `packages/relay`.
- **The money:** test USDC.

## What's here

| Path | What |
|---|---|
| `program/src/lib.rs` | The escrow program. `open` funds an escrow for a terms hash. `resolve` pays `n` to the payee, minus the agreed fee, and the rest back to the payer, given a quorum of Ed25519 signatures over `settle/v1\|program\|escrow\|pay:n\|evidence:hash`. `reclaim` lets the payer alone take everything back after the deadline. |
| `program/dist/`, `program/keys/` | The compiled program and its development keypair, so the TypeScript side runs without the Solana toolchain. |
| `src/chain/` | The client: addresses, instruction encoding, Ed25519 instructions, LiteSVM wrapper (`Simnet`), and fee sponsorship (a party signs its part; the processor checks, co-signs as fee payer, submits). |
| `src/protocol/` | Terms, each party's acceptance, payment-key bindings, attestations, disputes, rulings, evidence, receipts. The Trust Task types, the `attested-completion/1` Rego policy, and the transparency log. |
| `src/agents/` | Payer, payee, attester, arbiter and processor, each a trust agent on the relay that decides for itself. |
| `src/world.ts`, `src/demo.ts` | The repair job's cast, and the narrated demo. |

## How it fits together

1. **Identity off-chain, fresh keys on-chain.** Each party has a ToIP identity (`did:key`). For each payment it derives a fresh Ed25519 key, which is also a Solana address. It binds the key to its DID with a credential that only the other parties see. The chain sees unlinked keys.
2. **Terms.** Both parties sign the terms, and the escrow stores their hash, so everything off-chain is pinned to the escrow.
3. **Every signer decides for itself.** Before signing a release, each party's device runs the payment's Rego policy over the signed evidence: attestations, disputes, rulings. The chain enforces only that 2 of 3 named keys signed the same outcome.
4. **Signed messages, not co-signed transactions.** Parties sign outcome messages whenever they're ready, even hours apart. The processor submits them with Ed25519 verification instructions, and the program checks them by introspection.
5. **The processor never holds funds.** It pays fees, logs everything to a hash-chained log whose head it signs, and takes the fee the terms agreed.

## Tests

```bash
npm test --workspace @zk-toip/settle    # 26 tests
npm run build:program --workspace @zk-toip/settle   # rebuild the program (needs Rust and Agave's cargo-build-sbf)
npm run policies --workspace @zk-toip/settle        # recompile the Rego (needs opa)
```

The tests cover:
- **The program**, against the compiled binary: opening, releasing, splitting and refunding; refusing one signature, a duplicated key, an outsider's key, a signature over a different outcome or escrow, a second resolution, a token account the payee doesn't hold, and a reclaim before the deadline; and opening even when someone pre-funded the escrow's address to block it.
- **The documents and the policy.**
- **The end-to-end flows** over a real relay: the paid job, the arbiter's split, the reclaim, the transparency log, refused terms with a swapped arbiter, and a stranger's signature ignored.

## Not yet

- A web UI. The demo is a terminal script.
- Solana devnet. The program and client are chain-ready, but only LiteSVM is wired up.
- Base, the second rail (design §11).
- Guarantees and bonds.
- A payee-protecting timeout (design §13).
