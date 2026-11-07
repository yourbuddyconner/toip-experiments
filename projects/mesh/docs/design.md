# Mesh: design

Trust Tasks and TSP without the internet: over LoRa radio, over Bluetooth LE, and by hand. Date: 2026-11-06.

The convener said: "I think we could totally implement trust tasks over Bluetooth or LoRa. I've actually got a LoRa radio, so that's easy." The radio is a RAK Helium hotspot miner: a Raspberry Pi 4 with a LoRaWAN gateway concentrator. Section 14 designs for it.

Choices marked **(our call)** are the assistant's and open to change. A guess is labeled a guess. Measurements in this document come from a scratch prototype run against this repository's trust core on 2026-11-06 (section 5). They are ours.

## 1. What and why

Today every message in this repository travels over the internet: through the in-memory `Bus` in tests, or through the WebSocket relay (`packages/relay`). Many places where trust matters have no internet: a building's front door when the network is down, a field clinic, a cabin, a farm, a festival, a disaster area.

TSP already does the hard part. A sealed message is confidential and authenticated end to end, whoever carries it. The carrier doesn't need to be trusted with content, only with delivery. So a radio, a Bluetooth link or a USB stick can carry TSP messages as well as the relay can, if we solve four problems:

1. **Size.** A TSP-sealed Trust Task is about 1 to 2 KB today. A LoRa frame carries about 250 bytes.
2. **Loss.** Radio frames get lost. Links are half-duplex.
3. **Metadata.** The TSP envelope names sender and receiver in clear text. On a radio, everyone within kilometers hears it.
4. **Airtime.** Radio time is scarce and in some places rationed by law.

This project builds a shared library, `packages/mesh-transport`, that implements trust-core's `Transport` interface over these links. It also builds a demo that runs over a simulated radio and over the convener's real hardware.

## 2. Who uses it

| Who | Where | What they do |
|---|---|---|
| A guest at a building door | the door kiosk has no internet | presents a guest pass and gets in |
| A field medic | a clinic tent with no signal | proves a license to the camp's coordinator |
| A tenant at a cabin | no cell signal; a LoRa gateway on a ridge 3 km away | attests "the repair is done" for a Settle payment |
| A sensor | a field, solar powered | sends signed readings to a gateway |
| A courier | anyone driving into town | carries queued messages on a phone or USB stick to the internet |
| Developers in this repo | tests | run any Trust Task flow over a lossy simulated radio |

## 3. Goals, non-goals, anti-goals

**Goals**

1. Any Trust Task that runs over trust-core's `Endpoint` runs over the mesh, unchanged except for longer timeouts.
2. The bytes a recipient opens are exactly the TSP bytes the sender sealed. A gateway can hand them to the internet relay, and the recipient can't tell how they traveled.
3. A guest-pass check at a door takes under 2 seconds over LoRa at short range.
4. A broadcast listener learns as little as we can manage: not who talks to whom, not what they say.
5. Works with message loss of 20% per frame, duplicates and reordering.
6. Never breaks the airtime rules of the region it's set for.
7. Adding a new radio means writing one adapter against a small interface.
8. Everything is testable in a deterministic simulator. Real hardware is never needed for tests.

**Non-goals (for now)**

- LoRaWAN. Its network servers need the internet, and its payloads are too small for our messages. We use raw LoRa.
- Large meshes. We design for up to about 20 nodes and 3 hops.
- Adaptive data rates, multi-channel scheduling, or time-slotted access.
- Native phone apps. A browser does Web Bluetooth and Web Serial.
- Voice, images, files. Messages are up to about 15 KB.
- Interoperating with other mesh stacks on the same frequency. We coexist with them and ignore their frames.

**Anti-goals**

- **Weakening TSP to save bytes.** We compress around the seal, never inside it. No shorter keys, no dropped signatures in the MVP.
- **Clear-text identifiers on the air.** No DID, VID or stable address is ever broadcast in clear by a person's device. Doors and gateways are public things and may announce themselves.
- **Pretending to hide location.** A transmitting radio can be located by direction finding. We say so and don't claim anonymity.
- **A mesh-only dialect.** Nothing that a normal trust-core endpoint on the internet can't open.

## 4. What runs over it

### 4.1 Trust Tasks worth doing offline

| Use | Who talks | Messages | Why offline matters |
|---|---|---|---|
| Guest pass at a door (Commons) | guest device → door | door beacon with a challenge; presentation; signed result | the door must work when the building's network is down (`projects/commons/docs/design.md` section on passes) |
| License check in the field | medic → coordinator | presentation of a credential; result | no signal at incident sites |
| Settle attestation | tenant → payer, payee and arbiter, via a gateway | `settle/escrow/attest` | the attester may be where the work is, with no signal; delivery hours later is fine |
| Signed sensor readings (Capture) | sensor → gateway → owner | batched readings | sensors live where there's no network |
| Witness receipts (Trail) | witness → controller | receipts | small, signed, latency-tolerant |
| Entry receipts | door → issuing household | signed receipt | queued at the door, delivered later through a gateway |

**Poor fits.** Zero-knowledge proofs (Agora, Tipline) are kilobytes: a 14 KB proof is 57 LoRa frames, about 23 seconds of airtime at the fastest European setting and 9 minutes at the slowest. They work over Bluetooth, not over long-range LoRa. Tipline's whistleblowers should not use a radio at all: transmitting reveals where you are.

### 4.2 The MVP demo

Two flows, both real Trust Tasks, both on the simulator and on the convener's hardware:

1. **The door with no internet.** A guest presents a pass to a door over LoRa. The door checks it offline against cached signed state, and answers. It shows the full request and response cycle, holder binding by challenge, and that an eavesdropper learns nothing.
2. **The attestation from the cabin.** A tenant with no signal sends a Settle attestation over LoRa to a gateway. The gateway hands the exact TSP bytes to the internet relay, and the payer's agent receives it as an ordinary message. It shows gateway bridging, custody receipts and store-and-forward.

Then a third act, by hand: the gateway is down, so the message leaves on a USB stick (section 14.12).

Why these two **(our call)**: the door is the most memorable, and Commons already designs it. The attestation reuses Settle, which is built and running, so the demo touches real code on both ends.

## 5. How big messages are today

### 5.1 Measured

Measured by sealing real documents with trust-core (`signTrustTask`, `packTrustTask`, did:key identities) in a scratch script:

| Message | Document JSON | TSP-sealed today | Our compact form, on the air | Ratio |
|---|---|---|---|---|
| Empty request (`{}` payload) | 660 B | 996 B | 252 B | 25% |
| Guest-pass presentation (a VC with its own proof, plus a challenge) | 1,488 B | 1,824 B | 477 B (559 B as a first contact) | 26% |
| Settle attestation (a signed `settle/attestation` as payload) | 1,269 B | 1,605 B | 432 B | 27% |
| One sensor reading | 805 B | 1,140 B | 312 B | 27% |

The prototype checked three things for every message:
- the compact body decodes back to the identical document, and its Data Integrity proofs (outer and nested) still verify;
- the TSP message can be rebuilt byte for byte from what we put on the air;
- deflate on the JSON body gets only to about 45% (731 B for the presentation), which is why we don't just compress.

### 5.2 Where the bytes go

In today's TSP message (`@openvtc/vti-tsp-js` 0.2.0, Direct mode):
- **132 bytes** of clear-text envelope: CESR framing, the TSP version, and both VIDs as 56-character did:key strings.
- **48 bytes** of HPKE: a 32-byte ephemeral key and a 16-byte tag.
- **72 bytes** of signature frame: a 64-byte Ed25519 signature and 8 bytes of CESR counts.
- The rest is the JSON body: `{type: "https://trusttasks.org/binding/tsp/0.1/envelope", document}`. Most of it is long strings: type URIs, DIDs (each appears up to 4 times), `urn:uuid:` ids, ISO timestamps, base58 signatures, and the proof's fixed fields.

In our compact form:
- **117 bytes** fixed TSP cost: kind 1, address tag 4, HPKE 48, signature 64. Plus about 9 bytes of CESR framing inside the ciphertext, which we can't touch.
- **About 120 bytes** for an empty Trust Task document: id 18, type about 16, timestamp 7, and a proof of about 75 (its 64-byte signature dominates).
- So **no TSP-sealed Trust Task fits in one 250-byte LoRa frame.** Two frames is the floor. Every design choice below follows from this.

## 6. Threat model

| Threat | What they can do | What stops it |
|---|---|---|
| **Eavesdropper** with a cheap radio, kilometers away | hears every frame on the channel | TSP sealing hides content. Address tags are fresh random-looking bytes for every packet (section 8.3), so they can't link packets to people or to each other. They still see timing, sizes, packet kinds, signal strength and direction. |
| **Traffic analysis** | learns that someone near the door talks to the door at 12:04 | Not prevented. People's devices never beacon. Optional padding to whole frames hides exact sizes. We don't claim more. |
| **Locating a transmitter** | direction finding | Not prevented. Stated in the README and the demo. |
| **Replay** of captured frames | re-sends a presentation later | Packet ids drop exact repeats for an hour. Endpoints' replay guard drops repeated document ids. The door's challenge expires within a minute, so an old presentation fails even after a restart. |
| **Forged acknowledgements** | tells a sender "received" so it stops retrying | Acknowledgements carry a MAC that only the real recipient can make (section 8.3). |
| **Forged or altered packets** | injects junk or edits bytes | The packet hash catches corruption. TSP's signature and HPKE-Auth catch forgery. Address tags let a node discard packets not meant for it cheaply. |
| **Flooding** | fills the channel with junk so relays repeat it | Relays repeat only complete, hash-valid packets, at most once each, with a TTL of at most 3, and within a capped share of their airtime. Phase 2 adds an optional community MAC so relays repeat only members' packets. |
| **Jamming** | drowns the channel | Can't be stopped. Nodes report a busy channel, and people fall back to Bluetooth or a USB stick. |
| **Malicious relay** | drops, delays or reorders | Can't read or change anything. Senders retry and wait for an end-to-end receipt. |
| **Malicious gateway** | learns sender and receiver (as the internet relay does), drops messages | Can't read or change anything. Its custody receipts are signed, so dropping after a receipt leaves evidence. |
| **Malicious courier** (sneakernet) | same as a gateway | Bundles can be sealed to the courier's key so a photo of the QR code reveals nothing. |
| **The packet forwarder's UDP link** (section 14.3) | anyone on the LAN can inject fake received frames or pretend to be the gateway | Run it on localhost or a trusted LAN. Pin the gateway's EUI and address. Our cryptography makes injected frames no worse than radio frames. |
| **Clock attacks on offline nodes** | a node with a wrong clock accepts stale or rejects fresh documents | The door uses challenges, not clocks. Offline endpoints use a wider clock skew (10 minutes). Nodes with GPS or a real-time clock are preferred. |
| **Downgrade** to the raw TSP form, which names VIDs | a misconfigured sender reveals metadata | The raw form is never chosen automatically on a broadcast link. |

## 7. Architecture

```
  Endpoint (trust-core)          signs, seals with TSP, runs the Trust Task pipeline
        │  post(from, to, wire) / deliver(wire)
  MeshTransport  implements Transport
        │
  ┌─────┴───────────────────────────────────────────────────────────────┐
  │ Packet layer   TSP split and join; packet kinds; address tags;       │
  │                routing (direct, flood, gateway); outbox; dedup       │
  ├──────────────────────────────────────────────────────────────────────┤
  │ Frame layer    fragmentation; reassembly; selective acks; retries    │
  ├──────────────────────────────────────────────────────────────────────┤
  │ Scheduler      airtime budget per link; priorities; backoff          │
  └─────┬───────────────────────────────────────────────────────────────┘
        │  send(frame) / onFrame
  Link adapters:  SimLink │ GwmpLink (LoRaWAN gateway) │ RakP2PLink (AT) │ RNodeLink (KISS) │ BLE
  Off-line:       bundles (file, QR)
```

**Sending.** The `Endpoint` builds and seals a TSP message as today, with a compact body when the recipient supports it (section 8.1). It calls `transport.post(from, to, wire)`. `MeshTransport` splits the TSP bytes into their parts, picks a route and a packet kind, builds the packet, and puts it in the outbox. The frame layer cuts it into frames, the scheduler sends them when airtime allows, and the frame layer waits for acknowledgements and resends gaps.

**Receiving.** A link delivers a frame. The frame layer reassembles packets and acknowledges them. The packet layer checks the hash, drops duplicates, checks the address tag against its contacts, rebuilds the exact TSP bytes, and calls the `Endpoint`'s `deliver(wire)`. The `Endpoint` opens it as it would any relay message.

**Gateways** (section 11) run a `MeshTransport` and a `RelayTransport` side by side.

## 8. The wire format

Multi-byte integers are big-endian. "H(x)[0..n]" means the first n bytes of SHA-256 of x. HMAC is HMAC-SHA256.

### 8.1 The compact Trust Task body (CTT1)

The TSP binding for Trust Tasks puts a JSON object in the sealed payload: `{type: ENVELOPE_TYPE, document}`. We add a second body format, chosen by the first byte:

- `0x7B` (`{`): the standard JSON body. Unchanged.
- `0x01`: **CTT1**, a CBOR encoding of the same document.

CTT1 is lossless. Decoding gives back the same JSON values, so the canonical form (JCS) is the same and every Data Integrity proof still verifies. The encoder proves this each time: it decodes its own output and compares canonical forms. If they differ, it sends the JSON body instead.

**Values.**

| JSON value | CTT1 |
|---|---|
| null, true, false | CBOR simple values 22, 21, 20 |
| integer within ±2^53 | CBOR integer |
| other number | float32 if exact, otherwise float64 |
| array | CBOR array |
| object | CBOR map in the object's key order. A key in the key dictionary becomes its index (an unsigned integer). Any other key stays a text string. |
| string | the first rule that applies, below |

**Strings.**

| Rule | Encoding | Cost |
|---|---|---|
| equals the TSP sender's VID | simple value 16 | 1 B |
| equals the TSP receiver's VID | simple value 17 | 1 B |
| an Ed25519 did:key whose canonical form matches | tag 6, 32-byte key | 35 B instead of 56 |
| `<did:key>#<multibase>` (a did:key verification method) | tag 7, 32-byte key | 35 B instead of 105 |
| lowercase `urn:uuid:` | tag 37 (UUID), 16 bytes | 18 B instead of 45 |
| `YYYY-MM-DDTHH:MM:SS.sssZ` that round-trips | tag 8, unsigned integer milliseconds | 8 B instead of 24 |
| `YYYY-MM-DDTHH:MM:SSZ` that round-trips | tag 1 (epoch seconds), unsigned integer | 6 B instead of 20 |
| in the string dictionary | tag 9, index | 2–3 B |
| starts with a prefix in the prefix dictionary | tag 10, `[prefix index, rest]` | saves the prefix |
| anything else | text string | |

**Proofs.** In any object that has a string `issuer` and a `proof` object that is exactly an `eddsa-jcs-2022` Data Integrity proof by that issuer for `assertionMethod` (the six fields `signTrustTask` writes, with `verificationMethod` equal to `issuer#<multibase key>`), the proof becomes tag 11 `[created, signature]`: the creation time by the string rules, and the 64 raw signature bytes. That's about 75 bytes instead of about 330. The decoder rebuilds the six fields in the same order. Any other proof is encoded generically.

**Dictionaries.** Fixed lists, frozen per format byte. A new list means a new format byte (`0x02`), never edits to `0x01`. The seed lists, to be completed and frozen when built:
- Keys: `id`, `type`, `issuer`, `recipient`, `issuedAt`, `expiresAt`, `threadId`, `payload`, `proof`, `@context`, `validFrom`, `validUntil`, `credentialSubject`, `credentialStatus`, `statusListIndex`, `statusListCredential`, `statusPurpose`, `code`, `message`, `retryable`, `challenge`, `credential`, `claim`, `termsHash`, `at`, `note`, `sensor`, `t`, `kind`, `value`, `unit`.
- Strings: `https://www.w3.org/ns/credentials/v2`, `VerifiableCredential`, `BitstringStatusListEntry`, `DataIntegrityProof`, `eddsa-jcs-2022`, `assertionMethod`, the Trust Task error type URI, `settle/attestation`, `complete`, `not-complete`.
- Prefixes: `https://zk-toip.example/spec/`, `https://trusttasks.org/spec/`, `https://trusttasks.org/`.

**Tag numbers.** Tags 1 and 37 have their registered CBOR meanings. Tags 6 to 11 are private to CTT1 and mean nothing outside a CTT1 body **(our call; see open questions)**.

Per-spec payload schemas (positional arrays instead of maps) would save another 10 to 30 bytes a message. Phase 2.

### 8.2 Splitting a TSP message

A Direct TSP message from `vti-tsp-js` 0.2.0 is three parts:

```
envelope   -E count | YTSP version | B sender VID | B receiver VID | X 00 00     (132 B for two did:keys)
ciphertext G var-data header | ct ‖ aead tag(16) ‖ enc(32)
signature  -C count | -K count | B 64-byte Ed25519 signature                      (72 B)
```

The signature covers envelope and ciphertext. The envelope is also HPKE's `info`. So we can't change either. But both are deterministic: given the two VIDs and the ciphertext bytes, `encodeEnvelope`, `cesr.encodeVariableData` and the CESR count and fixed-data encoders (all exported by `vti-tsp-js`) rebuild the exact message.

So on the air we send only `enc`, `ct ‖ tag` and the 64-byte signature, plus a way for the receiver to know the two VIDs. `splitTsp(wire)` and `joinTsp(parts)` do this. The prototype confirmed byte-exact rebuilds. Routed and Nested TSP messages are sent in the raw form (kind 0x06).

### 8.3 Keys and address tags

Every node holds a **contact list**: VIDs it knows, with their keys. For two contacts S and R:

```
ss          = X25519(S's X25519 secret, R's X25519 public)          (the keys trust-core derives from Ed25519)
k(S→R)      = HKDF-SHA256(ikm = ss, salt = "zk-toip/mesh/v1", info = "dir" ‖ S's Ed25519 key ‖ R's Ed25519 key, 32 bytes)
tag         = HMAC(k(S→R), "tag" ‖ enc[0..16])[0..4]                 per packet; enc is the HPKE ephemeral key
ack MAC     = HMAC(k(R→S), "ack" ‖ pid ‖ bitmap)[0..4]
receipt tag = HMAC(k(R→S), "rcpt" ‖ pid)[0..4]
```

Because `enc` is fresh for every message, the tag is different every time. An outsider sees 4 random-looking bytes. R tries the tag against each contact: one HMAC per contact, a few milliseconds for 1,000 contacts. A match tells R the sender too, so it can rebuild the envelope. A false match (1 in 4 billion per contact) fails the TSP signature check and is dropped. No clocks are involved.

The keys are static, so if a key leaks, past tags become linkable. Content stays as safe as TSP makes it.

### 8.4 Packets

A packet is what the frame layer carries. Its id is `pid = H(packet)[0..4]`. Retransmissions and relayed copies have the same pid.

**0x01 PAIR**: to a contact who knows us.
```
0      kind 0x01
1      tag (4)
5      enc (32)
37     ct ‖ aead tag (n)
37+n   TSP signature (64)
```
Overhead over the CTT1 body: 117 bytes plus CESR framing inside the ciphertext.

**0x02 INTRO**: first contact. The receiver doesn't know us yet; for example a guest's pass key and a door.
```
0      kind 0x02
1      L (1)
2      sealed sender (L): HPKE base mode to R's X25519 key, info "zk-toip/mesh/intro/v1", aad = enc;
       plaintext = VID form of the sender
2+L    enc (32) | ct ‖ aead tag | TSP signature (64)
```
VID form: `0x01 ‖ 32-byte Ed25519 key` for a did:key, or `0x02 ‖ length ‖ UTF-8 VID` for anything else. For a did:key, L = 81. Every node that hears an INTRO tries to open the sealed sender with its own key: one HPKE open per INTRO packet. Only R succeeds. Nothing in clear names anyone. HPKE base mode is the one `sealing.ts` already uses from `vti-tsp-js`.

A sender uses INTRO until it has heard anything from the recipient, then PAIR.

**0x03 VIA**: for a gateway to forward to the internet relay.
```
0      kind 0x03
1      gateway hint (8) = H(gateway's Ed25519 key)[0..8]
9      L (1)
10     route block (L): HPKE base to the gateway, info "zk-toip/mesh/via/v1", aad = enc;
       plaintext = VID form of sender ‖ VID form of receiver
10+L   enc (32) | ct ‖ aead tag | TSP signature (64)
```
For two did:keys, L = 114. The gateway learns sender and receiver, exactly what the relay already learns. Gateways are public infrastructure, so the hint names one in clear.

**0x04 DOWN** (phase 2): from a gateway to a device, for messages collected from the relay on its behalf.
```
0 kind 0x04 | 1 tag (4, under k(gateway→device)) | 5 L | 6 sealed sender: ChaCha20-Poly1305 under k(gateway→device),
nonce = H(enc)[0..12], plaintext = VID form of the original sender | enc | ct ‖ tag | TSP signature
```

**0x05 RECEIPT**: end to end, for flooded and gateway routes.
```
0      kind 0x05
1      receipt tag (4)
5      pid being acknowledged (4)
9      status: 0 opened by the recipient, 1 in a gateway's custody, 2 refused by the recipient
10     status 0 or 2: MAC (8) = HMAC(k(R→S), "rcpt" ‖ pid ‖ status)[0..8]      → 18 B
       status 1: the gateway's Ed25519 signature (64) over
       "zk-toip/mesh/custody/v1" ‖ SHA-256(packet) ‖ status                     → 74 B
```
A custody receipt is signed, not MACed, so it is evidence that the gateway took the message.

**0x06 RAW**: `0x06 ‖ the full TSP message`. Names both VIDs in clear. For point-to-point links, bundles, and VIDs we can't handle otherwise. Never chosen automatically on a broadcast link.

**0x07 PUBLIC** (phase 2): a signed, unencrypted datagram, for public sensor readings and announcements. Not TSP.
```
0 kind 0x07 | 1 signer hint (8) | 9 content type (1) | 10 body | Ed25519 signature (64)
over "zk-toip/mesh/public/v1" ‖ all preceding bytes
```

Maximum packet: 64 fragments. That's about 15 KB on a 250-byte link and 32 KB on Bluetooth. A larger message is refused with `"undelivered"`.

### 8.5 Frames

A frame is what a link sends. The top 4 bits of byte 0 are `0xA`, our version 1 marker. The radio channel may carry other people's traffic, so a frame that fails any check is dropped silently.

**DATA** (0xA0), 8-byte header:
```
0   0xA0
1   pid (4)
5   fragment index (1), from 0
6   fragment count (1), 1–64
7   ttl (3 bits) | hops (3 bits) | attempt (2 bits)
8   chunk: up to MTU − 8 bytes
```
`ttl` is how many more times relays may repeat the packet. 0 means one hop, and the receiver acknowledges it. `hops` counts repeats so far. `attempt` counts the sender's full resends on flooded routes, so relays repeat a resend they've already seen once.

**ACK** (0xA1), 11 bytes for up to 8 fragments:
```
0   0xA1
1   pid (4)
5   fragment count (1)
6   bitmap, ceil(count / 8) bytes: bit i (least significant first) set if fragment i arrived
..  ack MAC (4)
```

**BEACON** (0xA2), 82 bytes, one frame, never fragmented or acknowledged:
```
0   0xA2
1   role: 0 verifier (a door), 1 gateway
2   key hint (8) = H(Ed25519 key)[0..8]
10  body (8): verifier: a fresh challenge nonce. Gateway: flags (1: bit 0 accepts VIA, bit 1 offers DOWN),
    relay hint (4) = H(relay URL)[0..4], reserved (3)
18  Ed25519 signature (64) over "zk-toip/mesh/beacon/v1" ‖ bytes 0–17
```
Listeners verify a beacon only if they already know the full key: the door's DID from the pass, a gateway's from configuration.

## 9. Fragmentation, acknowledgements and retries

### 9.1 Rules

- **Bursts.** A sender sends all missing fragments of one packet back to back (up to 8 per burst), then listens. Half-duplex links can't do better: every switch between sending and listening costs time.
- **Selective acknowledgement.** The receiver says which fragments it has. The sender resends only the gaps.
- **Who acknowledges.** On a one-hop route (`ttl` 0), the addressee acknowledges, once it has fragment 0 and knows the packet is for it. On flooded and gateway routes, nobody acknowledges frames. The recipient (or gateway) sends a RECEIPT packet instead.
- **Reliable links** (Bluetooth): the link does its own retransmission, so the receiver sends one ACK per complete packet and the sender's only timer is for a lost connection.
- **Relays** reassemble a packet, check its hash, then repeat it whole. They never repeat fragments of a packet they can't check.
- **Fragments from anyone count.** A receiver fills a packet's gaps from any transmitter: the sender, or relays repeating it.

### 9.2 Timers

From the link's own figures (`airtimeMs`, `turnaroundMs`):

| Timer | Value |
|---|---|
| T_frame | airtime of a full-MTU frame |
| T_if, the gap after which a receiver stops waiting for the next fragment | 2 × T_frame + turnaround |
| ACK delay | turnaround + random 0 to 1 × airtime of an ACK |
| T_ack, how long a sender waits after a burst | T_if + 2 × turnaround + 2 × airtime of an ACK |
| T_receipt, flooded and gateway routes | (hops + 1) × (packet airtime + T_ack) × 2, at least 5 s |
| Rounds before giving up for now | 4 |
| Outbox backoff after that | 30 s, doubling to 30 min. Also retried at once when the recipient or a gateway is heard. |

### 9.3 Sender, per packet

```
QUEUED ── airtime available ──▶ SENDING (missing fragments, one burst)
SENDING ── burst done ──▶ WAITING
WAITING ── ACK, valid MAC, all bits set ──▶ DONE                       post() → "live"
WAITING ── ACK with gaps ──▶ SENDING (only the gaps), round + 1
WAITING ── RECEIPT status 0 ──▶ DONE                                   post() → "live"
WAITING ── RECEIPT status 1 (valid signature) ──▶ CUSTODY              post() → "queued"
WAITING ── RECEIPT status 2 ──▶ DONE                                   post() → "undelivered"
WAITING ── timeout, round < 4 ──▶ SENDING (all unacknowledged), round + 1, attempt + 1 on flooded routes
WAITING ── timeout, round = 4 ──▶ BACKOFF (kept in the outbox)         post() → "queued"
BACKOFF ── backoff over, or the recipient or a gateway heard ──▶ QUEUED (round 0)
```

An ACK or RECEIPT with a bad MAC or signature is ignored.

### 9.4 Receiver, per pid

```
(none) ── a DATA frame ──▶ COLLECTING: buffer of `count` slots; start T_if
COLLECTING ── fragment 0 ──▶ decide: for me (tag matches, or an INTRO I can open, or a VIA with my hint)?
                              relayable (ttl > 0)? If neither, drop the buffer.
COLLECTING ── another fragment ──▶ store it; restart T_if
COLLECTING ── T_if expires with gaps, one-hop and for me ──▶ send ACK with gaps; wait T_ack
COLLECTING ── all fragments ──▶ CHECK: H(packet)[0..4] = pid?
CHECK ── no ──▶ drop; if one-hop and for me, send ACK with an empty bitmap
CHECK ── yes ──▶ if one-hop and for me, send a full ACK; add pid to the seen list;
                 deliver if for me; queue a repeat if relayable; hand to the gateway if VIA for me
(seen pid) ── a DATA frame again ──▶ if one-hop and for me, send the full ACK again (ours was lost). Never deliver twice.
COLLECTING ── idle for 4 × T_ack ──▶ drop the buffer
```

### 9.5 Duplicates

- The **seen list** holds pids for 1 hour, at most 10,000 (least recently used out). With 4-byte pids, a new packet is wrongly taken for a duplicate about 1 time in 400,000 at a full list. It's then retried and gets a new pid only if its bytes change, so the sender reseals after 2 unanswered backoffs **(our call)**.
- **Relays** remember `(pid, attempt)` for 10 minutes and repeat each at most once.
- **Endpoints** keep their own replay guard on document ids, as today.

### 9.6 What `post()` returns

| `Delivery` | When |
|---|---|
| `"live"` | the recipient acknowledged (one hop) or sent a RECEIPT with status 0 |
| `"queued"` | a gateway took custody, or the packet is in the outbox waiting for a route or airtime |
| `"undelivered"` | too large (over 64 fragments), the recipient refused it, or the recipient can't be addressed (no keys, no gateway) |

`post()` waits for one of these for at most `postWaitMs`: by default 3 times the estimated exchange time, between 2 and 60 seconds. Then it returns `"queued"` and keeps trying, as `RelayTransport` does.

## 10. Addressing and routing

### 10.1 Routes

| Route | When | Packet | Who confirms |
|---|---|---|---|
| **Direct** | the recipient was heard directly (hops 0) in the last 10 minutes | PAIR or INTRO, ttl 0 | the recipient's ACK |
| **Flood** | the recipient was heard through relays, or is unknown and flooding is on | PAIR or INTRO, ttl = hops last heard + 1, at most 3 | the recipient's RECEIPT, flooded back |
| **Gateway** | the recipient isn't on the mesh, and a gateway was heard | VIA | the gateway's signed custody RECEIPT |
| **Outbox** | none of the above | (kept) | nobody yet |

Nodes learn routes only from packets they can attribute (tags that match a contact) and from beacons. A person's device never announces itself.

### 10.2 Flooding

A relay that completes a packet with ttl > 0:
1. waits a random time between T_if and 3 × T_if;
2. cancels if it has meanwhile heard the same `(pid, attempt)` repeated by 2 others;
3. otherwise repeats it with ttl − 1 and hops + 1.

Relays give forwarding at most 30% of their airtime budget **(our call)**, and own traffic, ACKs and receipts come first.

### 10.3 Carriers (phase 2)

A carrier is a node that accepts custody of VIA packets for a gateway it isn't in range of, and repeats them when it hears that gateway's beacon. It's the "relay that travels by hand": a phone that walks from the cabin to the lodge. In the MVP, a phone carries only its own outbox, which persists until it's back in range, and bundles (section 14.12).

## 11. Gateways

A gateway is a node with internet. It runs `MeshTransport` and a `RelayTransport` signed in as **the gateway's own DID**.

**Announcing.** It sends a gateway BEACON every 60 seconds by default, within its airtime budget.

**Upstream (MVP).**
1. A VIA packet arrives with the gateway's hint.
2. The gateway opens the route block, learns sender and receiver, and rebuilds the exact TSP message with `joinTsp`.
3. It calls `relay.post(gatewayDid, receiver, wire)`. The relay stores it for the receiver.
4. When the relay confirms (`"live"` or `"queued"`), the gateway records the pid and sends the sender a custody RECEIPT signed with its key. The record survives restarts, so a resent VIA packet gets the same receipt and isn't posted twice.

The recipient's `Endpoint` reads the sender from the TSP envelope (`advertisedSender`), not from the relay's `from`. So the message looks exactly as if the sender had posted it. The relay counts the gateway as the sender for its per-sender limits (1,000 messages per recipient).

**Downstream (phase 2).** A device on the mesh has a mailbox on the relay but can't reach it. The gateway could collect for it, but the relay authenticates each mailbox owner by a signed challenge with a 15-second timeout, too short for a radio round trip. Phase 2 adds a **courier grant** to the relay (section 19.4): the device signs once, "gateway G may collect my mail at this relay until time T", and sends it over the mesh. The gateway then collects the device's messages and sends them as DOWN packets, acknowledging each to the relay only after the device's ACK. A gateway trusted this way can drop mail but can't read it.

## 12. Airtime and duty cycle

### 12.1 Airtime of one LoRa frame

The standard LoRa time-on-air formula (Semtech's LoRa modem documentation; from memory, to check against AN1200.13):

```
T_sym     = 2^SF / BW
T_pre     = (preamble + 4.25) × T_sym
n_payload = 8 + max(ceil((8·PL − 4·SF + 28 + 16·CRC − 20·IH) / (4·(SF − 2·DE))) × (CR + 4), 0)
airtime   = T_pre + n_payload × T_sym
```
PL is payload bytes. CRC = 1, IH (implicit header) = 0, CR = 1 for 4/5. DE (low data rate optimization) = 1 when T_sym > 16 ms. Preamble 8 unless the radio says otherwise (RNode firmware uses at least 18 symbols). `loraAirtimeMs()` implements this. Every link reports its own `airtimeMs`.

| Setting | Bit rate | 250-byte frame | 11-byte ACK |
|---|---|---|---|
| SF7, 125 kHz | 5.5 kbps | 389 ms | 41 ms |
| SF8, 125 kHz | 3.1 kbps | 687 ms | 82 ms |
| SF9, 125 kHz | 1.8 kbps | 1.23 s | 144 ms |
| SF10, 125 kHz | 1.0 kbps | 2.26 s | 289 ms |
| SF12, 125 kHz | 0.3 kbps | 8.86 s | 1.16 s |
| SF7, 500 kHz | 21.9 kbps | 97 ms | 10 ms |
| **SF8, 500 kHz** (our US default) | 12.5 kbps | 172 ms | 21 ms |
| SF9, 500 kHz | 7.0 kbps | 307 ms | 36 ms |
| SF10, 500 kHz | 3.9 kbps | 564 ms (over 400 ms) | 72 ms |

### 12.2 Rules by region

These are configuration presets, not legal advice. The figures come from secondary sources (section 22). Ask before relying on them.

| Preset | Band | Limit | Frame cap | MTU |
|---|---|---|---|---|
| `us915` | 902–928 MHz | no duty cycle. 400 ms per transmission on 125 kHz channels; 500 kHz channels have no dwell limit under the LoRaWAN plan | **400 ms on every channel (our call)** | the largest frame under 400 ms, at most 250 |
| `eu868-g1` | 868.0–868.6 MHz | 1% duty cycle, 25 mW ERP | none | 250 |
| `eu868-g3` | 869.4–869.65 MHz | 10% duty cycle, 500 mW ERP | none | 250 |
| `none` | simulator | none | none | per test |

In the US the 400 ms cap sets the MTU, and the MTU sets everything else:

| US setting | Largest frame under 400 ms | Frames for a 559-byte presentation |
|---|---|---|
| SF7–SF9, 500 kHz | 250 B (our cap) | 3 |
| SF10, 500 kHz | 174 B | 4 |
| SF7, 125 kHz | 250 B | 3 |
| SF8, 125 kHz | 138 B | 5 |
| SF9, 125 kHz | 66 B | 10 |
| SF10, 125 kHz | 24 B (16 bytes of payload) | unusable |

So in the US we use 500 kHz channels at SF8 by default. That's also what a LoRaWAN gateway listens to with one dedicated demodulator (section 14.4). For more range, SF9 or SF10 at 500 kHz, or SF7–SF8 at 125 kHz, hopping over the gateway's 8 channels.

**Fair share where there's no duty cycle (our call).** In the US a node still caps itself at 10% of channel time per hour. Other people's LoRaWAN devices (including Helium's) use the same channels.

### 12.3 The scheduler

Each link has an **airtime budget**: a sliding window (1 hour) with a ceiling (the duty cycle, or the fair share) and a per-frame cap. Before sending a frame, the scheduler asks the budget. If the frame won't fit, it waits until it will. A frame over the cap is a bug: the frame layer never builds one, and the simulator fails the test if one is sent.

Queue order: ACKs and RECEIPTs, then beacons, then own new packets, then retries, then relayed packets, then bulk (carrier and sneakernet traffic). When the budget runs low, the scheduler still keeps 10% of it for ACKs and receipts, since one lost ACK costs a whole retry.

A packet whose airtime is over a quarter of the hourly budget triggers a warning event, so a demo at SF12 in Europe says why it's slow.

## 13. The link interface

```ts
export interface LinkInfo {
  label: string;                 // "gwmp:AA555A0000000000", "rak:/dev/tty.usbserial-0001", "sim:door"
  kind: "sim" | "lora" | "ble";
  mtu: number;                   // largest frame this link sends, in bytes
  broadcast: boolean;            // everyone in range hears every frame
  halfDuplex: boolean;
  reliable: boolean;             // the link retransmits itself (BLE)
  turnaroundMs: number;          // from the end of a received frame to when we can transmit
  airtimeMs(frameBytes: number): number;
  budget: AirtimePolicy;         // duty cycle or fair share, and the per-frame cap
}

export interface ReceivedFrame { bytes: Uint8Array; atMs: number; rssi?: number; snr?: number; frequencyHz?: number }
export type LinkState = "closed" | "opening" | "open" | "failed";

export interface Link {
  readonly info: LinkInfo;
  readonly state: LinkState;
  open(): Promise<void>;
  close(): Promise<void>;
  /** Resolves when the frame has been transmitted. It says nothing about who received it. */
  send(frame: Uint8Array): Promise<void>;
  onFrame(fn: (f: ReceivedFrame) => void): () => void;
  onState(fn: (s: LinkState) => void): () => void;
  /** True while the radio senses a busy channel, if it can. */
  channelBusy?(): boolean;
}
```

An adapter does only framing to and from its radio. Everything else is shared. A point-to-point link (one BLE connection) is a `Link` with `broadcast: false`. A peripheral with three connected phones is three `Link`s.

## 14. Adapters and hardware

### 14.1 The simulated radio (essential)

`SimMedium` is a radio world on a `VirtualScheduler`, a clock that jumps from event to event, so a simulated hour of SF12 runs in milliseconds and every run with the same seed is identical.

- **Nodes**: `medium.node(name, params)` returns a `SimLink`. Params: LoRa setting (SF, bandwidth, coding rate, preamble), MTU, budget, turnaround, serial latency, optional split frequencies (to model a LoRaWAN gateway, which listens on one plan and transmits on another).
- **Topology**: `medium.connect(a, b, { loss, rssi, snr, burst })` per directed pair. Not connected means out of range. Hidden terminals come free.
- **Physics**: a frame occupies `airtimeMs` on the channel. A receiver loses it if: it was transmitting at any point during it (half-duplex); another frame overlapped it at that receiver and was not at least 6 dB weaker (capture effect); or the loss model says so. Loss models: none, fixed probability, or Gilbert-Elliott bursts.
- **Fault injection**: duplicate a frame, delay one past the next (reordering), corrupt a byte (the frame is dropped, as a radio's CRC would), power a node off, partition the medium, skew a node's clock.
- **Law**: each `SimLink` enforces its budget and frame cap, and throws `RegulatoryViolation` if broken. Tests assert it's never thrown.
- **Gateway mode**: a node with `gateway: { rx: [settings], tx: setting }` hears several settings at once and can't hear its own transmissions, as a concentrator does.
- **Inspector**: `medium.records()` lists every frame: time, sender, bytes, airtime, and each receiver's result (received, or why lost). `subscribe()` notifies a UI, as `Bus` does.

### 14.2 The convener's radio: a RAK hotspot miner

From the coordinator: a black RAK Helium hotspot miner, V1 or V2. That's a Raspberry Pi 4 with a LoRaWAN gateway concentrator HAT. V1 units carry a RAK2245 (SX1301). V2 units are RAK7248-class with a RAK2287 (SX1302, or SX1308 on some). The region is very likely US915 (unconfirmed).

What that means for us:
- It is a **gateway, not a node.** It listens on 8 channels at once (125 kHz, any SF from 7 to 12) plus one 500 kHz channel at one SF. It transmits on one frequency at a time and hears nothing while it does.
- Its host interface is the **Semtech UDP packet forwarder protocol** (GWMP), not a serial port. A program on the Pi (`lora_pkt_fwd`) talks to the concentrator and sends every received packet as JSON over UDP to a server. That server can send back packets to transmit. We write the server.
- The forwarder forwards any LoRa packet with a valid CRC and the right sync word. It doesn't parse LoRaWAN. So raw LoRa works, if our node uses the gateway's sync word and normal IQ polarity.
- **It can't hear itself, and it can't talk to itself.** A two-way demo needs a second LoRa device (section 14.5).

### 14.3 The GWMP adapter (first real-hardware adapter)

Protocol, from Semtech's `PROTOCOL.TXT` (packet_forwarder v1.4; the sx1302_hal forwarder speaks the same). UDP, default port 1700. Every datagram starts with 4 bytes: version `0x02`, a 2-byte random token, and an identifier.

| Id | Name | Direction | Rest of the datagram |
|---|---|---|---|
| 0x00 | PUSH_DATA | gateway → us | 8-byte gateway EUI, then JSON `{"rxpk":[…], "stat":{…}}` |
| 0x01 | PUSH_ACK | us → gateway | nothing; same token |
| 0x02 | PULL_DATA | gateway → us | 8-byte EUI. A keepalive (every 10 s by default) that tells us where to send downlinks |
| 0x04 | PULL_ACK | us → gateway | nothing; same token |
| 0x03 | PULL_RESP | us → gateway | JSON `{"txpk":{…}}` |
| 0x05 | TX_ACK | gateway → us | 8-byte EUI, then optional JSON `{"txpk_ack":{"error":"NONE"}}` |

An `rxpk` carries `freq` (MHz), `chan`, `rfch`, `stat` (1 = CRC OK), `modu` ("LORA"), `datr` ("SF8BW500"), `codr` ("4/5"), `rssi`, `lsnr`, `size`, `data` (base64), and `tmst` (microsecond counter at end of reception).

A `txpk` we send: `{"imme":true, "freq":923.3, "rfch":0, "powe":20, "modu":"LORA", "datr":"SF8BW500", "codr":"4/5", "ipol":false, "size":n, "data":"…"}`. `ipol: false` matters: LoRaWAN gateways normally transmit with inverted IQ so that only end devices hear them, and our node listens with normal IQ. TX_ACK errors include `TOO_LATE`, `TOO_EARLY`, `COLLISION_PACKET`, `TX_FREQ` (frequency outside the gateway's TX range) and `TX_POWER`.

`GwmpServer` (Node `node:dgram`, no other dependency):
- Binds a UDP port. Answers every PUSH_DATA with PUSH_ACK and every PULL_DATA with PULL_ACK at once.
- Keeps, per gateway EUI, the address of its last PULL_DATA. One `GwmpLink` per EUI. Optionally pinned to one EUI and source address (section 6).
- Turns each `rxpk` with `stat` 1 and `modu` "LORA" into a `ReceivedFrame` (rssi, snr, frequency).
- `send(frame)`: builds a txpk from the link's channel plan, sends PULL_RESP with a fresh token, waits up to 1 s for TX_ACK. On `NONE`, resolves after the frame's airtime (the protocol has no "transmit done" event). On an error, rejects.
- State `failed` if no PULL_DATA for 30 s.
- `info`: MTU 250, broadcast, half-duplex, turnaround 250 ms (the forwarder batches received packets for up to 100 ms, `push_timeout_ms`, and the downlink queue adds a few tens of milliseconds; a guess, to measure).
- `airtimeMs` from the plan's transmit setting.

The adapter can run on the Pi itself (Node on the Pi, forwarder pointed at localhost) or on a laptop on the same LAN.

### 14.4 Channel plans for the gateway and its nodes

A LoRaWAN gateway listens on one plan and transmits on another. Its stock US915 configuration (sx1302_hal's `global_conf.json.sx1250.US915`, matching LoRaWAN sub-band 2):

- Receive: 8 channels at 125 kHz, 903.9 to 905.3 MHz in 200 kHz steps, SF5–SF12. One 500 kHz channel at 904.6 MHz, SF8.
- Transmit: radio 0 only, 923.0 to 928.0 MHz (`tx_freq_min`, `tx_freq_max`), up to 27 dBm in its power table.
- Sync word: public (`lorawan_public: true`, the LoRaWAN sync word 0x34).
- Forward only packets with a valid CRC.

So we define two US plans:

**`us915-b` (default; stock gateway configuration).** Like LoRaWAN, two frequencies:
- Node transmits: 904.6 MHz, 500 kHz, SF8, CR 4/5, preamble 8, public sync word, normal IQ, CRC on, 20 dBm.
- Gateway transmits: 923.3 MHz, 500 kHz, SF8, same otherwise, `ipol: false`, 20 dBm.
- Nodes retune between the two (section 14.6). Two nodes can't hear each other directly. The gateway is the hub and relays between them (flood with ttl 1). A 250-byte frame takes 172 ms either way, well under the 400 ms cap.

**`us915-a` (one frequency; one line changed on the gateway).** Everyone transmits and receives on 904.6 MHz, 500 kHz, SF8. The gateway's `tx_freq_min` must be lowered to 902000000. Nodes never retune, and nodes hear each other, so it's a real mesh. We try it after `us915-b` works. If the gateway answers `TX_FREQ`, we stay on `us915-b`.

Power: 20 dBm conducted on both sides, with the stock antennas. That's well below what US rules allow for these channels (a guess at the margin; ask).

Plans for other regions are symmetric single-frequency plans: `eu868-g1` at 868.1 MHz and `eu868-g3` at 869.525 MHz, SF7, 125 kHz.

### 14.5 The second device: what to buy

**Buy one RAK3172 board with a USB port, US915 (high-frequency) variant, with an antenna.** For example RAK's RAK3172 evaluation board. If it's out of stock, a WisBlock starter kit with the RAK4631-R core works the same (the "-R" means it runs RUI3).

**Firmware: the stock RUI3 AT firmware it ships with.** Nothing to flash. Why this one:
- It's the cheapest sensible option (tens of dollars), from the same maker as the miner.
- RUI3's LoRa P2P mode does exactly what a raw LoRa node needs, over USB serial at 115200 baud: set frequency, SF, bandwidth, coding rate, preamble and power (`AT+P2P`), the sync word (`AT+SYNCWORD`), IQ inversion (`AT+IQINVER`), channel activity detection before sending (`AT+CAD`), send (`AT+PSEND`) and receive (`+EVT:RXP2P`).
- It covers the whole US band, so it can transmit at 904.6 MHz and listen at 923.3 MHz.

Buy two if you want node-to-node tests without the gateway later (plan `us915-a`, or a door with its own node).

**The alternative, for full control (phase 2):** a Heltec WiFi LoRa 32 V3 (ESP32-S3 with an SX1262) running a small firmware of our own, written on RadioLib. It would speak a binary serial protocol like KISS, with per-frame frequency and setting, so retuning costs nothing. It means writing and maintaining firmware, so it comes later.

### 14.6 The RUI3 AT adapter (the node)

`RakP2PLink`, over a `SerialPortLike` (Node `serialport` or Web Serial). Commands end in `\r\n`. Each one waits for `OK` or an error (`AT_PARAM_ERROR`, `AT_BUSY_ERROR`).

Open:
```
AT                       → OK                     (alive)
AT+VER=?                 → firmware version       (for the inspector)
AT+NWM=0                 → LoRa P2P mode          (the module restarts; wait, then AT again)
AT+SYNCWORD=3444         → public sync word       (0x34 in SX126x form; to confirm on hardware)
AT+IQINVER=0             → normal IQ
AT+CAD=1                 → listen before sending
AT+P2P=923300000:8:2:0:8:20   → listen setting    (frequency:SF:bandwidth code 2 = 500 kHz:CR code 0 = 4/5:preamble:power)
AT+PRECV=65533           → listen continuously, still allowed to send
```

Send one burst (all fragments of a packet):
```
AT+PRECV=0               → stop listening
AT+P2P=904600000:8:2:0:8:20   → transmit setting (us915-b only)
AT+PSEND=<hex>           → OK, then +EVT:TXP2P DONE        (repeat per frame)
AT+P2P=923300000:8:2:0:8:20   → back to the listen setting (us915-b only)
AT+PRECV=65533
```

Receive: `+EVT:RXP2P:<rssi>:<snr>:<hex>` → a `ReceivedFrame`.

Details:
- MTU 250. The manual allows 2 to 500 hex digits for `AT+PSEND`, which is 250 bytes (it also says 256; we use 250 until tested).
- Retuning costs several command round trips. `turnaroundMs` is 300 ms until measured **(guess)**. The frame layer retunes once per burst, not per frame.
- The module can't sense the channel except through CAD, so `channelBusy` is absent.
- Some RAK3172 boards have a TCXO and some don't, and RUI3 builds differ for the two. If the board doesn't answer in P2P mode, that's the first thing to check.

### 14.7 Repurposing the miner

The miner stops serving Helium while it's repurposed. Every path below can be undone.

**Check first.**
1. **Which model and concentrator.** The label on the case, then open the case (screws underneath) and read the HAT: RAK2245 (V1) or RAK2287 (V2). The concentrator is band-specific: its label should say US915.
2. **The antenna is attached.** Never transmit without it.
3. **Network.** Plug it into Ethernet and find its address from the router.
4. **SSH.** Try to log in. If you can, run `docker ps` to see what runs, and find the packet forwarder's `global_conf.json`. On Helium images the forwarder usually points at a local Helium service on UDP port 1680 **(guess)**.
5. **Boot medium.** Most units boot from a microSD card on the Pi inside the case **(guess)**.

**Path A: keep the current card (only if SSH works).** Copy the forwarder's configuration aside. Stop the Helium containers. Either point the forwarder at our server (`server_address` = the laptop's address, `serv_port_up` and `serv_port_down` = 1700), or run our gateway on the Pi on the port the forwarder already uses. To undo, restore the file and restart the containers.

**Path B: a second microSD card (recommended).** Take out the original card, label it and put it away. On a new card, with Raspberry Pi Imager, install Raspberry Pi OS Lite with SSH and the network set. Then, on the Pi:
1. `sudo raspi-config`: turn on SPI (and I2C, which RAK's tools expect).
2. Install Docker.
3. Run RAK's packet forwarder container, `rakwireless/udp-packet-forwarder`, with:
   - `MODEL=RAK7248` for a V2 (RAK2287), or `MODEL=RAK2245` for a V1;
   - `BAND=us_902_928`;
   - `SERVER_HOST` = the address running our `GwmpServer` (or `127.0.0.1` if it runs on the Pi), `SERVER_PORT=1700`.
   The container can find the concentrator itself, and has a `find_concentrator` tool if that fails. For plan `us915-a`, give it a custom `global_conf.json` with `tx_freq_min` lowered.

   RAK's other installer, `rak_common_for_gateway`, does the same without Docker (choose the model, then edit the server with `gateway-config`). Either works.
4. To undo, put the original card back.

**First test.** Start `mesh gateway --gwmp 1700`. It should print a PULL_DATA from the gateway's EUI every 10 seconds. Then run `mesh ping` on the laptop with the RAK3172: the gateway should log the frame's RSSI and SNR, and the node should hear the ACK.

### 14.8 RNode (KISS over serial): later

If the convener later uses ordinary LoRa boards (Heltec, LilyGO, RAK4631) flashed with RNode firmware, `RNodeLink` talks to them over USB serial at 115200 baud with KISS framing, written by us from the published command list:

- Frames: `FEND 0xC0 | command | data | FEND`. In data, 0xC0 becomes `0xDB 0xDC` and 0xDB becomes `0xDB 0xDD`.
- Configure: frequency `0x01` (4 bytes, Hz), bandwidth `0x02` (4 bytes, Hz), TX power `0x03` (1 byte, dBm), SF `0x04`, coding rate `0x05` (5–8), radio on `0x06 0x01`, short- and long-term airtime locks `0x0B` and `0x0C` (2 bytes, hundredths of a percent). The firmware echoes each value. The adapter compares and fails to open on a mismatch.
- Data `0x00`. The firmware adds a 1-byte header to each LoRa packet, and splits host frames over 254 bytes into two packets that are lost together. So MTU 254, and we never send more.
- Received data comes after an RSSI frame `0x23` and an SNR frame `0x24`. Errors are `0x90` with a code.
- Detect: send `0x08 0x73`, expect `0x08 0x46`. Firmware version `0x50`, platform `0x48`, MCU `0x49`.
- The firmware does its own carrier sense and enforces the airtime locks, which we set from the region preset.

RNode uses one frequency for sending and receiving, so with the miner it can only do plan `us915-a`, or retune per burst over KISS.

### 14.9 Other radios considered

| Option | Verdict |
|---|---|
| Meshtastic devices | Not supported as a link. We don't use Meshtastic's client libraries or protocol definitions (repository dependency rules). Its own mesh would also add headers, routing and a payload cap of about 230 bytes. We detect it and say "reflash or use another board". |
| SX127x/SX126x on a Raspberry Pi over SPI | Later, maybe. It needs a driver we write ourselves over `spi-device` and GPIO. The existing npm drivers are 2022 experiments. |
| LoRaWAN through a network server | A non-goal (section 3). |

### 14.10 Detecting the radio

`mesh detect` and `detectRadio()`:
1. **UDP**: listen on port 1700 for 15 s. A PULL_DATA means a LoRaWAN gateway: print its EUI and address.
2. **Serial ports**: list them with their USB ids. CP210x, CH340 and CH9102 bridges, and native ESP32-S3 and nRF52 ports, hint at the board family, not the firmware.
3. On each port at 115200 baud, **listen** for 1.5 s. Bytes `0x94 0xC3` (Meshtastic's frame marker) or a Meshtastic log line mean Meshtastic.
4. **KISS probe**: `FEND 0x08 0x73 FEND`. A reply `0x08 0x46` means RNode. Then ask the firmware version.
5. **AT probe**: `AT\r\n`. `OK` means an AT modem. Then `AT+VER=?` (RUI3) or `AT+VER` (Seeed's LoRa-E5 family).
6. Otherwise print what was heard.

The probes are safe in this order: an AT modem ignores a KISS frame, and RNode firmware ignores text outside KISS framing.

### 14.11 Bluetooth LE (milestone 2)

**Service.** One GATT service with a fixed 128-bit UUID (generated once, at build time) and three characteristics:
- `frames-in`: write, from the central to the peripheral;
- `frames-out`: notify, from the peripheral to the central;
- `info`: read, CBOR `{version, mtu, role, keyHint}`.

Frames are the same mesh frames as on LoRa.

**Roles.** Fixed things are peripherals: the door, a gateway. People's devices are centrals, so they never advertise.

**MTU.** The default ATT MTU is 23 (20 bytes of data). Most phones and laptops negotiate up to 517. The peripheral learns the negotiated MTU and publishes it in `info`. Notifications are limited to MTU − 3. Web Bluetooth writes of up to 512 bytes work through long writes. So the link's MTU is min(512, notification size).

**Reliable.** The BLE link layer retransmits, so `reliable: true`.

**Platforms.**
- Node: `@stoprocent/noble` (central) and `@stoprocent/bleno` (peripheral), maintained forks of noble and bleno. The `@abandonware` versions were last published in February 2025.
- Browser: Web Bluetooth in Chrome and Edge on desktop and Android. Central only, over HTTPS or localhost, after a click. Not in Safari, iOS or Firefox.

**Speed.** A guest pass takes one or two frames and well under 100 ms. Bluetooth is the better link for a door. LoRa is for range.

### 14.12 Sneakernet: bundles

A **bundle** is a file (`.toipbundle`) of queued TSP messages:

```
CBOR ["toip-bundle", 1, createdMs, sealed, body]
  body (unsealed) = [[to VID, TSP bytes], ...]
  body (sealed)   = HPKE base to the courier's X25519 key, info "zk-toip/mesh/bundle/v1", of the unsealed body's CBOR
```

- `mesh.exportBundle({ sealTo })` takes messages from the outbox and marks them `carried`.
- A courier with internet runs `mesh courier post file.toipbundle --relay wss://…`. That posts each message through a `RelayTransport` signed in as the courier. Recipients see ordinary TSP messages from the original senders.
- A courier without internet keeps the file and passes it on.
- The courier, if the bundle isn't sealed to it, learns the VIDs. It can drop messages. It can't read or change them.
- QR (phase 2): a compact presentation (477 B) fits in one QR code. Larger bundles need a sequence of codes. Libraries: `qrcode` to draw, `jsqr` to read.

Bundles carry full TSP bytes, not mesh packets, because they don't cross a broadcast medium and don't need to fit in frames.

## 15. Expected performance

For the MVP's two messages (MTU 250, 8-byte frame header, 11-byte ACK, 82-byte beacon):

**Door exchange**: beacon, a 559-byte INTRO presentation (3 frames), ACK, a 271-byte response (2 frames), ACK. Airtime only. Add about 0.3 to 1 s of turnarounds.

| Setting | Airtime | Door openings per hour within budget |
|---|---|---|
| US, SF8 / 500 kHz (`us915-b`) | 0.72 s | about 1,200 (10% fair share; the door transmits 0.29 s each time) |
| US, SF7 / 500 kHz | 0.41 s | about 2,200 |
| EU, SF7 / 125 kHz, 1% | 1.63 s | about 54 (the door's 0.66 s of transmit) |
| EU, SF7 / 125 kHz, 10% (g3) | 1.63 s | about 540 |
| EU, SF10 / 125 kHz, 1% | 9.5 s | about 9 |
| EU, SF12 / 125 kHz, 1% | 37.8 s | about 2 |
| Bluetooth | under 0.1 s | not limited |
| Same exchange as plain JSON TSP, EU SF7 | 2.95 s for the presentation alone (8 frames) | |

**Attestation through a gateway**: a 552-byte VIA packet (3 frames) and its custody receipt.

| Setting | One hop | Two hops (via a relay) |
|---|---|---|
| US, SF8 / 500 kHz | 0.43 s | 0.9 s |
| EU, SF7 / 125 kHz | 0.96 s | 1.9 s |
| EU, SF10 / 125 kHz | 5.5 s | 11 s |
| EU, SF12 / 125 kHz | 22 s | 44 s |

Range (guess, open country, stock antennas): SF7 / 125 kHz 1 to 3 km. SF8 / 500 kHz about the same as SF7 / 125 kHz, maybe a little less. SF12 10 km or more. Indoors, much less. To be measured.

With 20% frame loss, a 3-frame packet needs on average about 1.5 rounds. The test plan sets the bar at 99% delivered within 4 rounds.

## 16. MVP scope

**Built**, in this order:

1. **trust-core**: the body codec hook in `Endpoint` and the CTT1 codec (section 19.3), with tests.
2. **`packages/mesh-transport`**:
   - frame and packet encoders and decoders; `splitTsp` and `joinTsp`;
   - keys, address tags and MACs; contacts;
   - fragmentation, reassembly, selective ACKs, retries, the seen list;
   - routes: direct, flood (ttl up to 3), gateway upstream; the outbox with a store;
   - the airtime scheduler and region presets;
   - `MeshTransport`; `MeshGateway` (upstream and custody receipts); door `ChallengeBeacon`;
   - `VirtualScheduler`, `SimMedium` and `SimLink`;
   - `GwmpServer` and `GwmpLink`; `RakP2PLink`; the Node serial wrapper; `detectRadio`;
   - bundles: export, open, post.
3. **`projects/mesh`**:
   - `src/demo.ts`: the narrated simulator demo (section 17), `npm run demo --workspace @zk-toip/mesh`;
   - `src/cli.ts`: `mesh detect`, `mesh gateway`, `mesh node`, `mesh ping`, `mesh door`, `mesh guest`, `mesh attest`, `mesh courier`;
   - the demo's Trust Task specs: `ourSpec("mesh-demo/door/open")`, with request `{credential, challenge}` and response `{open, reason?}`. The attestation uses Settle's `ESCROW_ATTEST` spec and `attest()` document, imported from `@zk-toip/settle` (the root `package.json` adds `projects/mesh` to its workspaces).

**Demoed**: the whole script on the simulator; acts 1 and 2 on the miner and one RAK3172.

**Not in the MVP**: Bluetooth (milestone 2, right after), RNode, downstream through gateways and courier grants, carriers, QR codes, the PUBLIC kind, per-spec payload schemas, padding, community MACs, the Heltec firmware, plan `us915-a` (tried, not promised).

## 17. Demo script

Cast: **the Building** (issues passes; online), **Rosa** (dog walker, holds a pass on her laptop), **the Front Door** (kiosk; offline), **Alice** (tenant, at a cabin with no signal), **the Ridge** (a solar relay node, simulator only), **the Lodge** (a gateway with internet), **Joe's agent and the landlord's agent** (Settle parties, online at home).

**Act 0, setup (internet).** The Building issues Rosa a guest pass for the front door, weekdays 12:00 to 14:00, bound to her pass key. The door has cached the Building's DID and revocation list. A Settle payment is open for the sink repair, with Alice as attester.

**Act 1, the door with no internet.**
```
door   BEACON  82 B   64 ms   challenge 9f3a…c1
rosa   DATA 1/3  250 B  172 ms   pid 7c21e0aa  INTRO
rosa   DATA 2/3  250 B  172 ms
rosa   DATA 3/3   83 B   67 ms
door   ACK  11 B   21 ms   all 3
door   opened: a valid pass from household 4B, "dog walker", now within its window. Challenge signed by the pass key.
door   DATA 1/2  250 B  172 ms   pid 1b9e4402  PAIR
door   DATA 2/2   37 B   36 ms
rosa   ACK
rosa   ✓ door/open#response {open: true}   0.72 s on air, about 1.8 s from beacon to answer
       As plain JSON TSP: 8 frames for the presentation alone.
       What a listener heard: 7 frames. Sizes. Random 4-byte tags. No DIDs, no pass, no names.
```
The narration then repeats it with 20% frame loss (the ACK shows a gap; one fragment resent). Then an attacker replays Rosa's frames 2 minutes later: dropped as a duplicate, and refused after a restart because the challenge is stale.

**Act 2, the attestation from the cabin.** Alice selects "work complete". Her device has no internet but hears the Lodge's beacon through the Ridge.
```
alice  VIA 3 frames → ridge (ttl 1) → lodge
lodge  opened route block: from alice to the landlord's agent; rebuilt TSP; posted to the relay
lodge  RECEIPT custody, signed      alice: post() → "queued"
landlord's agent  received settle/escrow/attest from alice (via the relay) — verifies as usual
```
On real hardware the Ridge is skipped: Alice's laptop and RAK3172 talk to the miner directly, and the miner's host runs the Lodge.

**Act 3, the gateway is down.** Alice attests again (a second payment). No beacon is heard, so the message stays in her outbox. She exports a sealed bundle to a USB stick for a neighbor driving to town. The neighbor's laptop posts it; the landlord's agent receives it.

**Act 4, the rules (simulator).** Set the region to EU, 1%, SF12. Alice sends 20 readings. The scheduler spaces them out, and the narration shows the budget. No `RegulatoryViolation`.

On real hardware, act 1 runs on one laptop: the door's endpoint uses the miner through `GwmpLink`; Rosa's endpoint uses the RAK3172 through `RakP2PLink`. That's two radios, two processes, one machine.

## 18. Test plan

All in vitest, on the simulator unless marked.

**Encoding**
- CTT1 round-trips for fixed vectors (the four messages of section 5) and for 10,000 random JSON documents. Proofs verify after decoding. The encoder falls back to JSON when a value doesn't round-trip (odd timestamps, upper-case UUIDs, numbers like `1e400`).
- Size snapshots: each reference message stays at or under its measured size.
- `splitTsp` and `joinTsp` are byte-exact for 1,000 random messages, with did:key and other VIDs. Routed and Nested messages go RAW.
- Packet and frame encoders: every kind, every length boundary. A fuzzer feeds random bytes to every decoder: nothing throws out, nothing hangs.

**Keys and tags**
- Both sides derive the same keys. A wrong contact never matches. A forced tag collision is dropped at the signature check.
- INTRO opens only for the addressee. VIA route blocks open only for the hinted gateway.

**Fragmentation and MTU**
- Every packet size from 1 byte to the 64-fragment limit, on MTUs 20, 24, 66, 138, 250, 254 and 512. Over the limit gives `"undelivered"`.
- No frame ever exceeds the link's MTU or its frame cap.

**Loss, reordering, duplicates**
- Fixed loss of 0, 5, 20 and 40%, and Gilbert-Elliott bursts, over 200 seeds each. At 20%, at least 99% of 3-frame packets arrive within 4 rounds. The airtime overhead is reported.
- Lost ACKs: the sender resends; the receiver re-acknowledges and never delivers twice.
- Injected duplicates and reordered frames: delivered once, intact.
- Corrupted bytes: the packet hash catches it.

**Half-duplex and collisions**
- Two senders at once; hidden terminals (A and C both reach B, not each other); the capture effect.
- The gateway mode: a node can't hear itself, and hears its 9 receive settings at once.

**Duty cycle and caps**
- 24 simulated hours of heavy traffic under `eu868-g1`, `eu868-g3` and `us915`: no `RegulatoryViolation`. ACKs keep their reserve. A full budget gives `"queued"`, and sending resumes on its own.

**Routing**
- A line of 4 nodes with ttl 3: delivered; the receipt comes back. Ttl runs out where it should.
- A 10-node grid: every packet is transmitted at most 10 times in all.
- Route choice: direct, then flood, then gateway, then outbox, as nodes come and go.

**Gateway**
- Upstream to a real relay started in the test (`startRelay` on a temporary SQLite file): the recipient's `Endpoint` opens the message and sees the original sender.
- Custody receipts verify. A resent VIA packet is posted once. The gateway restarts in the middle and remembers.

**Attacks**
- Replayed frames after 1 minute and after 1 day; a stale challenge; a forged ACK; a forged custody receipt; junk frames; a frame claiming 64 fragments then nothing; a flood of INTROs. Each is dropped or refused, and nothing grows without bound.

**Endpoint over the mesh**
- `request` and `notify` between two `Endpoint`s over `MeshTransport`, with timeouts from `estimate()`.
- The door flow end to end, and the Settle attestation end to end.

**Bundles**
- Export, seal, open only by the courier, post through a test relay, deliver.

**Adapters, without hardware**
- GWMP: a fake packet forwarder (a UDP socket in the test) plays recorded PUSH_DATA, PULL_DATA and TX_ACK datagrams, including errors and silence.
- RUI3: a fake serial port answers from a script of recorded transcripts, including `AT_BUSY_ERROR` and a module restart.
- Detection: fake UDP and serial ports for a gateway, RUI3, RNode, Meshtastic and silence.

**On the hardware (manual, logged)**
- Fifty door exchanges at 2 m, 50 m and as far as it works: success rate, rounds, RSSI and SNR, measured against computed airtime.
- Fifty attestations through the miner to a relay.

## 19. Shared library needs

### 19.1 `packages/mesh-transport` API

Subpath exports keep Node-only code out of browser builds.

```ts
// ---- "@zk-toip/mesh-transport" (runs in browsers and Node)
import type { Delivery, Identity, Transport, RelayTransport } from "@zk-toip/trust-core";

// Time
export interface Scheduler { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }
export const realScheduler: Scheduler;
export class VirtualScheduler implements Scheduler {
  constructor(startMs?: number);
  now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void;
  advance(ms: number): Promise<void>;
  runUntilIdle(opts?: { maxMs?: number }): Promise<void>;
}

// Links (section 13)
export type { Link, LinkInfo, LinkState, ReceivedFrame } from "./link";
export interface AirtimePolicy { windowMs: number; maxFraction: number; maxFrameMs?: number; ackReserve?: number }

// Radio settings, plans, airtime
export interface LoRaSetting {
  frequencyHz: number; spreadingFactor: 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;
  bandwidthHz: 62500 | 125000 | 250000 | 500000; codingRate: 5 | 6 | 7 | 8;
  preambleSymbols: number; syncWord: "public" | "private"; invertIq: boolean; txPowerDbm: number;
}
export interface ChannelPlan { name: string; tx: LoRaSetting; rx: LoRaSetting; mtu: number; budget: AirtimePolicy }
export function loraAirtimeMs(payloadBytes: number, s: LoRaSetting): number;
export function maxBytesUnder(ms: number, s: LoRaSetting): number;
export const plans: Record<"us915-b-node" | "us915-b-gateway" | "us915-a" | "eu868-g1" | "eu868-g3", ChannelPlan>;
export const regions: Record<"us915" | "eu868-g1" | "eu868-g3" | "none", AirtimePolicy>;

// Contacts and stores
export interface Contact {
  vid: string; signingKey: Uint8Array; encryptionKey: Uint8Array; introduced: boolean;
  heard?: { atMs: number; hops: number; link: string; rssi?: number };
}
export interface ContactStore { load(): Promise<Contact[]>; save(contacts: Contact[]): Promise<void> }
export interface MeshOutboxItem {
  pid: string; to: string; wire: Uint8Array; createdMs: number; attempts: number; nextTryMs: number;
  state: "pending" | "custody" | "carried";
}
export interface MeshOutboxStore { load(): Promise<MeshOutboxItem[]>; save(items: MeshOutboxItem[]): Promise<void> }
export const memoryContacts: () => ContactStore;
export const memoryOutbox: () => MeshOutboxStore;

// The transport
export interface MeshOptions {
  identities: Identity[];                 // every local VID; attach() must name one of them
  links: Link[];
  scheduler?: Scheduler;
  contacts?: ContactStore;
  outbox?: MeshOutboxStore;
  gateways?: { vid: string }[];           // gateways this node may use
  relay?: boolean;                        // repeat flooded packets (default true for fixed nodes, false for phones)
  flood?: { maxTtl: number; relayShare: number };
  arq?: { maxRounds: number; burst: number };
  postWaitMs?: (bytes: number) => number;
  acceptIntros?: boolean | ((sender: string) => boolean);
  onEvent?: (e: MeshEvent) => void;
}

export type MeshEvent =
  | { type: "frame-out"; link: string; bytes: number; airtimeMs: number; summary: string }
  | { type: "frame-in"; link: string; bytes: number; rssi?: number; snr?: number; summary: string }
  | { type: "packet-in"; pid: string; kind: PacketKind; forMe: boolean }
  | { type: "retry"; pid: string; round: number; missing: number[] }
  | { type: "delivered"; pid: string; to: string; route: "direct" | "flood" | "gateway" }
  | { type: "custody"; pid: string; gateway: string }
  | { type: "queued"; pid: string; reason: "no-route" | "no-airtime" | "no-answer" }
  | { type: "budget"; link: string; usedFraction: number; waitMs: number; warning?: string }
  | { type: "dropped"; reason: string };

export class MeshTransport implements Transport {
  constructor(opts: MeshOptions);
  start(): Promise<void>;
  stop(): Promise<void>;
  attach(vid: string, deliver: (wire: Uint8Array) => Promise<void>): void;
  detach(vid: string): void;
  post(from: string, to: string, wire: Uint8Array): Promise<Delivery>;
  addContact(vid: string): void;                 // resolves did:key; other VIDs need addContactKeys
  addContactKeys(c: Omit<Contact, "introduced">): void;
  supportsCompact(vid: string): boolean;         // for Endpoint's bodyCodecFor (section 19.3)
  estimate(to: string, bytes: number): { frames: number; airtimeMs: number; route: string };
  suggestedTimeoutMs(to: string, bytes: number): number;
  pending(): number;
  neighbors(): Contact[];
  exportBundle(opts?: { sealTo?: string; to?: string[] }): Promise<Uint8Array>;
  onBeacon(fn: (b: BeaconInfo) => void): () => void;
  stats(): MeshStats;
}

export interface BeaconInfo { role: "verifier" | "gateway"; vid: string; nonce?: Uint8Array; atMs: number; rssi?: number }
export interface MeshStats { framesOut: number; framesIn: number; airtimeMs: number; retries: number; delivered: number; dropped: Record<string, number> }

// Door challenges
export class ChallengeBeacon {
  constructor(opts: { identity: Identity; mesh: MeshTransport; everyMs?: number; keep?: number });
  start(): void; stop(): void;
  current(): Uint8Array;
  isFresh(nonce: Uint8Array): boolean;           // one of the last `keep` nonces (default 2)
}

// Gateways
export interface GatewayStore { has(pid: string): Promise<boolean>; record(pid: string, receipt: Uint8Array): Promise<void>; receipt(pid: string): Promise<Uint8Array | undefined> }
export class MeshGateway {
  constructor(opts: { identity: Identity; mesh: MeshTransport; relay: RelayTransport; store?: GatewayStore; beaconEveryMs?: number });
  start(): Promise<void>; stop(): Promise<void>;
  stats(): { forwarded: number; duplicates: number; failed: number };
}

// Bundles
export function exportBundle(items: { to: string; wire: Uint8Array }[], opts?: { sealTo?: { vid: string; encryptionKey: Uint8Array } }): Promise<Uint8Array>;
export function openBundle(bytes: Uint8Array, me?: Identity): Promise<{ to: string; wire: Uint8Array }[]>;
export function postBundle(items: { to: string; wire: Uint8Array }[], relay: RelayTransport): Promise<{ posted: number; refused: number }>;

// Low-level codecs, for tests and sibling projects
export interface TspParts { senderVid: string; receiverVid: string; enc: Uint8Array; ct: Uint8Array; signature: Uint8Array }
export function splitTsp(wire: Uint8Array): TspParts;          // throws on Routed or Nested
export function joinTsp(p: TspParts): Uint8Array;
export type PacketKind = "pair" | "intro" | "via" | "down" | "receipt" | "raw" | "public";
export function encodePacket(p: Packet): Uint8Array;
export function decodePacket(bytes: Uint8Array): Packet | null;
export function encodeFrame(f: Frame): Uint8Array;
export function decodeFrame(bytes: Uint8Array): Frame | null;
export function fragment(packet: Uint8Array, mtu: number, h: { ttl: number; hops: number; attempt: number }): Uint8Array[];
export function packetId(packet: Uint8Array): Uint8Array;      // H(packet)[0..4]
export function estimate(packetBytes: number, link: LinkInfo): { frames: number; airtimeMs: number };

// ---- "@zk-toip/mesh-transport/sim"
export class SimMedium {
  constructor(opts: { scheduler: VirtualScheduler; seed: number; captureDb?: number });
  node(name: string, params: SimRadioParams): SimLink;
  connect(a: string, b: string, q?: { loss?: number; burst?: GilbertElliott; rssi?: number; snr?: number; both?: boolean }): void;
  disconnect(a: string, b: string): void;
  power(name: string, on: boolean): void;
  inject(fault: SimFault): void;
  records(): readonly SimRecord[];
  subscribe(fn: () => void): () => void;
}
export interface SimRadioParams {
  setting: LoRaSetting | { tx: LoRaSetting; rx: LoRaSetting[] };   // several rx settings = a gateway
  mtu: number; budget: AirtimePolicy; turnaroundMs?: number; serialLatencyMs?: number;
}
export class SimLink implements Link { /* section 13 */ }
export class RegulatoryViolation extends Error {}

// ---- "@zk-toip/mesh-transport/gwmp" (Node)
export class GwmpServer {
  constructor(opts: { port?: number; host?: string; allow?: { eui: string; address?: string }[]; log?: (s: string) => void });
  start(): Promise<void>; stop(): Promise<void>;
  onGateway(fn: (link: GwmpLink) => void): () => void;           // one link per gateway EUI
  link(eui: string): GwmpLink | undefined;
}
export class GwmpLink implements Link { readonly eui: string; constructor(server: GwmpServer, eui: string, plan: ChannelPlan) }

// ---- "@zk-toip/mesh-transport/serial" (SerialPortLike wrappers)
export interface SerialPortLike {
  readonly label: string;
  open(): Promise<void>; close(): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  onData(fn: (bytes: Uint8Array) => void): () => void;
}
export function nodeSerialPort(path: string, baud?: number): SerialPortLike;       // Node, "serialport"
export function webSerialPort(port: SerialPort, baud?: number): SerialPortLike;     // browser, Web Serial
export function listSerialPorts(): Promise<{ path: string; vendorId?: string; productId?: string; hint?: string }[]>;

// ---- "@zk-toip/mesh-transport/rak"
export class RakP2PLink implements Link { constructor(opts: { port: SerialPortLike; plan: ChannelPlan; cad?: boolean }) }

// ---- "@zk-toip/mesh-transport/rnode" (later)
export class RNodeLink implements Link { constructor(opts: { port: SerialPortLike; plan: ChannelPlan }) }
export function kissEncode(command: number, data: Uint8Array): Uint8Array;
export class KissDecoder { push(bytes: Uint8Array): { command: number; data: Uint8Array }[] }

// ---- "@zk-toip/mesh-transport/detect"
export type RadioDetection =
  | { kind: "gwmp-gateway"; eui: string; address: string }
  | { kind: "rak-rui3"; port: string; version: string }
  | { kind: "seeed-at"; port: string; version: string }
  | { kind: "rnode"; port: string; firmware: string; platform?: number; mcu?: number }
  | { kind: "meshtastic"; port: string }
  | { kind: "unknown"; port?: string; heard: string };
export function detectRadios(opts?: { udpPort?: number; timeoutMs?: number }): Promise<RadioDetection[]>;

// ---- "@zk-toip/mesh-transport/ble" (milestone 2)
export const MESH_GATT: { service: string; framesIn: string; framesOut: string; info: string };
export class BlePeripheralHost { constructor(opts: { name: string; keyHint: Uint8Array }); start(): Promise<void>; stop(): Promise<void>; onConnection(fn: (link: Link) => void): () => void }
export function nodeBleCentral(opts?: { timeoutMs?: number }): Promise<Link>;
export function webBluetoothLink(device: BluetoothDevice): Promise<Link>;
```

### 19.2 How `MeshTransport` implements `Transport`

- **`attach(vid, deliver)`**: `vid` must be one of `opts.identities`. The transport computes tags for packets addressed to it and calls `deliver(wire)` with rebuilt TSP bytes. It passes only the wire: the `Endpoint` already handles transports that don't pass a `WireRecord`.
- **`post(from, to, wire)`**: `splitTsp(wire)`; check that its VIDs are `from` and `to`; add `to` as a contact if new; choose a route and a packet kind (section 10.1); store the item in the outbox; hand it to the frame layer; resolve as in section 9.6.
- **`detach(vid)`**: stop delivering to it. Packets for it are dropped after reassembly.
- **Endpoints on the mesh** should set `timeoutMs` from `mesh.suggestedTimeoutMs()`, and a 10-minute clock skew in `freshness` (section 6).

### 19.3 Changes to trust-core

1. **A body codec** (`packages/trust-core/src/compact.ts`):
   ```ts
   export interface BodyCodec {
     readonly format: number;                                    // first body byte: 0x01 for CTT1
     encode(doc: TrustTaskDocument<unknown>, ctx: { sender: string; receiver: string }): Uint8Array | null;  // null: can't, use JSON
     decode(body: Uint8Array, ctx: { sender: string; receiver: string }): TrustTaskDocument<unknown>;
   }
   export const ctt1: BodyCodec;
   export function encodeBody(doc: TrustTaskDocument<unknown>, ctx: { sender: string; receiver: string }, codec?: BodyCodec): Uint8Array;
   export function decodeBody(body: Uint8Array, ctx: { sender: string; receiver: string }): TrustTaskDocument<unknown>;
   ```
   The codec lives in trust-core, not in the mesh library, so that **every** endpoint in the repository can open a compact message a gateway delivers from the mesh.
2. **`Endpoint` options**: `bodyCodecFor?: (to: string) => BodyCodec | undefined` (default: JSON for everyone), and `replayGuard?` (so a door that restarts keeps its replay record).
3. **`Endpoint` internals**:
   - pack with `vti-tsp-js`'s `pack(encodeBody(...))` instead of `packTrustTask`;
   - receive with `unpack`, then `decodeBody` (dispatching on the first byte), then build `{document, transport: new TspTransport(local, sender)}` for `consumer.consume`;
   - pack replies itself, with the same codec choice, instead of `consumer.packReply` (which always writes JSON).

   trust-core gains a direct dependency on `@openvtc/vti-tsp-js` 0.2.0, already installed through `@openvtc/trust-tasks-tsp`.
4. **`request(to, spec, payload, opts?: { timeoutMs })`**: a per-call timeout, because one endpoint may talk over Bluetooth and LoRa.

None of this changes behavior for existing apps: they keep sending JSON, and gain the ability to read CTT1.

### 19.4 Changes to the relay (phase 2)

- **Courier grants**: a frame `{t: "collect", grant}`. The grant is signed by the mailbox owner: `toip-relay-grant/v1|<relay url>|<owner did>|<collector did>|<expires>`. The collector is already signed in as itself. It may then receive and acknowledge the owner's messages. Used by gateways (downstream) and couriers.
- Per-gateway limits: a gateway posts for many senders, so the relay's per-sender limit should be configurable per DID.

### 19.5 For sibling projects

**Capture: the frame budget.**
- One LoRa frame carries 242 bytes of packet (250 minus the 8-byte frame header). One Bluetooth frame carries up to 504.
- A TSP-sealed Trust Task in CTT1 costs about 240 bytes before any payload. **It never fits in one LoRa frame.**
- **Budget: a sensor message is at most 2 frames.** That's 484 bytes as a PAIR packet, so about 240 bytes of CTT1 payload. Through a gateway (VIA, 119 bytes more), about 120 bytes of payload in 2 frames, or 360 in 3.
- So **batch readings**: one message per batch, one signature per batch. A compact reading is a time offset from the batch start (2 to 4 bytes), a value as a scaled integer (2 to 4 bytes) and a kind (1 byte): 20 to 40 readings per 2-frame message. If each reading must be verifiable on its own by third parties, sign a Merkle root once, not each reading.
- Public readings (PUBLIC kind, phase 2) cost 74 bytes of overhead: up to about 168 bytes of body in one frame.
- At US SF8 / 500 kHz, a 2-frame message is 0.35 s of airtime: about 1,000 messages an hour within the 10% fair share. At EU SF10 at 1%, about 4.5 s: 7 messages an hour.
- Please propose the reading format against these numbers. We'll add its keys to the CTT1 dictionary, or a per-spec schema.

**Trail.** A witness receipt (an event digest plus a signature) fits in a 2-frame message, or 1 frame as a PUBLIC datagram. Key event logs are larger and should sync over Bluetooth or the internet.

**Agora and Tipline.** ZK proofs of several kilobytes are Bluetooth-only in practice (section 4.1). And a radio reveals its location, so mesh links are not for anonymous senders.

**Agents.** An agent on a field device works over the mesh with longer timeouts. Delegations and mandates should be fetched before going offline.

### 19.6 Dependencies

| Package | Version checked | Used for | When |
|---|---|---|---|
| `cborg` | 6.2.1 (no dependencies) | CTT1 encoding in trust-core. A small encoder of our own is the fallback; the design's prototype used one. | MVP |
| `serialport` | 13.0.0 | the RUI3 and RNode adapters in Node | MVP |
| `node:dgram` | built in | GWMP | MVP |
| `@noble/curves`, `@noble/hashes`, `@noble/ciphers`, `@openvtc/vti-tsp-js` | already in the repo | X25519, HKDF, HMAC, ChaCha20-Poly1305, HPKE base mode, CESR | MVP |
| `@stoprocent/noble` | 2.8.0 | BLE central in Node | milestone 2 |
| `@stoprocent/bleno` | 0.13.1 | BLE peripheral in Node | milestone 2 |
| `qrcode`, `jsqr` | 1.5.4, 1.4.0 | QR bundles | phase 2 |
| Web Serial, Web Bluetooth | browser APIs | browser adapters | milestone 2 |

Not used: Meshtastic's libraries and protocol definitions; the Reticulum stack; RNode firmware code. We talk to RNode firmware over its serial protocol, with KISS code we write. On the miner we run Semtech's and RAK's packet forwarder as a separate program, not as part of our code.

## 20. Hardware questions for the convener

1. **Which miner exactly?** V1 or V2, and what's printed on the concentrator HAT inside (RAK2245, RAK2287)? A photo of the label and the HAT would settle it.
2. **Which region is printed on it?** We assume US915. If it's EU868 or AS923, the plans change (section 14.4).
3. **Can you log in to it by SSH**, and does it boot from a microSD card? Are you happy to use a second card (path B) so the Helium setup stays intact?
4. **Is its antenna attached**, and is it the original one?
5. **Will you buy a RAK3172 board** (US915 variant, USB, antenna)? One for the demo, two if you'd like node-to-node later.
6. **Where will our gateway program run:** on the Pi, or on your laptop on the same network?
7. **Do you hold an amateur radio license?** If so, note that amateur rules in many countries forbid encrypted traffic, so this project must stay on the unlicensed ISM band.
8. **Any other LoRa networks near you** (a Helium or Meshtastic community)? They use the same channels; we'd pick the quietest.
9. **For the demo, door distance:** across a room, or across a street? It decides the spreading factor.
10. **Bluetooth:** is a Chrome laptop and an Android phone available for milestone 2?

## 21. Open questions

- **A compact body in the TSP binding.** The Trust Tasks TSP binding defines the JSON body. CTT1 is our extension. Should we propose it to the Trust Tasks task force as a "compact" binding profile?
- **Two signatures.** Each message carries a TSP signature and a Data Integrity proof: 128 bytes of signatures, half a frame. HPKE-Auth already authenticates the sender to the recipient. A mesh-only profile could drop one, but the TSP signature gives byte compatibility and the proof makes the document portable. We keep both for now.
- **CBOR tags 6 to 11.** Private to CTT1. Register them, or switch to registered tags, before anyone else adopts the format.
- **US rules.** We cap every frame at 400 ms and our own channel use at 10%. Is `us915-a` (one frequency, a fixed channel) acceptable, or should nodes hop over the gateway's 8 channels?
- **Gateway trust.** Who runs gateways, and how does a node learn which to trust: configuration, a credential from the community, or anyone who beacons?
- **Persistent replay guards** for doors and gateways that restart. trust-core's guard is in memory.
- **Clocks.** How should an offline node set its clock? GPS on the miner's HAT, a phone, or trust in the door's challenge only?
- **did:peer VIDs.** The stack uses did:peer:4. Our compaction handles did:key only and falls back to text for others. Worth a CTT1 rule once the repo uses them.
- **Flood parameters.** Delays, suppression counts and the 30% relay share are guesses, to tune in the simulator.
- **Padding.** Pad packets to whole frames to hide sizes? It costs airtime on the last frame. Off by default.
- **Receipts as Trust Tasks.** Custody receipts are mesh packets. Should they be Trust Task documents, so an app can show them as evidence?
- **Web Serial kiosk.** Commons' door is a browser in kiosk mode. Can the door page drive the radio by Web Serial (RAK3172) or reach a GWMP server? Web pages can't open UDP sockets, so GWMP needs a small local helper.

## 22. Sources

What we read, on 2026-11-06. These should become source notes in `docs/sources/`.

| Source | How read | Trust |
|---|---|---|
| This repository: `packages/trust-core/src/*.ts`, `packages/relay/src/server.ts`, `projects/settle`, `projects/commons/docs/design.md` | read in full | primary |
| `@openvtc/vti-tsp-js` 0.2.0 (`message/direct.js`, `message/envelope.js`, `cesr/wire.js`), `@openvtc/trust-tasks-tsp` 0.1.2, `@openvtc/trust-tasks` 0.28.17 freshness rules | installed code, read | primary |
| Our measurements (section 5) and airtime tables (sections 12 and 15) | scratch scripts against trust-core | ours |
| Semtech packet forwarder protocol, `Lora-net/packet_forwarder` `PROTOCOL.TXT` v1.4 | read in full via the GitHub API | primary |
| `Lora-net/sx1302_hal` `packet_forwarder/global_conf.json.sx1250.US915` | read in full via the GitHub API | primary for the stock US915 configuration |
| RAK `udp-packet-forwarder` and `rak_common_for_gateway` READMEs | read via the GitHub API | primary for their settings and supported models |
| RAK RUI3 AT command manual, docs.rakwireless.com | through a page-summarizing fetch tool | summary only; check `AT+PSEND`'s limit and `AT+SYNCWORD`'s format on hardware |
| RAK forum threads on RUI3 P2P receive modes | search summaries | summary only |
| RNode firmware, `markqvist/RNode_Firmware` (`Framing.h`, `Config.h`, `RNode_Firmware.ino`) | read the command constants and transmit path via the GitHub API | primary for the protocol constants |
| Meshtastic serial framing (0x94 0xC3 marker) | search summaries of the Python client and an SDK doc | summary only |
| EU868 sub-band duty cycles | The Things Network's EU868 and duty-cycle pages, a regulator's copy of the ETSI EN 300 220-2 table, via search summaries | secondary |
| US915 dwell time and channel plan | The Things Network's US915 page via search summary; matches the sx1302_hal configuration | secondary; the FCC text (47 CFR 15.247) was not read |
| LoRa time-on-air formula | from memory of Semtech's modem documentation | unverified; check against Semtech AN1200.13 |
| npm registry metadata (`npm view`) for every package in section 19.6 and those rejected | registry | primary for versions and publish dates |
