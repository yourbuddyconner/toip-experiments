# Settle

An open payments layer for the Trust over IP world. Conditional payments between parties who don't trust each other, settled in stablecoins on Solana by an escrow nobody controls alone, not even the processor.

It has four parts:
- a payments vocabulary for the Trust Tasks registry
- a small escrow program that releases or refunds on a quorum of signed messages, 2 of 3 by default (payer, payee, arbiter)
- a reference processor that coordinates, pays fees and keeps a transparency log
- a reference arbiter with a public, verifiable track record

State: design written, not built. Read `docs/design.md`.
