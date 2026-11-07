# Tipline

A drop box for whistleblowers. A source proves to a journalist "I am a current member of organization X" without saying which member, sends a tip with documents, and can carry on a conversation. Each tip uses a fresh, unlinkable DID, and the source keeps nothing on their device but a code written on paper.

- **State:** MVP built. The design's demo script runs end to end in a browser.
- **Design:** `docs/design.md`. Its last section, "Implementation notes", says what was built and where the build differs.

## How it works, in brief

1. The organization keeps a group of its members' commitments and signs one Merkle root a day. Each member's own wallet makes and keeps the secret behind their commitment.
2. The source proves in the browser, with a Noir circuit and Barretenberg's UltraHonk in its zero-knowledge mode, that their commitment is under a recent root. The proof also gives a nullifier, which is the same for one member on one story and unrelated across stories.
3. The journalist's inbox checks the proof against the organization's signed root log and labels the source (Source A, Source B) by nullifier. So the journalist can count distinct insiders without knowing any of them.
4. Tips, files and replies are Trust Task documents sealed over TSP through the repository's relay. The design assumes the organization may run that relay.

The proofs are **designed to be zero-knowledge**. We found no published proof that UltraHonk's zero-knowledge mode hides the witness. See `packages/anon-membership/README.md`.

In the demo the employer (Acme Chemicals) runs the group, because that is the hardest case: the issuer is the adversary. The same code serves a union, a professional body or a regulator that runs a group for its members.

## Run it

```sh
npm install
npm run tipline            # from the repository root
```

This builds the web apps and starts everything in one process. It prints the URLs:

| App | URL | Who uses it |
|---|---|---|
| Acme HR console | http://localhost:4312 | The organization: roster, daily signed lists, the relay panel, "Skip ahead a day", the equivocation attack, a search of everything Acme holds |
| Employee wallet | http://localhost:4313 | A member: makes a wallet, joins Acme's group, shows the membership code |
| Sam's inbox | http://localhost:4311 | The journalist: sets up the drop box, opens a story, reads tips, replies |
| The Ledger | http://localhost:4310 | The outlet's site. The source app is at `/tip/<drop box>` |
| TSP relay | ws://127.0.0.1:4314/v1 | Operated by Acme in the demo |

Each app is its own origin, so one browser can play every part without the apps seeing each other's storage. Open the source app in a private window.

Options: `--no-build` serves `web/dist` as it is. `--keep` keeps state in `projects/tipline/.data` between runs (default: a fresh start). Ports: `OUTLET_PORT`, `INBOX_PORT`, `ACME_PORT`, `WALLET_PORT`, `RELAY_PORT`. `TIPLINE_DATA` sets the data directory.

A walk through the demo:

1. In the wallet, make a wallet for Priya. Copy her wallet ID. In the HR console, add her as an employee. Back in the wallet, join Acme's group.
2. In the HR console, under **Member lists**, publish today's list (60 members: 58 seeded, Priya, and anyone else you added).
3. In the wallet, check membership and show the membership code.
4. In the inbox, create the drop box and open a story.
5. In a private window, open the source app from The Ledger's front page. Paste the membership code, write a tip, attach a photo, and send. Write down the tip code.
6. The inbox shows Source A. Reply. Under **Relay** in the HR console, see what Acme's relay saw.
7. Skip ahead a day. In a new private window, type the tip code to read the reply.

`npm run demo --workspace @toip-tools/tipline` runs the same script in a terminal, every party in one process.

## Tests

```sh
npm test --workspace @toip-tools/tipline     # unit and integration tests (vitest)
npm run e2e --workspace @toip-tools/tipline  # the demo script in Chromium (Playwright)
```

- `tests/protocol.test.ts`: tip codes, message binding, chunking and padding, the descriptor, image metadata.
- `tests/flow.test.ts`: the whole protocol over a real relay with real proofs. It covers enrollment, roots, a tip with a file, Source A and B, replies read with the tip code alone, and the refusals (non-member, lifted proof, changed body, wrong scope, unknown root, stale root, reused tip id, replay, equivocation). It also checks what the organization and the relay can see. `fetch` fails for the whole file, so nothing downloads proving setup data.
- `tests/platform.test.ts`: the HTTP platform on free ports.
- `web/e2e.ts`: the design's demo script, steps 1 to 13, with passkeys from virtual authenticators. It checks that each source window leaves no storage behind and makes no request outside its own origin, the relay and Acme's log. Screenshots go to `web/e2e-shots/`, proving times to `results/e2e.json`.

## Layout

| Path | What |
|---|---|
| `src/protocol/` | Tip codes, Trust Task payloads and message binding, the drop box descriptor, padding and chunks |
| `src/sanitize/` | Finding and removing image metadata (EXIF, XMP, ICC, PNG text chunks) |
| `src/agents/` | `issuer.ts` (the organization), `mirror.ts` (the outlet's copy of the log), `inbox.ts`, `source.ts`, `wallet.ts`, `logs.ts` |
| `src/platform/` | The one-process platform and `npm run tipline` |
| `src/world.ts`, `src/demo.ts` | Every party in one process, for the tests and the terminal demo |
| `web/` | The four apps (React and Vite): `source`, `inbox`, `acme`, `wallet`. `web/e2e.ts` drives them |

The shared pieces come from `packages/anon-membership` (circuit, group tree, signed root logs, prover and verifier, nullifier book), `packages/web-vault` (the inbox's and the wallet's sealed keys), `packages/trust-core` (did:key, TSP endpoints, signed documents, `CoarseClock`) and `packages/relay`.

## Not built

- Tor and onion services. The source app warns when the browser doesn't look like Tor Browser, and goes on.
- Cleaning PDFs and office files. The app lists what they may carry and sends them as they are.
- Root-log witnesses, mixnets, relay admission by proof, shared newsroom inboxes, membership from an existing credential (phase 2), paying sources, delivery over `projects/mesh`.
- Coercion resistance. Someone forced to give up a membership code or a tip code is exposed.
- A published hash check of the source app. The descriptor names the bundle's SHA-256, but nothing checks it in the browser.
- Phone measurements.
