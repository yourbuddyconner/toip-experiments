# Settle

An open payments layer for the Trust over IP world. Settle handles conditional payments between parties who don't trust each other. The money is stablecoins, held in an escrow that nobody controls alone, not even the processor.

- Design: `docs/design.md`.
- Status: a working app on a local Solana chain.

## Run the app

```bash
npm install     # at the repository root
npm run settle  # http://127.0.0.1:4300
```

One command starts a whole Settle network on your machine:
- a local Solana cluster running the escrow program;
- the TSP relay;
- Settle's processor and arbiter;
- a verification issuer;
- a faucet for test USDC;
- the web app.

Open the app in two browser windows (one normal, one private) to be two different people. You can also give each tab its own account.

Try this:
1. **Create the business's account.** In the first window, make an account for a business. On **Profile**, select **Get verified**. On **Payment links**, make a link for a job.
2. **Pay as the customer.** Open the link in the second window. Make an account, add test USDC, and pay. The money goes into escrow, and the business's dashboard shows it held for them.
3. **Release the money.** On the payment page, the customer selects **Confirm the work is done**. The three seals fill in as the payer and payee sign. The business is paid.
4. **Settle a dispute.** Pay a second link, and select **Report a problem** instead of confirming. Open the **Operator view** (`/console`) to rule a split as Settle Arbitration. The arbiter's signature, plus one party's, carries out the ruling.
5. **Have someone else confirm.** Make a link that a third person confirms, with a dispute window. Use **Skip ahead** in the sidebar to move the network's clock past the window. The payer's device signs as soon as its policy allows.

To serve the built app instead of the dev server, run `npm run build:web --workspace @zk-toip/settle`, then `npm run app --workspace @zk-toip/settle -- --static`. The platform's ports are set by `PORT`, `RELAY_PORT` and `RPC_PORT`; the defaults are 4300, 4301 and 4302.

## For developers: the whole integration

A party is one person's or one business's device. It holds its own keys, talks to the other parties over TSP, checks everything against the chain, and signs only what its own policy allows. Connecting one takes a few lines:

```ts
import { identityFromSeed } from "@zk-toip/trust-core";
import { SettleApi, encodeLink, decodeLink } from "./src/client/client";
import { SettlePolicy } from "./src/protocol/policy";

const settle = new SettleApi("http://127.0.0.1:4300");
const party = await settle.party({ identity: identityFromSeed(seed), name: "Joe's Plumbing", policy: await SettlePolicy.load(wasm) });
await party.start();
setInterval(() => party.tick(), 2000); // acts on what time makes possible, such as a dispute window that has passed

// Get paid: a link anyone can open. It's a signed document, so a checkout page can verify it without a server.
const link = await party.createLink({ title: "Fix the sink", units: 120_000_000n, release: "payer-confirms" });
const url = `https://your.app/pay/${encodeLink(link)}`;

// Pay: one call. It asks for an invoice, agrees terms, funds the escrow and opens it.
const checkout = await customer.checkout(decodeLink(token)!);
// ...and later, once the work is done. Both parties' policies then sign the release.
await customer.attest(customer.checkouts.get(checkout.id)!.paymentId!, "complete");
```

Other calls:
- `party.refund(id)`: as payee, give everything back.
- `party.dispute(id, reason)`: either side, sent to the arbiter.
- `party.reclaim(id)`: as payer, after the deadline.
- `party.claim(id)`: collect a share the escrow couldn't pay out.
- `party.collectToWallet()`: move finished payments into the wallet.
- `party.snapshot()` and `party.restore()`: save the party's state and pick up where it left off.

## What's here

| Path | What |
|---|---|
| `program/src/lib.rs` | The escrow program, version 2:<br>• `open` funds an escrow for the payer's key and a terms hash, with the price plus the facilitator fee.<br>• `resolve` needs a quorum of Ed25519 signatures over `settle/v2\|program\|escrow\|pay:n\|evidence:hash`. It pays the fee to the processor, `n` of the price to the payee, and the rest back to the payer.<br>• `reclaim` lets the payer alone take the price back after the deadline.<br>• `claim` collects a share that couldn't be paid out.<br>• `hold` lets the arbiter delay a reclaim during a dispute. |
| `program/dist/`, `program/keys/` | The compiled program and its development keypair, so the TypeScript side runs without the Solana toolchain. |
| `src/chain/` | The chain client: addresses and instruction encoding, Ed25519 instructions, the RPC client, and fee sponsorship. The local cluster (LiteSVM) runs behind the Solana JSON-RPC API in `rpcServer.ts`. |
| `src/protocol/` | The signed documents: terms, acceptances, payment-key bindings, attestations, disputes, rulings, evidence and receipts. Also the Trust Task types, the `attested-completion/1` Rego policy, and the transparency log. |
| `src/agents/party.ts` | The party: payer, payee and attester in one. Covers payment links, checkout, the wallet, auto-release, refunds, claims and snapshots. |
| `src/agents/roles.ts` | The network's services: the processor (sponsors transactions, collects signatures, keeps the log) and the arbiter (holds disputed escrows, rules). |
| `src/platform/` | The platform: the whole network in one process, with a REST API (`/api/config`, faucet, verify, directory, operator views, dev clock) that also serves the web app. |
| `src/client/client.ts` | `SettleApi`: connects a party to a platform. Used by the web app and the tests alike. |
| `web/` | The web app (React):<br>• a dashboard, payment links and a hosted checkout at `/pay/:link`;<br>• payment pages with the three seals;<br>• a wallet, verification, and the operator view at `/console`;<br>• `web/e2e.ts` drives all of it in a real browser. |
| `src/world.ts`, `src/demo.ts` | The repair job's cast, and the narrated terminal demo (`npm run demo`). |

## How it fits together

1. **Identity off-chain, fresh keys on-chain.** Each party has a ToIP identity (`did:key`) whose key stays on its own device. For each payment, it derives a fresh Ed25519 key, which is also a Solana address. It binds that key to its DID with a credential that only the other parties see.
2. **Terms.** Both parties sign the terms, and the escrow stores their hash, so everything off-chain is pinned to the escrow.
3. **Every signer decides for itself.** Before signing an outcome, each party's device runs the payment's Rego policy over the signed evidence. The chain enforces only that 2 of 3 named keys signed the same outcome.
4. **Signed messages, not co-signed transactions.** Parties sign outcome messages whenever they're ready, even days apart. The processor submits them with Ed25519 verification instructions, and the program checks them by introspection.
5. **The processor never holds funds.** It pays every network fee. It sponsors only transactions that use its key for nothing but fees and rent. It logs only what it verified, and earns a facilitator fee on every payment, whatever the outcome.
6. **The platform's conveniences are only conveniences.** The faucet, the verifier and the name directory make a development network usable. None of them can move money or sign for anyone.

## Tests

```bash
npm test --workspace @zk-toip/settle        # 49 tests
npm run e2e --workspace @zk-toip/settle     # the app in a real browser: 4 jobs, 3 people, screenshots in web/e2e-shots/
npm run build:program --workspace @zk-toip/settle   # rebuild the program (needs Rust and Agave's cargo-build-sbf)
npm run policies --workspace @zk-toip/settle        # recompile the Rego (needs opa)
```

The tests cover:
- **The program.** Locking attempts, claims, holds, distinct keys, quorum and replay checks, and pre-funded addresses.
- **The documents and the policy.** This includes refunds the payee offers.
- **The end-to-end flows** over a real relay, including every fix from the security review (design §16).
- **The platform** through its API, with parties connected as the web app connects them:
  - payment links;
  - a third party confirming within a dispute window, with time travel;
  - a dispute ruled through the operator API;
  - refunds;
  - restoring a party from a snapshot;
  - refused requests;
  - a checkout ignoring an invoice from anyone but the link's issuer.

## Not yet

- Solana devnet. The client speaks standard JSON-RPC, but only the local cluster is wired up. On devnet the faucet, verifier and clock would go.
- Keys in the browser live in `localStorage`. A real wallet would keep them in a passkey or hardware.
- The operator view and its API have no login. The platform listens only on localhost.
- Base, the second rail (design §11).
- Guarantees and bonds.
- A payee-protecting timeout (design §13).
