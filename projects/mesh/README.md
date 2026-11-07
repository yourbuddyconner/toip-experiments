# Mesh

Trust Tasks and TSP without the internet: over LoRa radio, and carried by hand on a USB stick.

- Design: `docs/design.md`. Its last section, "Implementation notes", says what was built and how it differs.
- Library: `packages/mesh-transport`.
- Real radios: `HARDWARE.md`.
- Status: the MVP is built and runs on the simulator. Real-radio bring-up is next, with the same code.

## The idea

A TSP message is sealed and signed end to end, so whoever carries it needs to be trusted only to deliver it. A radio can carry it as well as the internet relay can. But a sealed Trust Task is 1 to 2 KB, and a LoRa frame holds 250 bytes. The TSP envelope also names sender and receiver in clear text, which everyone in range would hear. The library compacts the body (CTT1), strips the envelope on the air, rebuilds it byte for byte on arrival, and cuts the rest into acknowledged frames within the airtime rules.

A transmitting radio can be located. This project hides what you say and who you say it to. It doesn't hide where you are.

## Run it

From the repository root, after `npm install`:

```
npm run demo --workspace @toip-tools/mesh       # the three acts, narrated in the terminal
npm run mesh                                  # the visualizer: prints http://localhost:4360
npm test --workspace @toip-tools/mesh            # unit and end-to-end tests on the simulator
npm run e2e --workspace @toip-tools/mesh         # the visualizer in a real browser (Playwright)
```

The CLI: `npm run mesh --workspace @toip-tools/mesh -- <command>`. Run it with no command for help.

| Command | What it does |
|---|---|
| `demo [--act N] [--loss 0.2] [--seed N]` | The acts on the simulator, narrated: each frame with its size, airtime and who heard it; each message's size as JSON TSP, as CTT1 TSP and on the air; retries; a summary. |
| `door --link LINK` | The Front Door: beacons a signed challenge every 15 s and checks passes offline. It keeps its replay record in `.data/door`. |
| `guest --link LINK` | Rosa: waits for the door's beacon, presents her pass, prints the answer. |
| `gateway --link LINK [--relay URL]` | The Lodge: bridges the radio to a TSP relay and signs custody receipts. Without `--relay` it starts a relay on this machine (port 4361). |
| `attest --link LINK` | Alice: sends a Settle attestation through a gateway, or keeps it in her outbox file (`.data/alice`). |
| `receive [--relay URL]` | The landlord's agent: accepts Alice's attestations as a Settle party does. |
| `bundle export` / `bundle import FILE` | Sneakernet: Alice's outbox to a sealed file; the courier posts it to the relay. |
| `doctor` | Finds the radios and says what to fix: the miner's packet forwarder over UDP, and what is on each serial port. |

`LINK` is `sim`, `gwmp[:PORT]` (the RAK miner's packet forwarder) or `rak:PATH` (a RAK3172 on USB). With `sim`, `door`, `guest` and `attest` run their act on the simulator, and `gateway` runs a simulated cabin against a real relay in real time.

Ports: the visualizer uses 4360 (`PORT`), and a relay started by `gateway` uses 4361 (`RELAY_PORT`). Both listen on 127.0.0.1, and the visualizer also listens on [::1]. Tests use port 0.

Keys come from fixed demo seeds (`src/cast.ts`), so separate processes agree on who is who. That is fine for a demo and wrong for anything else.

## The demo

1. **A door with no internet.** The Building issued Rosa's pass key a guest pass while online. The Front Door cached the Building's DID and its signed revocation list. Rosa hears the door's signed challenge beacon and presents the pass over LoRa (an INTRO packet, 3 frames). The door checks the signature, the holder, the door, the revocation list and the time window, all offline, and answers. Then a listener replays Rosa's frames. The door refuses three ways: its seen list drops the packet; after a reboot, its replay record (kept on disk) knows the document; and with that record lost too, the challenge is stale.
2. **An attestation from the cabin.** Alice hears the Lodge's gateway beacon, repeated by the Ridge. She signs a Settle attestation with Settle's own `attest()` and sends it as `settle/escrow/attest`. It goes as a VIA packet over two hops. The Lodge rebuilds the exact TSP bytes, posts them to a real relay, and sends Alice a signed custody receipt. The landlord's agent accepts the attestation as a Settle party does.
3. **By hand.** The Lodge is down. Alice's second attestation waits in her outbox. She exports it as a bundle sealed to her neighbor, onto a USB stick. In town, the neighbor posts it to the relay. The landlord's agent gets Alice's exact bytes and accepts them.

Measured on the simulator (US915, SF8 at 500 kHz, 250-byte frames, seed 1):

| | |
|---|---|
| Act 1, no loss | 818 ms of airtime in 8 frames (beacon, 3-frame presentation, ACK, 2-frame answer, ACK). 857 ms from beacon to answer. |
| Presentation | 2,106 B as JSON TSP, 732 B as CTT1 TSP, 672 B on the air as INTRO: 3 frames instead of 9. |
| Door's answer | 1,092 B as JSON TSP, 444 B as CTT1 TSP, 306 B on the air as PAIR: 2 frames. |
| Act 1, 20% loss | Opens every time over seeds 1 to 6: 0.9 to 5.2 s from beacon to answer, 0 to 4 retries. |
| Act 2, no loss | Attestation 1,653 B as JSON TSP, 612 B as CTT1 TSP, 593 B as VIA: 3 frames instead of 7. Custody receipt 2.4 s after sending, 989 ms of airtime over two hops. |
| Act 2, 20% loss | Delivered every time over seeds 1 to 8: custody after 13 to 108 s, since a lost receipt sends the packet back to the outbox's backoff. |
| Act 3 | A 741 B bundle, sealed to the courier. Nothing on the air. |
| A listener | Heard sizes and random-looking tags. No DID, key, name or pass text appears in any frame (the tests check the bytes). |

## The visualizer

`npm run mesh` serves a field map of each act. You see:

- the nodes on a survey map, with radio pulses and who heard each frame (teal) or lost it (red, with the reason);
- an airtime strip with one lane per radio, frames drawn to scale, and long quiet stretches shortened;
- airtime meters per radio: its share of the hourly budget, and its longest frame against the 400 ms limit;
- a narrated log with each message's three sizes as bars, cut where 250-byte frames would split it;
- a loss slider, a seed, playback speed, and a position slider.

The server runs the act on the simulator and the page plays back what happened. It works with the keyboard, and it respects reduced motion.

## What's built

- `src/acts.ts`: the three acts. `src/door.ts`, `src/pass.ts`: the door, the guest and the guest pass. `src/settle.ts`: Settle's terms and attestation, and a party that accepts it.
- `src/recorder.ts`, `src/trace.ts`: a trace of each act, used by both the terminal and the page.
- `src/cli.ts`, `src/live.ts`, `src/links.ts`, `src/doctor.ts`: the CLI, its real-link roles, and the bring-up helper.
- `src/server.ts`, `src/main.ts`, `web/`: the visualizer.
- Tests: each act end to end, also at 20% loss; revoked, forged, copied, stale and out-of-window passes; replays; byte-exact delivery through a real relay; the Settle party's checks; bundles; CLI arguments and commands over fake radios; the doctor against a fake packet forwarder and fake AT serial ports; the server.

## What's not built

- Nothing has run on real radios yet. `HARDWARE.md` is the plan.
- Act 4 of the design (EU duty cycle at SF12) and Bluetooth.
- Real key management: every key comes from a demo seed.
- Commons itself. The door reuses Commons' idea of a guest pass, with the Building as the only issuer and no household rosters.
- A Solana chain. The landlord's agent checks the attestation as Settle does, without an escrow.
