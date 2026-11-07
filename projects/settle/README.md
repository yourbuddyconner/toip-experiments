# Settle

An open payments layer for the Trust over IP world. Settle handles conditional payments between parties who don't trust each other. The money is stablecoins, held in an escrow that nobody controls alone, not even the processor.

- Design: `docs/design.md`.
- Status: a working app. It runs on its own local Solana cluster, which survives restarts, or on a real cluster. The program is deployed on devnet at `2g4BZEbPaSuLwY7QM9vvkZUiLNWvzAtuRkcXfuK4MwFy`. Paid, disputed and refunded payments pass end to end on devnet and on `solana-test-validator`.

## Run the app

```bash
npm install     # at the repository root
npm run settle  # http://localhost:4300
```

One command starts a whole Settle network on your machine:
- a local Solana cluster running the escrow program;
- the TSP relay;
- Settle's processor and arbiter;
- a verification issuer;
- a faucet for test USDC, and a gas station for the SOL that accounts need;
- the web app.

Everything is kept in `projects/settle/.data/local`, so stopping and starting again loses nothing. Add `-- --fresh` to start a new network.

Open the app in two browser windows (one normal, one private) to be two different people. You can also give each tab its own account. **Your key is sealed with a passkey** (Touch ID, Windows Hello or your phone), or with a passphrase if your browser's passkeys can't do it. Profile shows a backup code for the account.

Try this:
1. **Create the business's account.** In the first window, make an account for a business. On **Profile**, select **Get verified**. On **Payment links**, make a link for a job.
2. **Pay as the customer.** Open the link in the second window. Make an account, add test USDC, and pay. The money goes into escrow, and the business's dashboard shows it held for them.
3. **Release the money.** On the payment page, the customer selects **Confirm the work is done**. The three seals fill in as the payer and payee sign. The business is paid.
4. **Settle a dispute.** Pay a second link, and select **Report a problem** instead of confirming. Open the setup link the platform printed when it first started (`/console?setup=…`), and sign in with one of your accounts. That account becomes the platform's operator. Rule a split as Settle Arbitration: the arbiter's signature, plus one party's, carries out the ruling.
5. **Have someone else confirm.** Make a link that a third person confirms, with a dispute window. Use **Skip ahead** in the sidebar to move the network's clock past the window. The payer's device signs as soon as its policy allows.

To serve the built app instead of the dev server, run `npm run build:web --workspace @zk-toip/settle`, then `npm run app --workspace @zk-toip/settle -- --static`. Settings:
- **Ports:** `PORT`, `RELAY_PORT` and `RPC_PORT` (defaults 4300, 4301 and 4302).
- **Where it listens:** `HOST`, default this machine only. If you change it, put the platform behind TLS.
- **Where it keeps its data:** `--data <dir>` or `SETTLE_DATA`.

### Operators

The **Operator view** (`/console`) shows the arbiter's cases and the processor's books, and is where disputes are ruled. Operators sign in with their own Settle account: its key signs a one-time challenge, so there is no password and the platform never holds the key.
- A new platform prints a setup link once. The first account to use it becomes the operator.
- An operator can add or remove others on the **Operators** tab, by their identifier (`did:key:…`, shown on Profile).
- The processor's transparency log stays public, at `/api/log`.

### On Solana devnet

```bash
npm run deploy --workspace @zk-toip/settle -- --cluster devnet          # once: deploys the program
npm run app --workspace @zk-toip/settle -- --cluster devnet             # the platform, on devnet
```

On a real cluster, the platform's **treasury** key pays for the test-USDC mint, the processor's network fees and the gas station. The deploy also comes from it, so the treasury needs about 1.5 SOL to deploy and 0.3 SOL to run. Devnet's RPC faucet is closed, so the first run prints the treasury's address. Send it SOL from https://faucet.solana.com, then run the command again. The treasury's key is in `.data/devnet/platform.json`.

On devnet, clocks keep real time, so **Skip ahead** is hidden. `--cluster localnet` uses a `solana-test-validator` on port 8899, and `--cluster <url>` uses any RPC endpoint.

The public devnet endpoint rate-limits each IP address. The client waits and retries, re-sends transactions until they're confirmed, and reads each party's accounts in one request per tick. Even so, a payment takes about a minute when everything runs from one machine. For more speed, use your own RPC provider's devnet URL with `--cluster <url>`. To run the real-cluster tests on devnet:

```bash
SETTLE_CLUSTER=devnet SETTLE_DATA=.data/devnet npm run test:cluster --workspace @zk-toip/settle
```

## For developers: the whole integration

A party is one person's or one business's device. It holds its own keys, talks to the other parties over TSP, checks everything against the chain, and signs only what its own policy allows. Connecting one takes a few lines:

```ts
import { identityFromSeed } from "@zk-toip/trust-core";
import { SettleApi, encodeLink, decodeLink } from "./src/client/client";
import { SettlePolicy } from "./src/protocol/policy";

const settle = new SettleApi("http://localhost:4300");
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
| `src/platform/` | The platform: the whole network in one process.<br>• `platform.ts`: a REST API (config, faucet, gas station, verify, directory, operator sign-in and views, public log, dev clock) that also serves the web app.<br>• `cluster.ts`: the local cluster or a real one.<br>• `state.ts`: the data directory.<br>• `operators.ts`: operator sign-in.<br>• `deploy.ts`: deploys the program to a real cluster. |
| `src/client/client.ts` | `SettleApi`: connects a party to a platform. Used by the web app and the tests alike. |
| `web/` | The web app (React):<br>• a dashboard, payment links and a hosted checkout at `/pay/:link`;<br>• payment pages with the three seals;<br>• a wallet, verification, and the operator view at `/console`;<br>• `src/vault.ts` sets up `@zk-toip/web-vault`, which seals each account's key with a passkey (WebAuthn PRF) or a passphrase;<br>• `web/e2e.ts` drives all of it in a real browser, with virtual passkeys. |
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
npm test --workspace @zk-toip/settle        # 53 tests (and 3 that need a real cluster, skipped)
npm run e2e --workspace @zk-toip/settle     # the app in a real browser: 4 jobs, 5 people, passkeys, operators; screenshots in web/e2e-shots/
SETTLE_CLUSTER=localnet npm run test:cluster --workspace @zk-toip/settle   # against solana-test-validator, or devnet (deploy first)
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
  - a checkout ignoring an invoice from anyone but the link's issuer;
  - a restart: the chain, keys, cases and log carry over, and a payment opened before it settles after it;
  - operator sign-in: setup code, one-use challenges, forged and replayed proofs, adding and removing operators, cross-site requests;
  - the gas station's limits.
- **A real cluster** (`tests/cluster.test.ts`): a paid link, a dispute held and ruled, and a refund, with real confirmations and real time.

## Not yet

- Signing with the passkey itself. A passkey seals the key, but can't sign Ed25519 for a `did:key` or a Solana address, so the key is unsealed in memory while the account is open.
- TLS and a public deployment. The platform can listen beyond localhost, but it doesn't terminate TLS itself.
- Base, the second rail (design §11).
- Guarantees and bonds.
- A payee-protecting timeout (design §13).
