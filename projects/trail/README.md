# Trail

Verifiable audit trails for AI agents, devices and services.

- Design: `docs/design.md`. The notes at its end say how the MVP differs.
- Library: `packages/eventlog` (`@zk-toip/eventlog`). This project uses it and adds no protocol code of its own.
- Status: MVP built. It runs the design's ten-step demo (section 15) in the terminal and in a web explorer.

## What it is

Trail has two parts:

1. **`packages/eventlog`**, a library. It keeps append-only, hash-chained, signed logs that the writer can't quietly edit, truncate or fork. Keys rotate, and old signatures still verify against the key state of their time.
2. **`projects/trail`**, this project. It is a service with witnesses and watchers, two scripted actors, a red team, and an explorer for reviewing trails.

Each identity is a KERI AID with a key event log (KEL) in real KERI 1.0 format. On top of it, Trail adds **trails**: our own audit logs, owned by an AID, sealed into its KEL, and receipted by the same witnesses. Witnesses receipt only the first version they see. Watchers detect two versions of the same entry. Entry contents stay with the writer and whoever it discloses them to.

## Run it

```
npm install
npm run trail                                   # from the repository root
```

It prints the addresses:

| What | Where |
|---|---|
| Explorer | http://localhost:4340 |
| API | http://127.0.0.1:4340/api/state |
| Witnesses 1 to 4 | http://127.0.0.1:4341 to 4344, and also http://localhost:4340/w/1 to /w/4 |

Open the explorer and go to **Demo**. Run the steps in order. Each step links to the page that shows what it did.

Options:

- `npm run app --workspace @zk-toip/trail -- --fresh` forgets everything and starts the demo over. The Demo page also has a button for this.
- `-- --static` serves the built explorer. Build it first with `npm run build:web --workspace @zk-toip/trail`.
- Environment: `TRAIL_PORT` (default 4340), `TRAIL_WITNESS_PORT` (witness 1; the others follow), `HOST` (default 127.0.0.1), `TRAIL_DATA` (default `projects/trail/.data`).

The service listens on this machine only. It answers on both 127.0.0.1 and ::1, so `localhost` always reaches it.

### The demo in the terminal

```
npm run demo --workspace @zk-toip/trail
```

It runs the ten steps, narrated, over real HTTP witnesses, and keeps nothing.

### KERIpy

Step 10 hands Scout's and the camera's KELs to KERIpy 1.3.x and compares the key state it computes with ours. It uses `KERIPY_PYTHON`, or else `~/.cache/zk-toip-keripy/venv/bin/python`. With neither, the step says it was skipped and why. To set it up:

```
python3.12 -m venv ~/.cache/zk-toip-keripy/venv
~/.cache/zk-toip-keripy/venv/bin/pip install "keri==1.3.*"
```

## The demo

Ada is the principal. Scout is her AI agent (a fixed script, no model). Quarry Supply is a supplier. Mallory is a thief. Bram is someone who never saw the trail.

1. **Birth.** Scout's AID gets witnesses 1, 2 and 3 (2 must receipt), its own next key and Ada's (either can rotate), and a DID binding to its `did:key`.
2. **Work.** Seven entries: a mandate, two tool calls, a message, an approval request, Ada's approval (which she endorses), and a payment intent written with `appendWitnessed`. Then a checkpoint.
3. **Ada reviews.** Scout discloses its bodies. The bundle verifies, and it is witness-checked.
4. **Tamper.** The payment amount changes from 340 to 3,400 in four deeper layers. They fail with `bodyMismatch`, `saidMismatch`, `signatureInvalid` and `sealMismatch`.
5. **Fork.** Scout shows Quarry a different entry 6. The witnesses refuse it. Quarry's watcher holds both signed versions and sends them to Ada, who checks them herself.
6. **Rogue witness.** Witness 3 signs anything. Two versions of entry 8 each get 2 receipts. Ada's watcher convicts witness 3 and Scout. Ada rotates alone: witness 3 out, witness 4 in.
7. **Key theft.** Mallory copies Scout's key and writes two tool calls and a checkpoint. Ada's policy flags them. Ada recovers: her rotation supersedes the checkpoint, and entries 9 and 10 are cut.
8. **The old key, later.** Mallory writes another entry 9 with the retired key for Bram. Offline it looks signed. Against the witnesses' KEL it is cut.
9. **A camera.** Camera K-7 (P-256 keys) signs photo A, rotates, and signs photo B. Both verify, anchored before retirement. Photo C, signed later with the retired key, shows in amber.
10. **KERIpy** computes the same key state as ours.

## What's built

- `src/service.ts`: the HTTP service. It runs four witnesses (each with its own key, store and port), the explorer's API, and the explorer.
- `src/world.ts`: the witnesses, Ada's and Quarry's watchers, the actors' keys and stores, and the demo's progress. Everything is kept in `.data/` as JSON files.
- `src/witnesses.ts`: a witness service, with a switch that makes it rogue.
- `src/agentSim.ts`: Scout's birth and script, and Ada's rotations with her key alone.
- `src/cameraSim.ts`: the camera, its captures and rotation.
- `src/attacks.ts`: tampering, forking, and copying logs for a thief.
- `src/steps.ts`: the ten steps, each with its narration.
- `src/keripy.ts`: the KERIpy check.
- `src/view.ts` and `src/explain.ts`: verification results turned into rows, checks and plain explanations. The explorer runs these in the browser. The tests and the CLI demo run the same code.
- `web/`: the explorer (React and Vite). Pages:
  - **Identifier:** the AID, its DID binding, key states over time, the KEL with receipts, and each trail. Entries are coloured by key epoch. Cut and superseded entries are struck through. Each entry opens a sheet with every check, its receipts, the raw header and the disclosed body.
  - **Verify:** drop a bundle file, or pick one from the demo. It verifies in the page and compares heads with the witnesses.
  - **Evidence:** each piece of duplicity, both versions side by side, the differing fields marked, and whether its signatures check out.
  - **Captures:** the camera's photos and what their signatures prove.
  - **Demo:** the steps, run one at a time, with what each one did. Steps 4 to 8 are the red team.

The explorer fetches bundles and evidence from the service, but it verifies them itself.

## Tests

```
npm test --workspace @zk-toip/trail     # Vitest: the API, the actors, every attack, witnesses over HTTP, restart
npm run e2e --workspace @zk-toip/trail  # Playwright: the explorer through all ten steps
```

The e2e saves screenshots in `web/e2e-shots/`. Add `--headed` to watch, or `--static` to test the built explorer.

## What's not built

- A real model behind Scout.
- Authentication on the service. It listens on this machine only.
- A witness in the principal's browser. The library supports it; the explorer doesn't run one yet.
- Persistence in the browser.
- The Trust Task (TSP) witness transport in the demo. The library tests it; the demo uses HTTP.
- Endorsements by AIDs, Merkle batching for captures, KERI delegation, and KERI 2.0.
