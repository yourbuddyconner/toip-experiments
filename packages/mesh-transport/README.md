# @toip-tools/mesh-transport

Trust Tasks and TSP over LoRa radio and by hand, without the internet.

`MeshTransport` implements trust-core's `Transport`. An `Endpoint` on it works as it does on the relay. The bytes the recipient opens are exactly the TSP bytes the sender sealed. A gateway can hand them to the internet relay, and the recipient can't tell how they traveled.

The design is in `projects/mesh/docs/design.md`. This package is section 19.1 of it.

## Layers

```
Endpoint (trust-core)    signs and seals; reads JSON and CTT1 bodies
MeshTransport            implements Transport
  packets                split and rebuild TSP; address tags; routes (direct, flood, gateway); outbox
  frames                 fragments; selective ACKs; bursts; retries; dedup
  scheduler              airtime budget per link; dwell limit; priorities
links                    SimLink | GwmpLink (LoRaWAN gateway) | RakP2PLink (RUI3 AT)
off-line                 bundles (a file a courier carries)
```

- **Packets.** The TSP envelope names both VIDs in clear, so it never goes on the air. A packet carries the HPKE `enc`, the ciphertext and the TSP signature. The receiver rebuilds the envelope and gets the same bytes. A 4-byte HMAC address tag, fresh for every packet, tells the recipient the packet is for it and who sent it. Nobody else can link two packets.
- **Frames.** A packet is cut into frames of at most the link's MTU (8-byte header). One-hop packets go in bursts and are acknowledged with a bitmap of the fragments that arrived. The sender resends only the gaps. Flooded and gateway packets are confirmed end to end by a RECEIPT.
- **Scheduler.** Each link has a sliding one-hour airtime budget: 10% of channel time in the US, the legal duty cycle in Europe. 10% of it is kept for ACKs and receipts. In the US no frame is over 400 ms, so the MTU shrinks to fit at slow settings.

## Wire format

- **CTT1** (in trust-core, `ctt1`): a CBOR body that decodes to the identical document, so every Data Integrity proof still verifies. DIDs, UUIDs, timestamps and dictionary strings take a few bytes each. A standard proof becomes its creation time and 64 raw signature bytes. When the encoder can't prove the result is identical, it sends the JSON body.
- **Packets:** PAIR (to a contact who knows us), INTRO (first contact: the sender's VID sealed to the recipient), VIA (for a gateway: both VIDs sealed to it), RECEIPT (opened, refused, or in a gateway's custody, signed). DOWN, RAW and PUBLIC have codecs only.
- **Frames:** DATA `0xA0`, ACK `0xA1` (11 bytes for up to 8 fragments), BEACON `0xA2` (82 bytes, signed).

Measured by `tests/sizes.test.ts` (did:key identities, US default SF8 / 500 kHz, MTU 250):

| Message | TSP-sealed JSON | On the air (PAIR) | As a first contact (INTRO) | Design (sealed → air) |
|---|---|---|---|---|
| Empty request | 1,008 B | 267 B, 2 frames | 345 B | 996 → 252 |
| Guest-pass presentation | 1,860 B | 501 B, 3 frames | 579 B | 1,824 → 477 (559) |
| Settle attestation | 1,650 B | 456 B, 2 frames | 534 B | 1,605 → 432 |
| Sensor reading | 1,095 B | 309 B, 2 frames | 387 B | 1,140 → 312 |

No sealed Trust Task fits in one 250-byte frame. Two frames is the floor.

At 20% frame loss, 200 of 200 three-frame packets arrive within 4 rounds (`tests/mesh.test.ts`). They use 1.84 times the airtime of a lossless burst.

## Adapters

| Adapter | Entry | Runs in | What it talks to |
|---|---|---|---|
| `SimMedium`, `SimLink` | `/sim` | anywhere | a simulated radio on a `VirtualScheduler`: half-duplex, collisions with capture, loss, faults, gateway mode |
| `GwmpServer`, `GwmpLink` | `/gwmp`, `/node` | Node | a LoRaWAN gateway's packet forwarder, over UDP (Semtech's protocol) |
| `RakP2PLink` | `/rak` | anywhere with a serial port | a RAK3172 with stock RUI3 AT firmware, in LoRa P2P mode |
| `nodeSerialPort`, `listSerialPorts` | `/node` | Node | USB serial, through the `serialport` package |
| `webSerialPort` | `/serial` | Chrome, Edge | Web Serial |
| `detectRadios` | `/detect`, `/node` | Node | finds a gateway (UDP) and probes serial ports (Meshtastic, RNode, RUI3, Seeed) |

The main entry, `/sim`, `/serial` and `/rak` import nothing from Node.

## Bringing up the hardware

Tests never need a radio. For the real thing (the steps are in the design's sections 14.4 to 14.7):

**The RAK hotspot miner** is a LoRaWAN gateway, not a node. Repurpose it as in section 14.7, path B: a second microSD card with RAK's `udp-packet-forwarder` container, `BAND=us_902_928`, pointed at the laptop on UDP port 1700. Then on the laptop:

```ts
import { GwmpServer } from "@toip-tools/mesh-transport/node";
import { plans } from "@toip-tools/mesh-transport";
const server = new GwmpServer({ port: 1700, plan: plans["us915-b-gateway"], log: console.log });
await server.start();
server.onGateway((link) => console.log("gateway", link.eui)); // a PULL_DATA every 10 s
```

Pin the gateway with `allow: [{ eui, address }]` on a shared LAN.

**The RAK3172** is the second device: the node. Plug it in by USB, then:

```ts
import { detectRadios, nodeSerialPort } from "@toip-tools/mesh-transport/node";
import { RakP2PLink } from "@toip-tools/mesh-transport/rak";
import { plans } from "@toip-tools/mesh-transport";
console.log(await detectRadios({ timeoutMs: 3000 })); // e.g. { kind: "rak-rui3", port: "/dev/tty.usbserial-0001", ... }
const link = new RakP2PLink({ port: nodeSerialPort("/dev/tty.usbserial-0001"), plan: plans["us915-b-node"] });
await link.open(); // switches the module to P2P mode, sets the sync word, IQ and channels
```

Plan `us915-b` matches the gateway's stock configuration: nodes send on 904.6 MHz and listen on 923.3 MHz, both 500 kHz, SF8. To check on the hardware: `AT+SYNCWORD`'s format, the 250-byte `AT+PSEND` limit, and the turnaround times (guesses: 250 ms for GWMP, 300 ms for RUI3).

## API

```ts
import { MeshTransport, ChallengeBeacon, MeshGateway, plans, regions } from "@toip-tools/mesh-transport";
import { SimMedium, VirtualScheduler } from "@toip-tools/mesh-transport/sim";
import { Endpoint, ctt1 } from "@toip-tools/trust-core";

// A simulated radio. The scheduler is also a Clock for Endpoints.
const sched = new VirtualScheduler();
const medium = new SimMedium({ scheduler: sched, seed: 1 });
const radio = { setting: plans["us915-a"].tx, mtu: 250, budget: regions.us915 };
medium.connect("rosa", "door", { loss: 0.2 });

const mesh = new MeshTransport({ identities: [rosa], links: [medium.node("rosa", radio)], scheduler: sched });
await mesh.start();
const endpoint = new Endpoint({
  identity: rosa, transport: mesh, clock: sched,
  bodyCodecFor: (to) => (mesh.supportsCompact(to) ? ctt1 : undefined),
});
const answer = await sched.run(endpoint.request(door.did, spec, payload, { timeoutMs: mesh.suggestedTimeoutMs(door.did, 600) }));
```

- `MeshTransport`: `start`, `stop`, `attach`, `detach`, `post`, `addContact`, `addContactKeys`, `supportsCompact`, `estimate`, `suggestedTimeoutMs`, `pending`, `neighbors`, `exportBundle`, `onBeacon`, `stats`. For doors and gateways: `sendBeacon`, `onVia`, `sendPacket`, `scheduler`. Options include `gateways`, `relay`, `flood: { maxTtl, relayShare, unknown }`, `arq`, `acceptIntros`, `onEvent` and `random` (seed it in simulations). `onEvent` reports frames in and out, each packet built (`packet-out`: kind, route, size, frames), retries, deliveries, custody, queueing, budget waits and drops.
- `VirtualScheduler`: `advance`, `runUntilIdle`, `run(promise)`, and `hold(promise)`, which freezes virtual time while real I/O (a post to a real relay) is out.
- `ChallengeBeacon({ identity, mesh, everyMs, keep })`: `start`, `stop`, `current`, `isFresh`.
- `MeshGateway({ identity, mesh, relay, store, beaconEveryMs })`: `start`, `stop`, `stats`. `relay` is a `RelayTransport` signed in as the gateway.
- Bundles: `exportBundle(items, { sealTo })`, `openBundle(bytes, courier)`, `postBundle(items, relayTransport)`, and `mesh.exportBundle({ sealTo })`.
- Codecs: `splitTsp`, `joinTsp`, `encodePacket`, `decodePacket`, `encodeFrame`, `decodeFrame`, `fragment`, `packetId`, `estimate`, `loraAirtimeMs`, `maxBytesUnder`, `plans`, `regions`.
- Stores: `memoryContacts`, `memoryOutbox`, `memoryGatewayStore`. In `/node`: `fileContacts`, `fileOutbox`, `fileGatewayStore`, `fileReplayStore`.

trust-core gained, for this package: `ctt1`, `jsonBody`, `encodeBody`, `decodeBody`, the `Endpoint` options `bodyCodecFor` and `replayGuard`, `PersistentReplayGuard` with `memoryReplayStore`, and `request(to, spec, payload, { timeoutMs })`.

## Differences from the design

- **CTT1 uses a small CBOR codec of our own** in trust-core, as the design allows. cborg rejects the simple values 16 and 17 that CTT1 uses for the sender and receiver VIDs. cborg is used here for bundles.
- **The CTT1 dictionaries are frozen with more entries** than the seed lists. Examples: the proof's field names, `authentication`, `settle/acceptance`, and the current Trust Task error URI (`…/trust-task-error/0.6`). The encoder's identity check compares the exact JSON text, key order included. That is stricter than comparing canonical forms.
- **Routed and Nested TSP messages split too.** Their outer form is the same as Direct, and they can't be told apart without decrypting. So they travel as PAIR or INTRO, byte-exact. `MeshTransport` never sends RAW: a message it can't split is refused as `"undelivered"`, and there is no point-to-point link yet.
- **Relays repeat gateway beacons**, with one unsigned hop byte added (83 bytes). Direct beacons are the design's 82 bytes. This is how a node hears a gateway through a relay (act 2).
- **Beacons give a route, not an introduction.** A node that has only heard a peer's beacon still sends it INTRO, since the peer may never have heard of it. A beacon counts as already heard for 30 s only: a gateway's beacon is the same bytes every minute, and relays must repeat each one.
- **ARQ tweaks**, found in the simulator: a sender sends only control frames while it waits for the ACK of a one-hop burst. After a round with no ACK at all, it sends fragment 0 twice, because a receiver without fragment 0 can't tell the packet is for it. A receiver answers a resend of a packet it already has with two ACKs. ACKs wait until the sender's burst is likely over. Bursts that fill gaps don't count as rounds. Timeouts and ACKs with no progress do.
- **Unknown recipients.** `flood.unknown` chooses between `"flood"` (default), `"direct"` and `"off"`. A heard gateway comes before flooding an unknown recipient.
- **`post()` waits** until its rounds end, or at most twice their estimated time (between 2 and 60 s). The design's default was 3 times one exchange.
- **`relay` defaults to false.** Fixed nodes set it.
- **The mesh checks the TSP signature** before it delivers, and before it adds a contact from an INTRO. A refused INTRO is answered with a RECEIPT, status 2, even on one hop.
- **A resent VIA packet reaches the gateway again**, even though its mesh has seen the pid. The gateway answers from its store.
- **Custody items stay in the outbox** with state `"custody"`. When the gateway's relay connection is down, "custody" means the gateway's own relay outbox.
- **`GwmpLink.open()` resolves at once.** The link stays `"opening"` until the first PULL_DATA, and a send before that, or one with no TX_ACK, fails.
- **`RakP2PLink` asks `AT+NWM=?` first** and skips the mode switch (and restart) when the module is already in P2P mode.
- **`nodeSerialPort` and `listSerialPorts` are in `/node`**, not `/serial`, so `/serial` stays browser-safe.
- **Not built yet:** Bluetooth, the RNode link (its KISS framing and detection are here), DOWN and PUBLIC behavior, carriers, padding, the reliable-link mode, resealing after two backoffs and the simulator's clock-skew fault. The demo and CLI are in `projects/mesh`.
