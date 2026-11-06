# Settle: design

An open payments layer for the Trust over IP world: conditional payments between parties who don't trust each other, settled in stablecoins by an escrow that nobody controls alone, not even the processor. Date: 2026-11-06.

Settle is the first of two steps the convener chose (2026-11-06): **first, the open standard and the default arbiter; later, the vertical business (Commons for buildings)**, with Settle underneath it.

Choices marked **(our call)** are the assistant's and open to change. Regulation, licensing and fiat on- and off-ramps are out of scope by the convener's decision.

## 1. What Settle is

Four things, all open:

1. **A Trust Task vocabulary for payments.** Invoices, terms, attestations, release signatures, disputes, rulings and receipts. The Trust Tasks registry has nothing for payments today (checked in S02's registry data on 2026-11-06), so this is a proposal to contribute.
2. **An escrow program on Solana.** It holds stablecoins for one payment. It releases or refunds only on a quorum of signatures, by default 2 of 3 among payer, payee and arbiter, over a message that names the evidence.
3. **A reference processor.** It coordinates the messages, pays transaction fees so people don't need SOL, and keeps a public transparency log. It never holds funds.
4. **A reference arbiter.** A trust agent that decides disputes from signed evidence and publishes its signed rulings. Anyone can run one; Settle's is the default.

**The bet:** the protocol and program are free and forkable, and the scarce thing is accountable arbitration and, later, guarantees. That's where the business is. A fee coded into an open escrow program would be the easiest thing to fork. A trusted arbiter with a public track record isn't.

## 2. Goals, non-goals, anti-goals

**Goals**

1. A payment between two parties who don't trust each other, with funds released only when the agreed conditions are met, or when an arbiter rules.
2. Nobody, including the processor and the arbiter, can move funds alone.
3. Every decision can be checked afterwards by anyone holding the documents: terms, evidence, signatures and the on-chain record.
4. Works when parties are offline for hours or days, as Shared To-Do does.
5. Reuses this repository's trust core: did:key identities, TSP messages, Trust Task documents with Data Integrity proofs, the relay, and Rego policies.
6. A first real flow: the Commons repair job (section 10).

**Non-goals (for now)**

- Mainnet and real money. Devnet only.
- Base or other EVM chains. They come later as a second rail (section 11).
- Hiding amounts. They're public on-chain (section 8).
- Fiat on- and off-ramps.
- Guarantees, bonds and insurance. A later product on the same program.
- Streaming payments, subscriptions, or payments split among many recipients.

**Anti-goals**

- **Custody.** If the processor can move a payment's funds, the design has failed.
- **A toll on the protocol.** No fee is hard-coded into the program. A processor's fee is an ordinary, optional term each payment agrees.
- **Linking people to payments in public.** People's DIDs must not appear on-chain.
- **Unverifiable decisions.** A release or ruling that can't be checked against its evidence.

## 3. Parties

| Party | Has | Does |
|---|---|---|
| **Payer** | a DID, and a fresh payment key for this payment | agrees the terms, funds the escrow, signs a release or a refund |
| **Payee** | a DID, and a fresh payment key | agrees the terms, signs a release or a refund |
| **Arbiter** | a DID and a published arbiter key; endorsements | decides disputes; signs with whichever side the ruling favors |
| **Attesters** | DIDs; for example the tenant in a repair job | sign facts the policy needs, such as "the work is done" |
| **Processor** | a DID and a fee-payer key | coordinates, submits transactions and pays their fees, keeps the transparency log, optionally takes a fee |
| **Anyone** | the documents | can verify the whole payment against the chain |

The arbiter and processor can be the same organization (Settle's defaults), but they're separate roles with separate keys.

## 4. Keys: identity off-chain, fresh keys on-chain

- Each party keeps their ToIP identity: a did:key (Ed25519), as in the trust core.
- For each payment, payer and payee each make a **fresh Ed25519 payment key**, derived from their identity seed and the payment id **(our call)**, so a device can recreate it.
- A **payment-key binding** links the two: a small credential, "key K acts for DID D in payment P", signed by D and countersigned by K. It's sent over TSP only to the other parties in the payment.
- On-chain, the escrow sees only the payment keys and the arbiter's key. The public sees unlinked keys; the parties see a verifiable link.
- Solana accounts are Ed25519 keys, which is why Solana is the first rail. A payment key is also a valid Solana address, and the program can verify signatures from DID-world keys natively (section 5).

## 5. The escrow program (Solana)

### State

One escrow account per payment, a PDA with seeds `["escrow", terms_hash]`, plus a USDC token account the PDA owns.

| Field | Meaning |
|---|---|
| `terms_hash` | SHA-256 of the canonical terms document (section 6). It binds everything off-chain to this escrow. |
| `mint`, `amount` | Token and amount (devnet USDC) |
| `payer_key`, `payee_key`, `arbiter_key` | The three Ed25519 keys that may sign |
| `threshold` | Signatures needed: 2 by default |
| `fee_bps`, `fee_account` | The processor's agreed fee, paid only on release. 0 means none. |
| `refund_after` | After this time the payer alone can take the money back, if nothing was released |
| `state` | `funded`, `released`, `refunded` |

### Signed messages, not co-signed transactions

Solana transactions expire about a minute after they're built, but parties may sign hours apart. So a signer signs a **release or refund message** whenever they're ready, and passes it over TSP:

```
settle/v1|<program id>|<escrow address>|release|<evidence hash>
settle/v1|<program id>|<escrow address>|refund|<evidence hash>
```

When a quorum exists, anyone, normally the processor, submits a transaction made of:
1. Ed25519 signature-verification instructions for the signed messages
2. the escrow's `release` or `refund` instruction

The program reads the verification instructions from the same transaction (instruction introspection). It checks that at least `threshold` distinct keys among payer, payee and arbiter signed exactly that message for this escrow. It then pays out:
- **release:** the payee gets `amount × (1 − fee_bps)`, and `fee_account` gets the rest
- **refund:** the payer gets everything

The evidence hash is recorded in the program's event log. The escrow is closed afterwards, so its address can't be reused, and a message can't be replayed elsewhere because the escrow address is part of it.

### Instructions

| Instruction | Who signs the transaction | Checks |
|---|---|---|
| `open` | payer key (as funder), processor (as fee payer) | creates the escrow and moves `amount` in; `terms_hash`, keys, fee and deadline come from the instruction |
| `release` | anyone (the fee payer) | a quorum of message signatures for `release`, and state is `funded` |
| `refund` | anyone | a quorum of message signatures for `refund`, and state is `funded` |
| `reclaim` | payer key | `now > refund_after`, and state is `funded` |

That's the whole program **(our call)**: no conditions, policies or disputes on-chain. Rich conditions live in each signer's policy, and the chain enforces only "enough of the right people agreed". The program is small enough to audit fully.

## 6. The terms

The **terms** document is what both sides sign before money moves. It's Trust Task-shaped JSON with a Data Integrity proof from each of payer and payee:

```
{
  type: "settle/terms", version: 1,
  payment: <id>, created, purpose: "Fix kitchen sink leak, Unit 4B",
  payer:   { did, paymentKey, binding },
  payee:   { did, paymentKey, binding, credentials: [contractor license, insurance] },
  arbiter: { did, key, rulesUrl },
  amount: { mint: <devnet USDC>, value: "340.00" },
  conditions: { policy: "settle/policies/attested-completion/1", params: { attester: <tenant DID>, disputeWindowHours: 168 } },
  fee: { bps: 100, account: <processor fee account>, to: <processor DID> },
  refundAfter: <date>,
  proofs: [payer, payee]
}
```

`terms_hash` is SHA-256 over the canonical form (JCS) without the proofs, so both sides' signatures and the escrow cover the same thing.

## 7. The Trust Tasks

All are one-way TSP messages, as in Shared To-Do. The proposed names suit the registry's style **(our call)**, and until accepted they'd live under our own namespace.

| Task | From → to | Carries |
|---|---|---|
| `payment/request` | payee → payer | an invoice: purpose, amount, payee's offered terms |
| `payment/terms/propose` | either → other | a terms document with one proof |
| `payment/terms/accept` | other → proposer | the terms with both proofs |
| `escrow/opened` | payer or processor → all parties | escrow address, opening transaction signature |
| `escrow/attest` | attester → parties | a signed fact the policy needs, such as "work complete", with photos sealed to the parties |
| `escrow/release/request` | anyone → signers | an evidence bundle: terms, attestations, deadlines passed |
| `escrow/sign` | signer → processor and parties | a signed `release` or `refund` message for the escrow |
| `escrow/dispute` | payer or payee → arbiter and other party | the dispute, with their evidence |
| `arbiter/ruling` | arbiter → parties, and the public log | the decision, reasons, the evidence hashes it relied on, and the arbiter's signed `release` or `refund` message |
| `escrow/settled` | processor → all | the settlement transaction signature |
| `payment/receipt` | payee → payer | a credential tying terms hash, escrow address, settlement transaction and amount |

## 8. Policies: each signer decides for itself

As in Shared To-Do, each party's agent runs the payment's policy on the evidence it holds before it signs anything. Policies are Rego, published and versioned, and named in the terms.

**`attested-completion/1`**, the repair job's policy, says the payer's agent signs a **release** when either:
- the attester signed "complete", and the dispute window has passed with no dispute; or
- the arbiter ruled for the payee.

The payee's agent signs a **refund** when the arbiter ruled for the payer, or when the payee agrees to cancel.

The arbiter signs only to carry out its own ruling.

So the two normal outcomes need no arbiter at all: the payer and payee both sign. The arbiter matters only in a dispute, and even then it can't act alone: its signature plus one party's makes the quorum.

## 9. Arbitration, transparency, privacy

**The arbiter**
- A trust agent with a DID, a published rules document (fees, timelines, evidence it accepts) and endorsements from communities that trust it.
- Rulings are signed documents giving the decision, the reasons, and the hashes of the evidence they relied on. They are published to the arbiter's log with personal data removed.
- Its track record is therefore verifiable: how many cases, how many each way, how fast.
- Parties name the arbiter in the terms and can choose anyone. Settle's default arbiter is the business (section 12).

**Transparency log**
- The processor keeps an append-only, signed Merkle log of terms hashes, openings, signatures received, settlements and rulings. Its signed roots are anchored on-chain periodically.
- Anyone holding a payment's documents can check them against the log and the chain.

**What the public chain shows**
- Escrow addresses, payment keys, amounts, times, the arbiter's key, and the processor's fee account. The fee account links all payments that pay the same processor.
- **Not** DIDs, names, purposes or evidence. Those travel only over TSP, sealed to the parties.
- Amounts are visible. USDC doesn't support Solana's confidential transfers.
- Zero-knowledge comes later, via `projects/zk-pdp-fit`. For example, prove "this escrow was funded by a current household of this building" without saying which.

## 10. The first flow: a repair job

1. Dana, the manager, posts a job. Joe the contractor sends `payment/request` with his license and insurance credentials.
2. The landlord's agent checks Joe's credentials under its policy, then proposes terms. The amount is $340 USDC; the attester is the tenant, Alice; the dispute window is 7 days; the arbiter is Settle; the fee is 1%.
3. Joe accepts. The landlord's agent opens and funds the escrow, with Settle's processor paying the transaction fee.
4. Joe does the work. Alice's agent sends `escrow/attest`: "complete", with photos.
5. Seven days pass with no dispute. The landlord's agent and Joe's agent both sign `release`, and the processor submits it. Joe gets $336.60 and the processor $3.40.
6. **The dispute path:** Alice says it still leaks. The landlord's agent sends `escrow/dispute`. The arbiter reviews the sealed evidence, rules for a partial refund, and signs. The outcome then needs one more signature, from the side the ruling favors.

**Note:** partial outcomes need a split, which the four instructions in section 5 don't have. Section 13 lists this.

## 11. Base later

The protocol is chain-agnostic: terms, Trust Tasks, policies and rulings don't change. A Base version needs:
- a payment key per chain (secp256k1), bound to the party's DID the same way
- the escrow as a small Solidity contract verifying ECDSA signatures over the same messages
- optionally smart accounts and paymasters for fees, and the x402 ecosystem for agent payments

## 12. The business, in brief

- **Free and open:** the Trust Tasks, the policies, the escrow program and the reference processor and arbiter.
- **Settle's default arbiter** charges for dispute resolution, a flat fee per case set out in its rules, and builds the public track record that makes it the default.
- **The processor** may charge its agreed fee (`fee_bps`). Others can run processors.
- **Later:** protected payments. Payees post bonds in the escrow, and a guarantee pays out if a ruling goes against them, priced like insurance. Then Commons for property managers on top.

## 13. Open questions

**Design**
- **Partial releases.** Should the program support a release that splits the amount between payee and payer, with the split in the signed message (for example, release 200, refund 140)? Probably yes, so arbitration can compromise.
- **Timeouts that protect the payee.** Today only the payer is protected by `reclaim`. Should a payee be able to claim after an attested completion plus the window, without the payer's signature? That moves policy on-chain, and the chain would have to verify the attester's signature.
- **Arbiter changes.** If an arbiter disappears, can payer and payee replace it by signing together? That's easy: a quorum without the arbiter already exists.
- **Fresh keys and recovery.** Losing a device loses its payment keys mid-escrow. Deriving them from the identity seed helps only if the seed is backed up.
- **Token support.** Only USDC, or any SPL token named in the terms?

**For the ToIP community**
- Is there appetite for `payment/*` and `escrow/*` in the Trust Tasks registry? Who else is working on payments in ToIP?
- How should payment-key bindings relate to the DTG credential models?
- What would an arbiter's credentials and governance look like as a VTC, perhaps a network of arbiters?

## 14. Shape of the work, when we build it

1. Program first: the four instructions plus partial release, with tests on a local validator, including quorum, replay, wrong escrow and deadlines.
2. The protocol package: terms, bindings, canonical hashing, the Trust Task types, the `attested-completion/1` policy.
3. The processor and arbiter as trust agents on the existing relay, plus the transparency log.
4. A demo with three or four parties in browser profiles, on Solana devnet with devnet USDC: the repair job's happy path and its dispute path.
5. Then the registry proposal, written up for the Trust Tasks maintainers.

## 15. Implementation notes (2026-11-06)

What changed while building it:
- **One `resolve` instruction** replaces separate `release` and `refund`. It takes `payee_amount`: the full amount is a release, 0 is a refund, and anything in between is the split section 13 asked for. The message is `settle/v1|<program>|<escrow>|pay:<n>|evidence:<hex>`. The fee applies only to the payee's part.
- **Escrow accounts are never closed,** only marked resolved or reclaimed. Their address is fixed by the terms hash, so closing one would let it be re-created and old signatures replayed against it. The vault is closed, and its rent goes back to whoever paid it.
- **Pre-funded addresses.** Anyone can send lamports to an escrow's predictable address to make `create_account` fail. The program then allocates and assigns the account instead.
- **Fee sponsorship works by co-signing.** A party builds the transaction with the processor as fee payer and rent payer, signs its own part, and sends it in `settle/processor/submit`. The processor refuses anything that calls a program other than Settle and the Ed25519 precompile, then co-signs and submits.
- **Handlers must never wait on a request.** The relay delivers a device's messages in order. A handler that awaited a request/response would block the very reply it was waiting for, as the payer's escrow opening first did.
- The chain is LiteSVM in-process (`src/chain/simnet.ts`). USDC is a test mint whose authority stands in for each party's wallet or on-ramp.
