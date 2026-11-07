# Capture: design

Cameras and sensors with their own identities. A device signs what it captures. Every edit adds a signed link to a chain. Anyone can check where a photo or a reading came from and what was done to it. Date: 2026-11-06.

Choices marked **(our call)** are the assistant's and open to change. A claim about another project's specification cites a source (section 21). A guess is labeled a guess.

## 1. What Capture is, and why

Today a photo or a sensor reading arrives with no evidence. Metadata can be edited in seconds, and nobody can tell a real photo from a generated one by looking. Capture gives each device an identity and makes it sign at the moment of capture:

1. **A device identity.** Each camera or sensor has a DID and keys, and a key history that its owner can rotate. A maker or an owner gives the device credentials: "this is a Model X made by Y", "this camera belongs to the Daily Planet", "this sensor is Station 4, installed at this place".
2. **A signed capture manifest.** At capture, the device signs a small record: the hash of the content, its own clock reading, fresh public randomness that proves "not before", optional location, and what the sensor was.
3. **An edit chain.** An editor (a person's app or an AI tool) makes a new file and signs a manifest that names its parents and what it did. Redaction (blurring a face) keeps provenance: the verifier can prove that every pixel outside the blurred area is exactly what the camera captured, without seeing the original.
4. **Signed sensor readings** small enough for LoRa. A reading is 42 bytes. Readings are hash-chained, and one signed seal of 141 bytes covers a batch.
5. **A verifier** that anyone can run in a browser: drop a file, see the device, owner, capture time, edit chain and any breaks. A sensor dashboard shows which readings are verified.

**The honest core.** A signature proves *which key* signed *these bytes*, and anchors bound *when*. It does not prove the scene was real. A camera pointed at a screen signs the screen. Capture says what it can prove, labels what is only claimed, and shows the difference (section 5).

## 2. Who uses it

| Who | What they need | What Capture gives |
|---|---|---|
| **Journalists and newsrooms** | Show a photo is theirs, unedited except as declared; protect sources by blurring faces | Device and owner credentials, an edit chain, redaction with pixel proofs |
| **Insurers and claims adjusters** | Know a damage photo was taken by the claimant's phone, after the incident, not pulled from the web | Capture time bounds ("after drand round N"), device identity, no gap between capture and submission |
| **Citizen science** (air quality, weather, water) | Readings from many cheap sensors that funders and regulators can trust | Signed readings, installation credentials with location and calibration, a dashboard of verified vs. unverified data |
| **Courts and investigators** | Chain of custody for digital evidence | A verifiable chain from device to exhibit; anchored time; key history |
| **Property managers** (Commons, Settle) | Repair photos as evidence in a Settle escrow (`escrow/attest` carries photos, Settle design §7) | The attester's photos verify on their own |

## 3. Goals, non-goals, anti-goals

**Goals**

1. A browser or phone camera app that signs every photo with a device key the page cannot export.
2. A sensor process (Node, optionally on a Raspberry Pi) that signs readings and sends them over the mesh transport and over the relay.
3. A verifier that runs entirely in the browser and trusts no server, including ours.
4. Edit chains with redaction that keeps provenance.
5. Honest time: every capture shows an interval it can prove, not only the device clock.
6. Device key history with rotation and recovery, using the trail library.
7. A clear relationship with C2PA: read it now, write a compatible export later (section 13).
8. Reuse the trust core: did:key identities for people, TSP messages, Trust Task documents, credentials and status lists, the relay, and Settle's passkey vault.

**Non-goals (for now)**

- Video and audio. Photos and scalar sensor readings only.
- Native apps with hardware key attestation (Apple App Attest, Android Key Attestation). Section 16 lists them as later.
- Detecting fakes from pixels (deepfake detection, screen detection by image analysis).
- Proving location. The MVP only records claimed location (section 10).
- Mainnet anchoring. Devnet or a local cluster only.
- Being on the C2PA trust list.

**Anti-goals**

- **Claiming more than we prove.** A verdict must never say "authentic" or "real". It says "signed by", "captured between", "unchanged except".
- **Trusting the gateway, registry or server.** They help find and carry data. Every check is redone by the verifier.
- **Tracking people by default.** Location is off by default. Device identities don't appear on-chain. All photos from one camera are linkable by its DID, and the camera app says so.
- **Locking the owner out of their own device.** Keys rotate under the owner's control, not a maker's.

## 4. Words used here

- **Device**: a camera app instance or a sensor. It has a **device identifier** (a trail identifier, section 7) and a **capture key** that signs captures.
- **Owner**: the person or organization responsible for the device, with a did:key identity.
- **Maker**: whoever builds or provisions the device and vouches for its hardware. In the MVP, a demo maker.
- **Manifest**: a signed record about one piece of content. A **capture manifest** is signed by a device; an **edit manifest** by an editor.
- **Store**: a bundle of manifests and the evidence needed to check them offline (key logs, credentials, anchors).
- **Anchor**: evidence that bounds time: "not before" (a beacon value the device could not have known earlier) or "not after" (a witness receipt or a chain transaction that includes the manifest's hash).

## 5. Threat model

What a valid signature means: **the holder of a key that the device's key log says was current signed these exact bytes.** Everything else is built on that.

| Threat | What happens | What Capture does | What remains |
|---|---|---|---|
| **Fake camera.** Someone writes their own "camera" that signs anything. | Signatures are valid. | No trusted credential: the verifier says "signed by a device nobody you trust vouches for". Trust comes from credentials issued by owners and makers the verifier chose (a trust list). | A trusted owner can still vouch for a dishonest device. |
| **Owner fakes the input.** The browser feeds a virtual camera (OBS) or a picture into the signing code through dev tools. | The device key signs it. | The manifest records the capture pipeline, the camera track's label and a hash of its device id. The verifier flags known virtual-camera labels. The credential states the key class ("browser key"), so verifiers know the owner controls the browser. | A browser app can't stop its own owner. Only firmware-bound hardware (section 7.2, class H) can, and even that has the analog hole below. |
| **Screen re-photographing** (the analog hole). A real camera photographs a screen showing a fake. | A perfectly valid capture of a screen. | None that is cryptographic. The manifest proves time and device, so "photo of an event" claims can be checked against time bounds. Depth data and moire analysis are later ideas. | Unsolved by any signing scheme, C2PA included. The UX says "signed when captured", never "real". |
| **Stolen device or key.** A thief signs captures with the device. | Valid signatures until the owner acts. | The owner rotates the device's key with the pre-committed recovery key (section 7.4) and revokes the owner credential. Captures signed with a retired key verify fully only if they were anchored before the rotation. | Captures made between theft and rotation, and anchored in that window, look valid. Rotation time is visible, so a verifier can treat that window with suspicion. |
| **Key extracted from a browser.** | A non-extractable WebCrypto key can't be read by page script, but malware on the machine might use it. | Key class is stated. Passkey mode needs a biometric or PIN per capture. | Software and browser keys are weaker than hardware. The design says so. |
| **Replayed capture.** An old signed photo is presented as new ("this is from today's protest"). | Signatures valid. | Time bounds: a "not after" anchor from last year exposes it. A "not before" beacon proves a fresh capture is fresh. The verifier shows the interval in plain words. | A photo without anchors shows only "device clock says ..., not proven". |
| **Manifest swapped onto another file.** | | The manifest signs the content hash. Mismatch fails. | |
| **Stripped metadata.** A platform removes the embedded store. | Nothing travels with the file. | The verifier looks the file up by its hash in the registry, if it was published (section 9.4). | A re-encoded file has a new hash. Similar-image lookup is later (soft binding, section 13). |
| **Lying clock.** The device clock is set to another date. | The claimed time is wrong. | Device time is shown as a claim. The proven interval comes from beacons and anchors. The verifier flags device time outside the interval. | Without a network, there are no beacons and no anchors yet, only the claim. Anchors added later still give "not after". |
| **Lying location.** | Browser geolocation can be overridden. | Shown as "claimed by the device, source: browser". Installation location for sensors is the owner's claim in a credential. | Location witnesses over Bluetooth are a later idea (section 10.3). |
| **Edit chain forgery.** An editor claims a parent it didn't use, or hides edits. | | The edit manifest is signed by the editor. A tile proof shows which pixels are unchanged from the capture. Without a tile proof, the verifier says "edited; the rest of the image is not proven unchanged". | An editor can lie about *what* it did inside the changed tiles. The changed area is visible. |
| **Gateway or registry tampering.** | They could drop, delay, reorder or invent data. | They can't sign as a device. Verifiers check every signature. Hash chains and sequence numbers make drops visible. | Drops and delays are visible but not prevented. |
| **Replayed or reordered sensor frames.** | | Sequence numbers and the hash chain. Duplicates are ignored. Two different readings with the same sequence number are **equivocation**, and the device is flagged. | |
| **Witness collusion.** Witnesses back-date receipts. | | A threshold of witnesses (trail) and an optional Solana anchor, which no witness controls. | If all of a device's witnesses collude and there is no chain anchor, "not after" is as good as they are. |

## 6. Architecture

```
            Owner app (browser)                              Verifier (browser, trusts nobody)
   enroll, credentials, rotate, revoke                     drop file -> report; sensor dashboard
              |  TSP over relay                                      ^   fetch stores/frames (untrusted)
              v                                                      |
  Camera app (phone/browser) --capture store--> Registry  <----------+
   capture key (WebCrypto / passkey)            (capture server: stores by hash,
   key log (trail), witnesses                    frames, demo maker, serves web)
              |                                        ^
              | key events, capture batch roots        |  capture/readings/batch (TSP over relay)
              v                                        |
       Trail witnesses ---- optional Solana anchor     Gateway (Node) <== mesh: LoRa / Bluetooth / simulated ==> Sensor (Node, Pi)
                                                         beacons downlink ==>                    readings, seals
  Editor (browser): open photo + store, blur/crop, sign as editor, export PNG + store
  drand (public HTTP): beacons for "not before"
```

Components and where they live:

| Component | Runs | Location |
|---|---|---|
| `packages/provenance` | everywhere | manifests, COSE, store, tile proofs, sensor frames, verification (section 19) |
| Camera app | phone or laptop browser | `projects/capture/web` route `/camera` |
| Owner app | browser | route `/owner` |
| Editor | browser | route `/edit` |
| Verifier | browser | route `/verify` |
| Sensor dashboard | browser | route `/sensors` |
| Capture server | Node | `projects/capture/src/server`: registry, frame store, demo maker, static web, starts the relay and witnesses for development |
| Sensor | Node, optionally on a Raspberry Pi | `projects/capture/src/sensor` |
| Gateway | Node, attached to a radio or the simulated mesh | `projects/capture/src/gateway` |
| Relay | Node | `packages/relay`, unchanged |
| Witnesses | Node | from `projects/trail` |

One command, `npm run capture`, starts the server, relay, two witnesses, a gateway on the simulated mesh, and two simulated sensors, as Settle's platform does (Settle design §17).

## 7. Identities, keys and credentials

### 7.1 Two keys per device (our call)

A device has two keys with different jobs:

- **Messaging key.** An Ed25519 did:key (trust-core `Identity`), used for TSP with the owner, witnesses and the relay. The browser keeps its seed sealed with a passkey or passphrase, exactly as Settle's `web/src/vault.ts` does.
- **Capture key.** Signs manifests and seals. It is the current key in the device's **key log** (trail). It is never exported.

Why two: TSP and HPKE in the trust core need the raw Ed25519 seed (the X25519 key is derived from it), but the strongest keys a browser or chip offers can't give up their secret: non-extractable WebCrypto keys, passkeys, and secure elements. The inception event records the messaging DID, so the two are linked.

### 7.2 Key classes: what each device can really do

| Class | Where the capture key lives | Algorithm | Who can make it sign | MVP |
|---|---|---|---|---|
| **S, software** | a file on disk (mode 0600) | Ed25519 | anyone with the file | Node sensor |
| **B, browser** | WebCrypto `CryptoKey`, `extractable: false`, kept in IndexedDB | Ed25519 where the browser has it in WebCrypto; ECDSA P-256 otherwise | page script on this origin, in this browser profile; the owner via dev tools | camera app, default |
| **P, passkey** | a platform authenticator (Secure Enclave, TPM, Android keystore) or a security key | ECDSA P-256 (WebAuthn ES256) | someone who passes the biometric or PIN, for each capture | camera app, "evidence mode" |
| **E, secure element** | ATECC608-class chip on a Pi or ESP32 | ECDSA P-256 | firmware on the board | deferred; needs hardware |
| **H, hardware-attested camera** | a key the camera's firmware uses, with a maker attestation | P-256 | only the capture pipeline | out of scope |

Notes that matter:

- **WebCrypto keys can't be signed with synchronously.** The trust core's `Signer.sign` (from `@openvtc/trust-tasks-proof`) is synchronous. Capture needs an async signer (section 19.1).
- **Passkeys don't sign arbitrary data.** A WebAuthn assertion signs `authenticatorData || SHA-256(clientDataJSON)`, and the challenge sits inside `clientDataJSON`. Capture puts the hash of the manifest's signing input in the challenge and stores the assertion as the signature (section 8.4).
- **Synced passkeys are not device-bound.** iCloud Keychain and Google Password Manager copy passkeys to the owner's other devices. The WebAuthn authenticator data has two flags, *backup eligible* (BE) and *backup state* (BS). The verifier shows "this key may exist on the owner's other devices" when BS is set. Only a security key or a non-synced platform key is bound to one device.
- **The Secure Enclave, the ATECC608 and almost all platform passkeys use P-256.** So the formats support both Ed25519 and P-256 from day one.

The device's credentials state its class (`keyClass`), and the verifier shows it in words: "browser key: the owner of this browser could sign anything".

### 7.3 The key log (trail)

Each device has a KERI-style key event log from `projects/trail`. The device identifier is self-certifying, derived from the inception event. Trail chooses its DID method name. This document writes it as `did:trail:…` (a placeholder).

Events Capture uses:

| Event | Signed by | Carries |
|---|---|---|
| **Inception** | the capture key | current key (curve and public key), **digest of the next key**, witness list and threshold, and in its data: messaging DID, key class, device kind (`camera` or `sensor`) |
| **Rotation** | the key whose digest the previous event committed to | the new current key, a new next-key digest, optional witness changes |
| **Interaction** | the current capture key | digests to anchor: a Merkle root of a batch of capture manifest ids, or a sensor seal hash |
| **Decommission** | the next key | rotation to no keys; the log ends |

Witnesses receipt each event and say when they saw it. Their receipts give "not after" for everything an event anchors.

### 7.4 Enrollment and recovery (our call)

The owner holds the device's **recovery key**: the next key committed to at inception. It is derived from the owner's seed and the device identifier with HKDF-SHA-256 (info `capture/recovery/v1|<device nonce>`), as Settle derives payment keys from a party's seed (Settle design §4). So:

- The phone holds only the current capture key. If it's stolen, the thief can't rotate.
- The owner can rotate from any device that has their seed: a new phone gets a new capture key on the same identifier, and its history continues.

Enrollment, over TSP through the relay:

1. The owner app shows a QR code and link: the owner's DID, the relay URL and a one-time enrollment code.
2. The camera app makes its capture key and messaging identity, then sends `capture/device/enroll` to the owner: capture public key, key class, messaging DID, device label, a nonce, the code.
3. The owner app checks the code and replies with the next-key digest (from its derived recovery key) and the witness list.
4. The camera builds and signs the inception, gets witness receipts, and sends `capture/device/incepted` with the log.
5. The owner verifies the log and replies with a `DeviceOwnerCredential` (section 7.5) in `capture/device/credential`.

Sensors enroll the same way with a command-line owner tool (`capture-owner enroll --sensor <url>`), or by the owner writing the next-key digest into the sensor's config file before first boot.

**Rotation** (lost or stolen phone, or reinstall): the owner app signs a rotation with the recovery key. The new current key is the new phone's capture key, or none to decommission. It also publishes a status-list update revoking the old owner credential if needed. **Unanchored captures signed by a retired key** then show a warning (section 14, step 6).

### 7.5 Credentials

W3C VC-shaped JSON, issued and verified with trust-core's `issueCredential` and `verifyCredential` (eddsa-jcs-2022 by a did:key issuer), with revocation through trust-core status lists. `credentialSubject.id` is the device identifier.

**`DeviceModelCredential`**: maker to device.
```
credentialSubject: {
  id: "did:trail:…",
  maker: "Capture Labs (demo)",
  model: "Capture Web Camera 0.1" | "Capture Sensor Node 0.1",
  keyClass: "S" | "B" | "P" | "E",
  keyClassEvidence: "self-reported" | "webauthn-attestation" | "provisioned-at-bench",
  serial?: "…"
}
```
A browser can't prove its key class to a maker. In the MVP the demo maker issues this credential with `keyClassEvidence: "self-reported"`, and the verifier shows that. For a secure element, the maker reads the chip's public key at provisioning, so `provisioned-at-bench` means something.

**`DeviceOwnerCredential`**: owner to device. This is also the delegation: "this device captures for me".
```
credentialSubject: {
  id: "did:trail:…",
  owner: "did:key:z6Mk…",
  ownerName: "Daily Planet photo desk",
  label: "Dana's phone",
  scope: ["photo"],                 // or ["reading"]
  webauthnOrigins?: ["https://capture.example"],   // origins a passkey-signed capture may come from
  validUntil: "2027-11-06T00:00:00Z"
}
```

**`SensorInstallationCredential`**: owner (or station operator) to sensor.
```
credentialSubject: {
  id: "did:trail:…",
  station: "Riverside 4",
  location: { lat: 40.7128, lon: -74.0060, elevationM: 12, accuracyM: 5, method: "owner-surveyed" },
  installedAt: "2026-11-06T09:00:00Z",
  channels: [
    { kind: 1, quantity: "air temperature", unit: "Cel", scale: 0.01, model: "BME280", calibration: { at: "2026-11-01", offset: -0.4, by: "did:key:…" } },
    { kind: 4, quantity: "PM2.5", unit: "ug/m3", scale: 0.1, model: "PMS5003" }
  ]
}
```
A new installation (the sensor moved) is a new credential. The verifier uses the one valid at the reading's time.

**Trust lists.** A verifier holds a small list of issuers it trusts and for what: `{ did, name, trustedFor: ["owner", "maker", "installer"] }`. The MVP ships a demo list and lets the user add an issuer from a verification report ("trust this owner"). This is the same idea as the C2PA trust list, but chosen by the verifier (section 13).

**Later, with `projects/agents`:** the owner credential becomes a mandate from the agents delegation library: "may sign photos for the Daily Planet, on assignment 1123, until Friday". A press agency could then delegate to a freelancer's camera without owning it.

## 8. Signed captures: the capture manifest

### 8.1 Encoding (our call)

- The claim is a CBOR map with text keys, in Core Deterministic Encoding (RFC 8949 §4.2.1), so the same claim always has the same bytes.
- It is signed as a `COSE_Sign1` (RFC 9052), tag 18, with the claim as an attached payload.
- Protected header: `1` (alg), `3` (content type `application/vnd.zk-toip.capture-claim+cbor`), `4` (kid).
- Algorithms: Ed25519 (`-19`) and ESP256 (`-9`), the fully specified identifiers of RFC 9864. Verifiers also accept `-8` (EdDSA) and `-7` (ES256), which C2PA and most COSE libraries use. Passkey signatures use a private-use value, `-65600` (section 8.4).
- `kid` is the UTF-8 of `<signer id>#<key ref>`: for a device, its identifier and the sequence number of the key event that made the key current, for example `did:trail:EKx…#0`; for a did:key signer, the did:key.
- **Manifest id** = SHA-256 of the whole `COSE_Sign1` bytes, written `cm1_<base64url>` in text. Parents are referred to by id, so a chain is a hash chain.

Why CBOR and COSE rather than the trust core's JSON with Data Integrity proofs: content hashes and tile hashes are binary, sensor frames must be tiny, and C2PA claims are COSE-signed CBOR too. The proof library also binds a proof to an `issuer` that is a did:key, and a device's identifier is a trail identifier. Credentials stay JSON with Data Integrity proofs, because they are ordinary trust-core credentials.

### 8.2 What is signed

| Field | Type | Meaning |
|---|---|---|
| `v` | 1 | format version |
| `kind` | `"capture"` | |
| `signer` | text | the device identifier; must equal the id part of `kid` |
| `content` | map | `alg: "sha-256"`, `hash` (32 bytes), `size`, `mime`, `width`, `height`. The hash is over the file as written, with Capture's embedded segments removed (section 9.2) |
| `tiles` | map, optional | tile commitment for redaction proofs (section 11.3): `size` (64), `cols`, `rows`, `decoder`, `root` |
| `deviceTime` | int | device clock in Unix milliseconds. A claim |
| `timeSource` | text | `os-clock`, `ntp`, `gnss` or `none`. A claim |
| `beacons` | array | fresh public values the device saw before capture (section 10.1) |
| `location` | map, optional | `lat`, `lon`, `accuracyM`, `source` (`browser-geolocation`, `gnss`, `owner-declared`), `at`. A claim. Off by default; may be rounded |
| `sensor` | map | `type: "camera"`, `pipeline` (`getUserMedia+canvas` or `ImageCapture.takePhoto`), `trackLabel`, `deviceIdHash` (SHA-256 of the media device id, so it's stable but not raw), `settings` (width, height, facing mode) |
| `app` | map | `name`, `version`, `origin`, and `build`: the hash of the app bundle the server published |
| `nonce` | 16 bytes | random; makes ids unguessable and unique |

Not signed in the manifest: credentials (they can be issued or revoked later), anchors (they arrive later), the tile hash list (bound by `tiles.root`). These travel in the store.

Example, in CBOR diagnostic notation:
```
18([
  << { 1: -19, 3: "application/vnd.zk-toip.capture-claim+cbor", 4: 'did:trail:EKx3…#0' } >>,
  {},
  << {
    "v": 1, "kind": "capture", "signer": "did:trail:EKx3…",
    "content": { "alg": "sha-256", "hash": h'9f2c…', "size": 412337, "mime": "image/jpeg", "width": 1920, "height": 1080 },
    "tiles": { "size": 64, "cols": 30, "rows": 17, "decoder": "jpeg-js/0.4.4/rgba", "root": h'51ab…' },
    "deviceTime": 1762423333123, "timeSource": "os-clock",
    "beacons": [ { "kind": "drand-quicknet", "round": 23838123, "prefix": h'4f1e9a0c77d2b3e1' } ],
    "sensor": { "type": "camera", "pipeline": "getUserMedia+canvas", "trackLabel": "Back Camera",
                "deviceIdHash": h'c0de…', "settings": { "width": 1920, "height": 1080, "facingMode": "environment" } },
    "app": { "name": "capture-camera", "version": "0.1.0", "origin": "https://capture.example", "build": h'77aa…' },
    "nonce": h'0b1c…'
  } >>,
  h'…64-byte signature…'
])
```
Size: about 600 bytes.

### 8.3 Capture log

After each capture, the camera adds the manifest id to a pending batch. At most every 30 seconds, when online, it signs an **interaction event** in its key log that anchors the Merkle root of the batch (SHA-256, RFC 6962-style leaf and node prefixes), and sends it to its witnesses. The store for each capture then gets an anchor: the event, the receipts and the Merkle path (section 9.1). **(our call)**

A Merkle batch, not a hash chain of captures, so a capture reveals nothing about the device's other captures except the batch size.

### 8.4 Passkey signatures (evidence mode)

With alg `-65600`, the `COSE_Sign1` signature field holds a CBOR array `[authenticatorData, clientDataJSON, signature]`:

- The camera calls `navigator.credentials.get` with `challenge = SHA-256(Sig_structure)`, where `Sig_structure` is the COSE `Signature1` structure over the protected header and payload, and `userVerification: "required"`.
- The verifier checks:
  1. `clientDataJSON.type` is `webauthn.get`.
  2. Its `challenge` equals base64url of `SHA-256(Sig_structure)`.
  3. Its `origin` is listed in the owner credential's `webauthnOrigins`.
  4. `rpIdHash` is SHA-256 of that origin's host.
  5. The UP and UV flags are set.
  6. The ES256 signature verifies over `authenticatorData || SHA-256(clientDataJSON)` with the key in the device's log.
- It reports BE and BS (section 7.2).

The passkey's public key is read once at enrollment (from the registration response) and becomes the capture key in the inception event. The passkey can't sign the inception's own "signed by the current key" requirement in a plain form, so the inception signature uses the same WebAuthn wrapping. Trail must accept a pluggable signature verifier (section 19.4).

## 9. Carrying manifests

### 9.1 The store

A store is one CBOR map (media type `application/vnd.zk-toip.capture-store+cbor`):

```
{
  "v": 1,
  "active": h'<manifest id of the asset's own manifest>',
  "manifests": { h'<id>': h'<COSE_Sign1 bytes>', … },          // capture and edits
  "keyLogs": { "did:trail:…": h'<trail log export>' },           // every device in the chain
  "credentials": [ '<VC JSON, UTF-8>', … ],
  "statusLists": [ '<signed status list JSON, UTF-8>', … ],      // snapshots; verifiers may fetch fresher ones
  "anchors": { h'<manifest id>': [ Anchor, … ] },
  "beacons": { "drand-quicknet:23838123": h'<full 48-byte beacon signature>' },
  "tiles": { h'<manifest id>': { "hashes": h'<concatenated 32-byte tile hashes>' } },
  "salts": { h'<edit manifest id>': h'<16-byte salts for the kept tiles, in order>' }
}
```

`Anchor` is one of:
- `{ "kind": "trail", "log": id, "event": seq, "path": [h'…'] }`: the manifest id is in the Merkle batch anchored by that interaction event. The witness receipts are in the key log export.
- `{ "kind": "solana", "cluster": "devnet", "tx": text, "slot": int, "root": h'…', "path": [h'…'] }`: the trail event's digest is in a Merkle root written to Solana (section 10.2).
- `{ "kind": "rfc3161", "token": h'…' }`: later, with the C2PA export.

A typical store with one capture and one edit is 3 to 20 KB. Most of that is the tile hash list (510 tiles × 32 bytes for 1920×1080 at 64-pixel tiles, about 16 KB).

### 9.2 Sidecar and embedded (our call)

- **Sidecar** (always): `photo.jpg` and `photo.jpg.capture`. Works for any file type.
- **Embedded in JPEG**: the store goes in APP15 segments, each starting with the identifier `ZKTOIP-CAPTURE\0`, a 1-byte segment index and a 1-byte count, inserted right after SOI. A JPEG segment holds at most 65,533 bytes of data, so a large store spans several segments. APP15 is used so C2PA readers, which look in APP11 for JUMBF (C2PA §A.3.1), never try to parse it.
- **Embedded in PNG**: a private ancillary chunk `zkCp` before the first IDAT, as C2PA places its `caBX` (C2PA §A.3.2).
- **The content hash** is SHA-256 of the file with all of Capture's own segments or chunks removed. It is therefore the same before and after embedding, and re-embedding a grown store (an edit or a late anchor added) doesn't change it.

The camera gallery keeps each photo with its store and updates the store when anchors arrive. Export offers "photo with credentials inside", "photo and sidecar", and "publish to the registry".

### 9.3 The private bundle

The camera keeps, per capture, a **tile key** (32 random bytes, section 11.3). It is sealed in the gallery under the account key, as Settle seals saved state. It goes to an editor only with the original, as a "private bundle": original file, store, tile key. It is never published.

### 9.4 The registry

The capture server keeps stores that their holders chose to publish, indexed by content hash and manifest id: `POST /api/stores` and `GET /api/stores/by-hash/<hex>`. The verifier asks it when a dropped file has no store. It is a lookup service, not an authority. It also serves current status lists and key logs by identifier.

## 10. Time and location

### 10.1 What a device can honestly say about time

A device clock is a claim. Capture builds a **proven interval** from two kinds of evidence:

**"Not before": beacons signed into the manifest.** The device includes a value nobody could know in advance:

| Beacon | What's signed | What it proves | Verifier needs |
|---|---|---|---|
| **drand quicknet** (default) | round number and the first 8 bytes of the round's randomness | the manifest was made after that round was published. Quicknet publishes a round every 3 seconds, so the bound is tight | the round's 48-byte BLS signature (kept in the store, or fetched from `api.drand.sh`) and the chain's public key; verified with `@noble/curves` BLS12-381 |
| **Solana blockhash** (optional) | slot and blockhash | after that slot was produced | an RPC to look up the slot's blockhash and block time |
| **Witness nonce** (optional) | a nonce a trail witness handed out with its time | after the witness's stated time | trust in that witness |

The camera fetches the latest drand round in the background every 3 seconds while the viewfinder is open. If the network is down, the manifest has no beacon, and the verifier shows no "not before".

The round's time is `genesis + (round − 1) × 3 s`, a derivation from drand's published `genesis_time` and `period`. This should be checked against the `/info` endpoint when built.

**"Not after": anchors added later.**

| Anchor | What it proves | Trust |
|---|---|---|
| **Trail witness receipts** on the interaction event that anchors the capture's batch | the manifest existed when a threshold of witnesses saw the event | as good as the witnesses' clocks and honesty |
| **Solana anchor** of the witness's log head | the manifest existed before the block was produced | as good as Solana's consensus. Its block time is an estimate from validators' reported times (to check when built) |
| **Gateway receipt** (sensors) | the gateway had the frame at its stated time | as good as the gateway |
| **RFC 3161 time-stamp** (later) | a TSA's signed time over the signature | as good as the TSA; also what C2PA uses (C2PA §10.3.2.5) |

The verifier shows: "Captured between 10:02:13 and 10:02:51 UTC on 6 Nov 2026 (after drand round 23838123; before 2 of 2 witnesses received it). The device's clock said 10:02:14." If the device time falls outside the interval by more than 2 minutes, it shows "the device clock was wrong" as a warning, not a failure.

### 10.2 The Solana anchor (optional in the MVP)

The capture server, every 5 minutes, writes one SPL Memo transaction whose memo is `capture/v1|<hex Merkle root>`. The root covers the witness log heads it has seen. It uses Settle's chain module and cluster setup (Settle design §18), on a local cluster or devnet. One transaction anchors any number of devices. The anchor proves "not after" for everything below it, and shows no device identifiers on-chain, only a hash.

### 10.3 Location

- **Photos:** browser geolocation gives a position and an accuracy but not its source (GPS, Wi-Fi or IP). The manifest records `source: "browser-geolocation"`, and the verifier shows "claimed by the device". The owner can turn location off, or round it to about 1 km before capture.
- **Sensors:** location is the owner's claim in the installation credential, with how it was measured.
- **Later: location witnesses.** A fixed station with a known installation credential listens over Bluetooth (the mesh transport) and signs "I saw device X's beacon at time T, signal strength S". That is real evidence of being nearby. It is an idea for mesh and Capture together, not part of the MVP.

## 11. Edit chains and redaction

### 11.1 The edit manifest

Same encoding as a capture manifest (section 8.1). Signed by the editor's did:key (a person), or by a tool's own DID when an automated tool did the work.

| Field | Meaning |
|---|---|
| `v`, `kind: "edit"`, `signer` | as in section 8 |
| `parents` | array of `{ manifest: id, content: hash, relationship }`. `relationship` is `parentOf` (this is a derived version), `componentOf` (it was placed into a composite) or `inputTo` (it was input to a computation such as an AI model), the C2PA ingredient relationships (C2PA §18.15) |
| `actions` | array of `{ action, params?, digitalSourceType?, softwareAgent? }`. Action names are C2PA's where the meaning is the same (`c2pa.cropped`, `c2pa.resized`, `c2pa.adjustedColor`, `c2pa.filtered`, `c2pa.orientation`, `c2pa.converted`, `c2pa.placed`, `c2pa.edited`), plus Capture's own `capture.redactedRegion` |
| `tool` | `{ name, version, did? }` |
| `content` | the output's hash, size, type and dimensions |
| `tiles` | optional new tile commitment for the output, so its own later edits can be proven |
| `tileProof` | optional; section 11.3 |
| `deviceTime`, `beacons`, `nonce` | as in section 8 |

`capture.redactedRegion` params: `regions` (rectangles in output pixels), `method` (`pixelate-16`, `gaussian-12`, `fill-black`) and `reason` (free text, for example "protect a bystander's identity"). C2PA's `c2pa.redacted` action means removing an *assertion* from a manifest (C2PA §6.8, §18.14), not hiding pixels, so Capture doesn't reuse that name.

An **AI tool** records an action with `digitalSourceType` set to an IPTC term, for example `http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia`, and `softwareAgent` naming the model. If the tool runs as a service with its own DID, it signs the edit manifest itself, and the person who asked for the edit can add a second edit manifest (`c2pa.opened` and nothing else) to say they accepted it.

### 11.2 Walking the chain

Each edit manifest names its parents by manifest id and content hash. The verifier starts at the asset's own manifest and follows parents until it reaches capture manifests. Each link must:
- verify (signature, key valid, credentials);
- have the parent manifest in the store, or be fetchable from the registry by id;
- name a `content` hash equal to the parent manifest's `content.hash`.

The original files are not needed. A parent manifest signs the hash of its content, so a chain verifies with only the final file and the store.

### 11.3 Redaction that keeps provenance: tile proofs (our call)

The goal: a newsroom blurs a face and publishes. A reader can check that **everything except the blurred area is exactly what the camera captured**, without the original.

**At capture.** The camera decodes its own JPEG with a fixed decoder (`jpeg-js` 0.4.4, pure JavaScript, so every platform gets the same pixels) and cuts the RGBA pixels into 64×64 tiles (edge tiles smaller). For tile `i` at `(x, y)` with size `(w, h)`:

```
salt_i     = HMAC-SHA-256(tileKey, "capture/tile-salt/v1" || u32(i))[0..16]
tileHash_i = SHA-256("capture/tile/v1" || u32(i) || u16(x) || u16(y) || u16(w) || u16(h) || salt_i || rgba_i)
root       = SHA-256(tileHash_0 || tileHash_1 || … || tileHash_{n-1})
```

The manifest signs `root`. The store carries the list of tile hashes. The salts stop anyone from testing guesses for flat, low-detail tiles (a white wall), because a salt is disclosed only for tiles that are kept. Decoding a 1080p JPEG and hashing takes a fraction of a second in a Web Worker. A 12-megapixel photo takes a second or two, which is acceptable after the shutter.

**At redaction.** The editor has the private bundle (original, store, tile key). It:
1. decodes the original with the same decoder;
2. applies the blur or fill inside the regions;
3. optionally crops, snapping the crop to the 64-pixel grid so whole tiles survive;
4. writes a **PNG** (lossless), so untouched pixels stay exact;
5. signs an edit manifest with `tileProof: { against: <capture manifest id>, offset: [dx, dy] (in tiles), kept: <bitmap over the capture's tiles> }`;
6. puts the salts of the kept tiles in the store's `salts`.

**At verification.** The verifier decodes the PNG with a fixed decoder (`fast-png`), recomputes the salted hash of each kept tile at its offset, and compares it with the capture's tile hash list. That list is bound by the signed `root`. It also checks:
- every tile not kept intersects a declared redaction region, or is outside the crop;
- the kept bitmap and the declared regions agree.

The report says "Unchanged from the capture: 486 of 510 tiles. Redacted: 24 tiles, in 1 region ('protect a bystander's identity'). Cropped: none."

**Limits.**
- If the output is a JPEG, or the editor resized or color-adjusted the whole image, there is no tile proof. The verifier says "edited; not proven unchanged anywhere".
- Tile proofs in the MVP are one level deep: an edit proven against the capture. Deeper chains still verify by signatures and hashes. A later version can chain tile proofs through each edit's own `tiles`.
- A tile partly inside a redaction region counts as changed in full.

## 12. Sensors: reading format and byte budgets

### 12.1 The model

A sensor takes a reading every interval (default 60 s) and appends it to its **reading chain**: each reading carries a truncated hash of the previous one. Every N readings (default 10), or on demand, it sends a **seal**, a signature over the chain head. Readings travel live over the mesh (LoRa or Bluetooth) or over the relay. The sensor also keeps the full chain on disk, so a gateway that missed frames can ask for a backfill over a better link later.

Why not sign every reading: a seal costs one signature for many readings, and saves more than half the airtime (section 12.4). A standalone **signed reading** frame exists for sensors that send rarely.

Why not TSP per reading: a TSP message with did:key VIDs, HPKE and a signature is hundreds of bytes before any payload. Frames are self-authenticating COSE, so they need no envelope on the radio. The gateway forwards them into the IP world inside an ordinary TSP Trust Task. If mesh designs a compact TSP for LoRa, frames can ride inside it unchanged.

### 12.2 Frames

All frames are CBOR arrays with small integer fields, preceded by a 1-byte frame type. `dev` is the first 4 bytes of SHA-256 of the device identifier. The receiver maps it to identifiers it knows and lets the signature settle a collision.

**`0x01` Reading** (unsigned, chained):
```
[ dev: bstr(4), seq: uint, t: uint (Unix seconds, device clock), link: bstr(8), values: [[kind, int], …], beacon?: bstr(3) ]
```
- `link` = first 8 bytes of SHA-256 of the previous reading's CBOR array bytes (the frame without its type byte). The first reading of a device's chain uses 8 zero bytes.
- `values`: `kind` is a channel from the installation credential, and the value is an integer in that channel's scale (for example centi-degrees Celsius).
- `beacon` (optional): the low byte of the latest drand round the sensor heard (section 12.3) and the first 2 bytes of its randomness.

**`0x02` Seal** (`COSE_Sign1`, alg Ed25519 or ESP256, empty unprotected header):
```
payload: [ dev: bstr(4), firstSeq: uint, lastSeq: uint, head: bstr(32), beacon?: [round: uint, prefix: bstr(8)] ]
```
- `head` = full SHA-256 of reading `lastSeq`'s CBOR array bytes.
- `kid` is not sent on the radio. `dev` identifies the device, and the verifier tries the device's current key and, around a rotation, the previous one.

**`0x03` Signed reading** (`COSE_Sign1`): payload `[dev, seq, t, values, beacon?]`. It is not part of the chain.

**`0x04` Beacon** (gateway to sensors, unsigned): `[kind: 1 (drand quicknet), round: uint, prefix: bstr(8)]`. Sensors can't check a BLS signature cheaply, and don't need to: a false beacon simply won't match drand later, and the reading loses its "not before".

**`0x05` Backfill request** (gateway to sensor): `[dev, fromSeq, toSeq]`. The sensor resends those readings at a low rate, or over the relay if it has one.

### 12.3 Time for sensors

- **Not before:** the gateway broadcasts a beacon frame every 60 s **(our call)**. A reading's `beacon` field ties it to a round. The verifier finds the round with that low byte, below the seal's full round and within 256 × 64 rounds of it, whose randomness starts with the 2-byte tag. About one false match in a thousand. Pre-making a batch of readings means guessing a 16-bit tag for each, so a faked batch of 10 readings succeeds with probability 2^-160.
- **Not after:** the gateway's signed receipt in `capture/readings/batch` (gateway's clock), the sensor's next interaction event anchoring the seal hash (witness receipts, when the sensor has IP), and the Solana anchor.
- The dashboard shows each batch's interval. A reading's own `t` is shown as the device's claim.

### 12.4 Byte budgets

Counted with the encodings above, with 32-bit `seq` and `t` (worst case) and three values, each a 16-bit integer.

| Frame | Bytes | How |
|---|---|---|
| Reading, 3 values | **42** | type 1, array 1, dev 5, seq 5, t 5, link 9, values 16 |
| Reading with beacon tag | **46** | +4 |
| Signed reading, 3 values | **108** | type 1, tag 1, array 1, protected header 4, unprotected 1, payload 34, signature 66 |
| Seal with beacon | **141** | type 1, tag+array 2, protected 4, unprotected 1, payload 67 (dev 5, seqs 10, head 34, beacon 15, header 3), signature 66 |
| Seal without beacon | **126** | |
| Beacon | **17** | |

Against common link limits:

| Link | Max payload | Reading (42) | Seal (141) |
|---|---|---|---|
| Raw LoRa, one packet | 255 bytes PHY payload, less the mesh's own header | yes | yes |
| Meshtastic-style packet | 233 bytes of data payload (Meshtastic's `DATA_PAYLOAD_LEN`) | yes | yes |
| LoRaWAN EU868, DR0 to DR2 (SF12 to SF10) | 51 bytes (to check against the regional parameters) | yes | no: send signed readings only over a faster data rate, or split |
| LoRaWAN EU868, DR3 | 115 bytes | yes | no; a seal without beacon and with a 16-byte head fits (109) |
| LoRaWAN US915, DR0 | 11 bytes | no | no |
| Bluetooth LE (ATT MTU 247) | 244 bytes | yes | yes |

**Target (our call):** the mesh link offers at least 160 bytes of payload per frame to Capture. Readings stay under 51 bytes, so they also fit the smallest common LoRaWAN rate.

One reading a minute for an hour: batched, 60 × 42 + 6 × 141 = 3,366 bytes; each signed, 60 × 108 = 6,480 bytes. Batching saves about half. With a seal every 60 readings it's 2,661 bytes.

**Truncated links.** An 8-byte link means forging a substitute for one reading takes about 2^64 hash attempts (a second preimage on 64 bits). That's enough for sensor data, not for money. Seals use the full 32-byte hash. A 12-byte link costs 4 bytes per reading if this proves too weak.

### 12.5 Verifying readings

For each device and each seal:
1. Verify the seal's signature with the device's key at that time (key log).
2. Find reading `lastSeq`; check SHA-256 of its bytes equals `head`.
3. Walk backwards: reading `s − 1` verifies if the first 8 bytes of its hash equal reading `s`'s `link`.

Each reading gets one status:

| Status | Meaning |
|---|---|
| **Verified** | linked to a valid seal |
| **Pending** | received; no seal covers it yet |
| **Unlinked** | a seal covers it, but a missing reading breaks the chain between it and the head. Fixed by backfill |
| **Invalid** | a link or seal doesn't match |
| **Equivocation** | two different readings with the same `dev` and `seq` both chain to valid seals. The device is flagged |

A lost frame only hurts readings *before* it in the same batch. Readings after it still link to the head.

### 12.6 Sensor hardware in the MVP

- **Node process, simulated sensor:** temperature and humidity as a smooth random walk, PM2.5 with spikes. Key class S.
- **Raspberry Pi** (optional, if the user has one): the same process reads a BME280 over I²C with the `i2c-bus` package. Key class S.
- **ATECC608 on the Pi** (deferred, needs the chip): P-256 key generated inside the chip; the sensor signs seals with ESP256. The formats already allow it.
- **ESP32** (deferred): same frames, Ed25519 or the chip's P-256, firmware in C. The byte formats are fixed so firmware can be written from this document.

## 13. Relationship with C2PA

### 13.1 What C2PA is (from the 2.2 specification)

- A **manifest store** holds one or more manifests. The last is the active manifest (§2.3.4 to 2.3.7).
- A manifest is a set of **assertions**, one **claim** (CBOR, `c2pa.claim.v2`, deterministic encoding) and a **claim signature**, a `COSE_Sign1` over the claim (§10.2, §10.3.2.4).
- One **hard binding** ties the manifest to the bytes, for example `c2pa.hash.data` over byte ranges with exclusions (§9.2). **Soft bindings** (fingerprints, watermarks) help find a manifest but never prove binding (§9.3).
- **Ingredients** (`c2pa.ingredient.v3`) link to parent assets with `parentOf`, `componentOf` or `inputTo` (§18.15). **Actions** (`c2pa.actions`) list what was done, with `digitalSourceType` from IPTC terms (§18.14).
- Allowed signature algorithms include ES256 to ES512, PS256 to PS512 and Ed25519 (§13.2.1).
- **The claim signer must be an X.509 certificate** in the COSE protected header. To be "trusted", it must chain to an anchor on a trust list for the `c2pa-kp-claimSigning` extended key use (§14.2, §14.4, §14.5).
- Time comes from an optional RFC 3161 time-stamp, one per manifest (§10.3.2.5, §18.17). Without one, a manifest stops validating when its certificate expires or is revoked.
- Embedding: JPEG APP11 JUMBF segments, PNG `caBX` chunk, BMFF `uuid` box and others (Appendix A); sidecar `.c2pa` files and remote manifests via a `Link` header (§15.5.3).
- The CAWG **identity assertion** (`cawg.identity`, DIF ratified 1.1) lets a named actor sign a list of assertions, with an X.509 signature or a W3C VC from an identity claims aggregator (CAWG §5, §8.1). DIDs are mentioned (§1.3). Which DID methods are allowed was not found in what was read.

### 13.2 The decision: our own format, shaped like C2PA, with a C2PA export later (our call)

**Options considered:**
1. **Emit native C2PA only.** It is the standard, and Content Credentials viewers would show it. But the claim signer must be X.509, so device DIDs, key logs, pre-rotation and owner-held recovery have no place in the signature. A self-made certificate would show as "untrusted" everywhere. C2PA also has nothing for 42-byte sensor readings, tile proofs or beacon time.
2. **Our own format, no C2PA.** It's simplest, but it is an island.
3. **Our own format as the source of truth, designed to map onto C2PA, and a C2PA export that carries it inside.** **Chosen.**

**What this means:**
- The concepts and names match C2PA wherever the meaning is the same: COSE-signed CBOR claims, content hash with exclusions, parents with C2PA's relationships, C2PA action names, IPTC digital source types. A mapping is mechanical (13.3).
- **MVP: the verifier reads C2PA.** Dropped files are also read with `@contentauth/c2pa-web` (the Content Authenticity SDK compiled to WebAssembly). The report shows "Content Credentials (C2PA): present, signed by <certificate subject>, trusted / not on your trust list", next to Capture's own result. Users then see both systems side by side.
- **Phase 2: C2PA export.** The editor and camera write a C2PA manifest with the same SDK's `Builder`. Its `Signer` interface takes an async signing callback, which fits non-extractable keys, and it can attach CAWG identity assertions through a `CredentialHolder` callback. The export holds:
  - `c2pa.actions` mapped from ours, `c2pa.hash.data` from the SDK, and `c2pa.ingredient.v3` for parents;
  - a custom assertion `example.zk-toip.capture.store` holding the whole Capture store, so a Capture verifier gets everything back from a C2PA file;
  - a claim signature by the **device key**, under an X.509 certificate that the **owner issues** from their own key, acting as a small CA (Ed25519 certificates are allowed);
  - an RFC 3161 time-stamp, if a time-stamp authority is configured.

  C2PA validators will report it as well-formed and validly signed, with an untrusted signer, unless the verifier adds the owner's CA certificate to their own trust anchors. That's the honest result. The SDK's signing API is new (its own docs say "docs coming soon"), so phase 2 starts with a one-day spike.
- **Later:** propose a CAWG identity assertion type for DIDs with key event logs, if the CAWG work on DID methods goes that way.

### 13.3 Mapping

| Capture | C2PA |
|---|---|
| capture manifest | a standard manifest with `c2pa.actions: [c2pa.created]`, `digitalSourceType` IPTC `digitalCapture` |
| `content.hash` (file without Capture's segments) | `c2pa.hash.data` with exclusion ranges (SDK computes it) |
| edit `parents[]` | `c2pa.ingredient.v3` with the same relationship; `c2pa.opened` is added for `parentOf` |
| `actions[]` | `c2pa.actions` with the same names; `capture.redactedRegion` becomes `c2pa.edited` with a region of interest (§18.2) and a description |
| signer: device identifier and key log | X.509 claim signer: device key, certificate issued by the owner; key log in the custom assertion |
| owner and maker credentials | in the custom assertion; later a CAWG identity assertion |
| beacons, trail and Solana anchors | in the custom assertion; RFC 3161 → `c2pa.time-stamp` |
| `location` | `c2pa.metadata` with EXIF GPS terms |
| tile commitment and proofs | custom assertion only |
| sensor frames | no equivalent |
| registry lookup by hash | external manifest repository (§11.4) |

## 14. Verification algorithm

Input: a file and, optionally, a sidecar store. Output: a report with one verdict, a list of findings (each `ok`, `warn`, `fail` or `info`, with a plain sentence), and the data for the UI.

1. **Find the store.**
   1. Take the sidecar if given.
   2. Otherwise extract the embedded store (APP15 in JPEG, `zkCp` in PNG).
   3. Otherwise look up the file's content hash in the registry.
   4. If none is found: check for C2PA (step 11); if there is none either, the verdict is **No provenance found**.
2. **Bind the file.** Compute the content hash (section 9.2). Find the manifest whose `content.hash` matches. It must be `store.active`; if not, `fail: "this file doesn't match its credentials"`.
3. **Decode each manifest** reachable from the active one by `parents`: COSE structure, allowed alg, `kid` present, claim decodes, `kind` known, `signer` equals the `kid` id. Limit the depth to 32 and detect cycles.
4. **Resolve the signer's key.**
   - did:key: the key in the DID.
   - Device: take the key log from the store (or the registry). Trail verifies it: event signatures, the next-key digests, witness receipts against the witness threshold. Find the key event named in `kid`; the key must be that event's current key.
5. **Check the signature** for the alg (Ed25519, ESP256, or the WebAuthn wrapping of section 8.4).
6. **Is the key still good for this manifest?**
   - If the key is still current in the log: `ok`.
   - If a later rotation retired it: look for a trail anchor whose interaction event comes before that rotation. If found: `ok: "signed before the key was retired"`. If not: `warn: "signed with a key that was later retired; no proof it was signed before"`.
   - If the log was decommissioned before the anchor, or the anchor comes after the rotation: `fail`.
7. **Time.**
   - Verify each beacon: for drand, check the BLS signature of the round, and that the signed prefix matches its randomness. Each good beacon gives a lower bound.
   - Verify each anchor: the Merkle path to the event's digest, the event's witness receipts, the Solana memo transaction and its block time. Each gives an upper bound.
   - Interval = [latest lower bound, earliest upper bound]. If it's empty: `fail: "time evidence contradicts itself"`.
   - Compare `deviceTime` with the interval.
8. **Credentials.**
   - For each VC whose subject is the signer: verify it (trust-core). Check its status list (fresh from the registry if online, else the store's snapshot, and say which) and its validity period against the time interval.
   - Look up the issuer in the trust list.
   - Collect the owner, maker, key class and installation.
   - A revoked owner credential is `fail` if it was revoked before the capture's upper bound. Otherwise it is a `warn` with the revocation date. Status lists carry no revocation date, so in the MVP any revocation is a `warn` and is shown prominently **(our call; open question)**.
9. **Chain links.** For each edit, each parent's `content` hash must equal the parent manifest's `content.hash`. A parent missing from the store and the registry is `warn: "chain incomplete"`, and the walk stops there.
10. **Tile proofs** (section 11.3) for an edit with `tileProof`, when the file is a PNG.
11. **C2PA.** Read any C2PA manifest with the SDK and add its validation state as `info`. It never changes Capture's verdict.
12. **Verdict**, the first that applies:

| Verdict | When |
|---|---|
| **Broken** | any `fail` |
| **Verified capture** | the chain reaches a capture manifest; every link is `ok`; the device has an owner credential from a trusted issuer |
| **Signed, issuer not trusted** | everything verifies, but no credential from an issuer on the trust list |
| **Verified, with warnings** | as "verified capture", with `warn` findings (retired key, missing anchor, chain incomplete, clock wrong) |
| **No provenance found** | nothing to check |

Verification is a pure function of the file, the store, the trust list, the clock and an optional fetcher, so it is easy to test. All network lookups go through one `Fetcher` that the verifier can turn off ("offline verification").

## 15. UX

### 15.1 Camera app (`/camera`, an installable web app)

- **First run:** "Make this a Capture camera". The owner either scans the owner app's QR code (section 7.4), or uses "I'm the owner", which makes both identities in this browser for a quick start. It then chooses the key mode: **Standard** (browser key, no prompts) or **Evidence** (a passkey prompt for each photo).
- **Viewfinder:**
  - a shutter;
  - a status strip: "Signing as *Dana's phone* · Daily Planet", "Time beacon 2 s old" (or "Offline: time will be the phone's clock only"), "Location off";
  - toggles for location (off, rounded, precise) and Evidence mode.
- **After the shutter**, in about 300 ms: the thumbnail gets a badge, "Signed". Then "Anchored" when the witnesses answer.
- **Gallery:** each photo shows signed, anchored and published states. Actions: Download (credentials inside), Download with sidecar, Publish to registry, Open in editor, Verify.
- **Settings:** device identity, key class in plain words ("This browser holds the key. Anyone who controls this browser can sign as this camera."), witnesses, the owner, "Ask owner to rotate".

### 15.2 Owner app (`/owner`)

- Accounts are sealed with a passkey, as in Settle.
- **Devices:** each enrolled camera or sensor with its key class, last capture and last seal.
- **Enroll a device:** shows a QR code and link.
- **Per device:**
  - Rotate the key (recovery key);
  - Revoke the owner credential;
  - Decommission;
  - for a sensor, issue an installation credential (a map pin, channels and calibration).
- Shows the device's key log as a timeline.

### 15.3 Editor (`/edit`)

1. Open a private bundle (from the camera gallery or as a file).
2. Tools: **Redact** (draw rectangles; choose pixelate, blur or fill; give a reason), **Crop** (snaps to the 64-pixel grid; a toggle turns snapping off, and turning it off warns that tile proofs will be lost), **Rotate 90°**.
3. The live preview shows the tile grid faintly, and the tiles that will count as changed.
4. Sign as the editor's identity (passkey-sealed did:key).
5. Export a PNG with its store, or publish it.

### 15.4 Verifier (`/verify`)

- **A drop zone** ("Drop a photo, or a photo and its .capture file"), and a "Verify offline" switch.
- **Verdict banner**, in words, for example: "**Verified capture**, with one edit. Taken by *Dana's phone* (Daily Planet photo desk) between 10:02:13 and 10:02:51 UTC, 6 Nov 2026. Redacted in one area by *M. Chen*."
- **Cards:**
  - **Device**: label, model, maker, key class in words, owner, credential issuers and whether you trust them.
  - **Time**: the interval and the evidence for each end.
  - **Location**: claimed or not given.
  - **Edits**: a timeline from capture to this file. Each step shows its signer, tool and actions. For a redaction, an overlay shows unchanged tiles (clear), redacted tiles (hatched) and cropped-away area. A file that went through an AI tool shows "AI-generated content was added (model …)".
  - **Breaks**: each in red, with what it means. Example: "The edit by *X* names a parent photo whose fingerprint doesn't match. This file may not come from the photo it claims."
  - **Content Credentials (C2PA)**: if present.
  - **Raw**: decoded manifests, key logs and credentials as JSON.
- **"Trust this owner"** adds the issuer to the local trust list and re-verifies.

### 15.5 Sensor dashboard (`/sensors`)

- **A station list** with installation location on a map and each sensor's latest seal age.
- **Per station:** a chart per channel. Each point is styled by status: verified (solid), pending (hollow), unlinked (grey), invalid or equivocation (red cross). Gaps in `seq` are marked on the time axis.
- **Batch rows:** seq range, seal status, proven interval, which link carried it (LoRa, Bluetooth, relay), and RSSI and SNR from the mesh.
- **"Request backfill"** for unlinked ranges.
- The dashboard fetches frames from the capture server, but **verifies every frame in the browser**. A small line says so: "Checked in your browser. The server could hide readings but can't change them."

## 16. MVP scope

### 16.1 Built and demoed

1. **`packages/provenance`**: the manifest format, COSE signing and verification (Ed25519, ESP256, WebAuthn-wrapped), store encode and decode, JPEG and PNG embedding, content hashing, tile commitments and proofs, sensor frames, reading-chain verification, and the verifier with its report. Section 19.
2. **Camera app**, Standard and Evidence modes. It runs on a laptop webcam at `http://localhost`. On a phone, it needs HTTPS on a real hostname, because cameras and passkeys need a secure context and passkeys need a domain (open question 1).
3. **Owner app:** enroll, credentials, rotate, revoke, decommission.
4. **Editor:** redact and grid-snapped crop, with tile proofs; PNG output.
5. **Verifier:** everything in section 14, including reading C2PA through `@contentauth/c2pa-web`.
6. **Capture server:** registry, frame store, demo maker, static web, and in development the relay and two trail witnesses.
7. **Sensor (Node):** simulated channels, reading chain, seals, beacons, backfill. It runs over the simulated mesh and over the relay. On a Raspberry Pi with a BME280, if the user has one.
8. **Gateway (Node):** receives frames from the mesh transport, broadcasts beacons, forwards `capture/readings/batch` to the server with a signed receipt. On the simulated mesh always; on the user's LoRa radio once mesh supports it.
9. **Sensor dashboard.**
10. **drand beacons** (camera, editor, gateway) and **trail witness anchors.**

### 16.2 Stretch, in the MVP if time allows

- The Solana memo anchor through Settle's chain module, on the local cluster.
- An "AI tool" service: a Node process with its own DID that applies a fixed filter and signs an edit manifest with an IPTC `digitalSourceType`, to show AI steps in a chain.
- The real LoRa radio between the sensor and the gateway.

### 16.3 Deferred

- C2PA export (phase 2, section 13.2), and RFC 3161 time-stamps.
- ATECC608 and ESP32 firmware.
- Native apps with platform key attestation (class H-like assurance on phones).
- Video, audio, bursts and live photos.
- Similar-image lookup for re-encoded files (perceptual hash).
- Location witnesses over Bluetooth.
- Multi-level tile proofs.
- Delegation mandates from `projects/agents` in place of the owner credential.
- **Anonymous capture** with `projects/tipline` and `projects/agora`: prove "this photo was signed by *some* camera certified by a press agency" without saying which. That needs a zero-knowledge proof to replace the device signature: knowledge of a key in a Merkle set of certified keys, plus a signature over the content hash, plus a nullifier if one capture per key matters. It protects photographers in dangerous places. Worth doing after the anonymous-membership library exists.

## 17. Demo script

Two browser windows on the laptop (Owner and Verifier), a phone or a second browser profile as the camera, and a terminal. About 8 minutes.

1. `npm run capture`. The terminal shows the server, the relay, two witnesses, a gateway, and two simulated sensors ("Riverside 4", "Rooftop 2") sending frames over the simulated mesh. *What it shows: one command, a whole network.*
2. **Owner:** make an account "Daily Planet photo desk" (passkey). Devices → Enroll a camera; a QR code appears.
3. **Camera:** open `/camera`, scan or paste the link, choose Standard mode. The owner window shows "Dana's phone enrolled", with its key log: inception and two witness receipts.
4. **Camera:** take a photo of a street scene with a person in it. "Signed" appears, then "Anchored" a few seconds later.
5. **Verifier:** drop the downloaded photo. The result is "**Signed, issuer not trusted**": everything checks, but this verifier doesn't know the Daily Planet. Click "Trust this owner". The result becomes **Verified capture**, with the device card, the time interval ("after drand round …, before 2 of 2 witnesses") and location "not given". *Trust is the verifier's choice.*
6. **Tamper:** change one byte of the photo in a hex tool, or re-save it in an image editor, and drop it again. The result is "This file doesn't match its credentials". Then strip the metadata (re-save without the APP15 segments, using a small script in `tests/tools`). The verifier finds the original store in the registry by hash, if the photo was published. *Stripped metadata isn't the end.*
7. **Editor:** open the photo's private bundle, redact the person's face with the reason "bystander", crop to the grid, sign as "M. Chen", and export a PNG.
8. **Verifier:** drop the PNG. The result is **Verified capture with one edit**. The overlay shows 486 tiles unchanged from the camera and 24 redacted, and the original was never sent to the verifier. *Redaction keeps provenance.*
9. **Stolen phone:** in the owner app, Rotate → "Phone lost". Take a new photo on the old camera (it still has the old key) and verify it: **Broken**, "signed after this device's key was retired". Re-verify the photo from step 4: still verified, "signed before the key was retired" (it was anchored). *Key history matters.*
10. **Lying clock** (scripted): the demo sensor "Rooftop 2" starts with its clock a day behind. The dashboard shows its readings with the device time crossed out and the proven interval from beacons and the gateway's receipt.
11. **Dashboard:** "Riverside 4" shows solid verified points. Turn up simulated loss to 30% on the mesh. Hollow (pending) and grey (unlinked) points appear. Click "Request backfill", and they turn solid. The gateway is set to "evil" mode, so it changes one reading's value: that point turns into a red cross, "Invalid". *The gateway can't forge.*
12. **Optional hardware:** the same sensor code on the Raspberry Pi with a BME280, over the LoRa radio to the gateway. The frame size shown in the gateway log is 42 bytes per reading and 141 per seal.

The demo also runs narrated and unattended (`npm run demo --workspace @zk-toip/capture`), as Settle's does, with a fake camera (below).

## 18. Test plan

**Unit tests (`packages/provenance`, vitest)**
- **Deterministic CBOR:** the same claim encodes to the same bytes; map keys in canonical order; a non-canonical encoding is refused when re-encoding is checked.
- **COSE_Sign1:**
  - round trips for Ed25519 and ESP256;
  - a fixed test vector from the COSE working group's examples verifies;
  - alg confusion is refused (an Ed25519 key with an ESP256 header);
  - a wrong `kid`, or a `signer` different from the `kid`, is refused.
- **WebAuthn wrapping:**
  - a virtual authenticator (Playwright, as in Settle's e2e) produces assertions that verify;
  - each check fails on its own: wrong challenge, wrong origin, UV missing, wrong rpIdHash;
  - BE and BS are reported.
- **Content hash:**
  - embedding and extracting a store leaves the hash unchanged, for JPEG and PNG;
  - multi-segment stores larger than 64 KB work;
  - a file with a foreign APP15 segment is left alone.
- **Tile proofs:**
  - commit and verify on fixtures;
  - one pixel changed in a "kept" tile fails;
  - a redacted tile outside every declared region fails;
  - a wrong salt fails;
  - crop offsets work;
  - a JPEG output gives "no tile proof" and is not a failure.
- **Sensor frames:**
  - encoded sizes equal the budget table exactly (42, 46, 108, 126, 141, 17), so a change that grows a frame fails the build;
  - chain verification with loss at every position;
  - duplicates are ignored;
  - equivocation is detected;
  - a `dev` collision is settled by the signature.
- **Time:**
  - drand beacon verification against recorded rounds (fixtures, offline);
  - interval logic, including an empty interval;
  - device time outside the interval gives a warning.
- **Verifier:** one test per row of the threat table (section 5) that has a mechanism:
  - a manifest from another file;
  - a parent hash mismatch;
  - a retired key, with and without an anchor;
  - a revoked credential;
  - an untrusted issuer;
  - a cycle in parents;
  - a depth limit;
  - a missing parent;
  - a forged gateway reading.

**Integration tests (Node)**
- The whole network in one process (server, relay, witnesses, gateway, sensors) on the simulated mesh with loss, duplication and reordering. After a run, every reading is verified or backfilled.
- Enrollment, rotation and decommission over TSP between the owner and device agents, with the witnesses from trail.
- Restarting the sensor keeps its chain (seq continues; no fork).

**End-to-end tests (Playwright, Chromium)**
- **Fake camera:** Chromium's `--use-fake-device-for-media-stream` and `--use-file-for-fake-video-capture` feed a fixed video. The flow is camera → enroll → capture → verify → edit → verify. Passkeys come from the virtual authenticator with PRF, as in Settle.
- The verifier with the network blocked (offline verification) gives the same verdict for a complete store.
- The C2PA reader: a sample C2PA-signed JPEG fixture shows the C2PA card.

**Manual**
- A real phone (iPhone Safari and Android Chrome): Standard and Evidence modes, and that a synced passkey shows the "may exist on other devices" note.
- The Pi with a BME280, and the LoRa radio, when available.

## 19. Shared library needs

### 19.1 `packages/cose`: small, shared with mesh (proposed)

Deterministic CBOR and `COSE_Sign1` with async signers. Mesh will want compact signatures too, so this sits on its own.

```ts
export type CoseAlg = -19 | -9 | -8 | -7 | -65600;           // Ed25519, ESP256, EdDSA, ES256, WebAuthn-ES256

/** A key that may not give up its secret: WebCrypto, WebAuthn, a secure element, or a seed. */
export interface AsyncSigner {
  alg: CoseAlg;
  kid: Uint8Array;
  publicKey: { curve: "ed25519" | "p256"; bytes: Uint8Array };
  sign(toBeSigned: Uint8Array): Promise<Uint8Array>;         // for -65600: returns CBOR [authData, clientDataJSON, sig]
}

export function seedSigner(seed: Uint8Array, kid: Uint8Array): AsyncSigner;                       // Ed25519 via @noble/curves
export function webCryptoSigner(key: CryptoKeyPair, kid: Uint8Array): Promise<AsyncSigner>;      // Ed25519 or ECDSA P-256
export function webAuthnSigner(opts: { credentialId: Uint8Array; rpId: string; publicKey: Uint8Array; kid: Uint8Array }): AsyncSigner;

export function encodeCbor(value: unknown): Uint8Array;     // RFC 8949 §4.2.1 deterministic
export function decodeCbor<T = unknown>(bytes: Uint8Array): T;

export function signCose1(payload: Uint8Array, signer: AsyncSigner, opts?: { contentType?: string; omitKid?: boolean }): Promise<Uint8Array>;

export interface CoseVerified { payload: Uint8Array; alg: CoseAlg; kid?: Uint8Array; protected: Map<number, unknown>; webauthn?: { origin: string; flags: { up: boolean; uv: boolean; be: boolean; bs: boolean } } }
export type CoseFailure = "malformed" | "algNotAllowed" | "keyMismatch" | "signatureInvalid" | "webauthnChallenge" | "webauthnOrigin" | "webauthnFlags";
export function verifyCose1(
  bytes: Uint8Array,
  key: (kid: Uint8Array | undefined, alg: CoseAlg) => Promise<{ curve: "ed25519" | "p256"; bytes: Uint8Array }[]>,
  opts?: { allowedAlgs?: CoseAlg[]; webauthnOrigins?: string[] },
): Promise<{ ok: true; value: CoseVerified } | { ok: false; failure: CoseFailure }>;
```

### 19.2 `packages/provenance`: manifests, stores, verification (proposed)

```ts
// claims
export interface ContentRef { alg: "sha-256"; hash: Uint8Array; size: number; mime: string; width?: number; height?: number }
export interface Beacon { kind: "drand-quicknet" | "solana-blockhash" | "witness-nonce"; round?: number; slot?: number; prefix: Uint8Array }
export interface CaptureClaim { v: 1; kind: "capture"; signer: string; content: ContentRef; tiles?: TileCommit; deviceTime: number;
  timeSource: "os-clock" | "ntp" | "gnss" | "none"; beacons: Beacon[]; location?: LocationClaim; sensor: CameraInfo; app: AppInfo; nonce: Uint8Array }
export interface EditClaim { v: 1; kind: "edit"; signer: string; parents: ParentRef[]; actions: Action[]; tool: ToolInfo; content: ContentRef;
  tiles?: TileCommit; tileProof?: TileProofRef; deviceTime: number; beacons: Beacon[]; nonce: Uint8Array }
export interface ParentRef { manifest: Uint8Array; content: Uint8Array; relationship: "parentOf" | "componentOf" | "inputTo" }
export interface Action { action: string; params?: Record<string, unknown>; digitalSourceType?: string; softwareAgent?: string }

export function signManifest(claim: CaptureClaim | EditClaim, signer: AsyncSigner): Promise<{ id: Uint8Array; cose: Uint8Array }>;
export function manifestId(cose: Uint8Array): Uint8Array;
export const idText: (id: Uint8Array) => string;            // "cm1_<b64u>"

// binding and stores
export type Mime = "image/jpeg" | "image/png" | string;
export function contentHash(file: Uint8Array, mime: Mime): Uint8Array;          // excludes Capture's segments
export function embedStore(file: Uint8Array, mime: Mime, store: Store): Uint8Array;
export function extractStore(file: Uint8Array, mime: Mime): Store | null;
export interface Store { v: 1; active: Uint8Array; manifests: Map<string, Uint8Array>; keyLogs: Map<string, Uint8Array>; credentials: Credential[];
  statusLists: StatusListDoc[]; anchors: Map<string, Anchor[]>; beacons: Map<string, Uint8Array>; tiles: Map<string, Uint8Array>; salts: Map<string, Uint8Array> }
export function encodeStore(s: Store): Uint8Array;
export function decodeStore(b: Uint8Array): Store;
export function mergeStores(a: Store, b: Store): Store;     // late anchors, edits

// tiles
export interface Rgba { width: number; height: number; data: Uint8Array }
export function commitTiles(img: Rgba, tileKey: Uint8Array, size?: 64): { commit: TileCommit; hashes: Uint8Array };
export function proveTiles(original: Rgba, edited: Rgba, tileKey: Uint8Array, regions: Rect[], cropOffsetTiles: [number, number]):
  { ref: Omit<TileProofRef, "against">; salts: Uint8Array };
export function checkTiles(edited: Rgba, captureHashes: Uint8Array, commit: TileCommit, ref: TileProofRef, salts: Uint8Array, regions: Rect[]):
  { kept: number; changed: number; failures: TileFailure[] };
export function decodeJpegReference(b: Uint8Array): Rgba;   // jpeg-js, pinned
export function decodePngReference(b: Uint8Array): Rgba;    // fast-png, pinned

// sensor frames
export interface Reading { dev: Uint8Array; seq: number; t: number; link: Uint8Array; values: [number, number][]; beacon?: Uint8Array }
export interface Seal { dev: Uint8Array; firstSeq: number; lastSeq: number; head: Uint8Array; beacon?: { round: number; prefix: Uint8Array } }
export type Frame = { type: 1; reading: Reading; bytes: Uint8Array } | { type: 2; seal: Seal; cose: Uint8Array } | { type: 3; cose: Uint8Array }
  | { type: 4; round: number; prefix: Uint8Array } | { type: 5; dev: Uint8Array; fromSeq: number; toSeq: number };
export class ReadingChain {                                 // device side; persisted by the caller
  constructor(state: { dev: Uint8Array; seq: number; lastHash: Uint8Array }, signer: AsyncSigner);
  next(t: number, values: [number, number][], beacon?: Uint8Array): Uint8Array;  // a 0x01 frame
  seal(beacon?: Seal["beacon"]): Promise<Uint8Array>;        // a 0x02 frame
  signedReading(t: number, values: [number, number][]): Promise<Uint8Array>;     // a 0x03 frame
}
export function encodeFrame(f: Frame): Uint8Array;
export function decodeFrame(b: Uint8Array): Frame;
export type ReadingStatus = "verified" | "pending" | "unlinked" | "invalid" | "equivocation";
export function verifyReadings(frames: Uint8Array[], ctx: VerifyContext): Promise<Map<string /*device*/, { seq: number; status: ReadingStatus; reading: Reading; interval?: [number, number] }[]>>;

// verification
export interface TrustEntry { did: string; name: string; trustedFor: ("owner" | "maker" | "installer")[] }
export interface Fetcher { store(hash: Uint8Array): Promise<Uint8Array | null>; keyLog(id: string): Promise<Uint8Array | null>;
  statusList(url: string): Promise<StatusListDoc | null>; drandRound(round: number): Promise<Uint8Array | null>; solanaTx(sig: string): Promise<{ slot: number; blockTime: number; memo: string } | null> }
export interface VerifyContext { clock: Clock; trust: TrustEntry[]; keyLogs: KeyLogVerifier /* from trail, 19.4 */; fetch?: Fetcher; drand: { chainHash: string; publicKey: Uint8Array; genesis: number; period: number } }
export type Finding = { level: "ok" | "warn" | "fail" | "info"; code: string; text: string; manifest?: string };
export interface Report {
  verdict: "verified" | "verifiedWithWarnings" | "untrustedIssuer" | "broken" | "none";
  findings: Finding[];
  chain: { id: string; kind: "capture" | "edit"; signer: SignerSummary; interval?: [number, number]; deviceTime: number; actions?: Action[]; tiles?: { kept: number; changed: number } }[];
  c2pa?: { present: boolean; signer?: string; trusted?: boolean; state?: string };
}
export function verifyAsset(file: Uint8Array, mime: Mime, sidecar: Uint8Array | null, ctx: VerifyContext): Promise<Report>;
```

### 19.3 From `packages/trust-core`

- **No breaking change.** Credentials, status lists, the relay transport, `Endpoint` and `ourSpec` are used as they are. The Trust Tasks are `ourSpec("capture/device/enroll")`, `capture/device/incepted`, `capture/device/credential`, `capture/device/rotate-request`, `capture/readings/batch` and `capture/readings/backfill`.
- Wanted: Settle's `vault.ts` moved into a shared browser package (for example `packages/vault`), so the camera, owner and editor apps seal keys the same way. Capture adds one thing to it: storing a non-extractable `CryptoKey` in IndexedDB next to the sealed seed.
- An `AsyncSigner` in the trust core is not needed. Capture signs with COSE, not with Data Integrity proofs.

### 19.4 From `projects/trail` (the event-log library)

Capture is a consumer. What it needs, in order of importance:

1. **Pluggable keys and signatures.**
   - Events can be signed by an `AsyncSigner` (19.1).
   - Keys are Ed25519 or P-256.
   - The verifier accepts a signature-verifier hook, so a WebAuthn-wrapped signature (section 8.4) can sign events.
2. **Inception** with:
   - current key(s);
   - next-key digest(s);
   - witnesses and a threshold;
   - a small data field (messaging DID, key class, device kind).
3. **Rotation** signed by the pre-committed next key, including rotation to no keys (decommission).
4. **Interaction events** that anchor arbitrary 32-byte digests (capture batch roots, seal hashes).
5. **Witness receipts** that include the witness's time and verify offline. Capture needs:
   - their encoded size (a store carries them);
   - the witness service as a Node process Capture can start in development;
   - how a device sends an event to it (Capture expects TSP over the relay).
6. **Key state queries:**
   ```ts
   keyAt(log, eventSeq): { curve; bytes }[]                       // keys made current by that event
   isCurrentAt(log, keyEventSeq, atEventSeq): boolean
   retiredAt(log, keyEventSeq): number | null                     // seq of the rotation that retired it
   anchoredIn(log, digest): { eventSeq: number; receipts: Receipt[] } | null
   ```
7. **A compact export** of a log (CBOR, ideally under 2 KB for a device with a few rotations and a few hundred interaction events). It must be verifiable with no network, so a store can carry it. Merkle-batching interactions keeps the log short.
8. **The identifier format**, and resolving it from the log alone. Capture uses whatever trail chooses, as a DID string.
9. **Nice to have: delegated inception.** The owner's own log approves the device's inception, so ownership is in the key logs and not only in a credential.
10. **A head digest per log** that a third party (Capture's server) can batch into a Solana anchor.

Capture does **not** use trail for the sensor reading chain itself. A 42-byte reading can't carry a general log event. Only the seals' hashes are anchored in the sensor's trail log, when the sensor has IP.

### 19.5 From `projects/mesh` (TSP and Trust Tasks over LoRa and Bluetooth)

1. **An opaque-frame service** next to TSP: send and receive raw payloads of up to N bytes on a "port" or channel id (`capture/v1`), with no TSP envelope, because frames sign themselves:
   ```ts
   interface FrameLink {
     maxPayload: number;                                       // Capture asks for ≥ 160
     send(port: string, payload: Uint8Array, opts?: { to?: string; broadcast?: boolean }): Promise<"sent" | "dropped" | "dutyCycle">;
     onFrame(port: string, cb: (payload: Uint8Array, meta: { from?: string; rssi?: number; snr?: number; link: "lora" | "ble" | "sim"; at: number }) => void): () => void;
     airtimeMs?(bytes: number): number;
   }
   ```
2. **Broadcast downlink** from the gateway for beacon frames (17 bytes, every 60 s).
3. **A simulated link** for tests and the demo, with loss, duplication, reordering, latency and a duty-cycle budget, implementing the same interface.
4. **The real numbers** for the user's radio: max payload, the mesh's own header size, the duty-cycle rules for the region, and the airtime at the chosen spreading factor, so Capture can pick the seal interval.
5. **Coordination:**
   - frame types `0x01`–`0x05` on the `capture/v1` port belong to Capture;
   - if mesh defines a compact TSP for LoRa, it should allow a Capture frame as the payload unchanged;
   - Bluetooth location witnesses (section 10.3) are a joint idea for later.

### 19.6 From `projects/agents`, `projects/tipline`, `projects/agora` (later)

- **agents:** a mandate format to replace or extend `DeviceOwnerCredential`: scope ("photos for assignment 1123"), time window, and a chain of delegation from an organization to a person to a device.
- **tipline and agora:** an anonymous-membership proof over a set of certified device keys (section 16.3, "Anonymous capture").

### 19.7 Third-party packages Capture plans to use

| Package | Use |
|---|---|
| `@noble/curves`, `@noble/hashes` (already in the trust core) | Ed25519, P-256, BLS12-381 for drand, SHA-256, HMAC, HKDF |
| `cborg` | deterministic CBOR encode and decode |
| `jpeg-js` | the reference JPEG decoder for tile commitments |
| `fast-png` | PNG encode and decode with exact pixels |
| `@contentauth/c2pa-web` | reading C2PA in the verifier; later, the C2PA export |
| `@solana/kit`, `@solana-program/memo` | the optional Solana anchor, through Settle's chain module |
| `i2c-bus` | BME280 on a Raspberry Pi (optional) |
| `react`, `vite`, `vitest`, `playwright`, `tsx` (already in the repository) | apps and tests |

Capture reads EXIF only to drop it. The camera writes JPEGs from a canvas, which have no EXIF. Image processing that needs a native image library is avoided, so pixels are the same on every platform.

## 20. Open questions

**For the user (hardware)**
1. **Phone and HTTPS.** Which phone (iPhone or Android)? A phone camera and passkeys need HTTPS on a real hostname. Options: a Tailscale `*.ts.net` name with its certificate, a Cloudflare tunnel, or a small hosted copy. Which would you use?
2. **The LoRa radio.** Which board and chip (for example SX1262 or SX1276; Heltec, LilyGO or RAK), and which firmware (Meshtastic, or raw LoRa we program)? Which region (US915 or EU868)? Is there one radio, or two (sensor and gateway)? With only one, the MVP sensor talks to the gateway over the simulated link or Bluetooth.
3. **A Raspberry Pi?** Which model? Any sensors (BME280 or BMP280, an SHT31, a PMS5003 or SDS011 for particulates)?
4. **Secure elements.** An ATECC608 breakout, a YubiKey, or an ESP32 board? Any of them turns a deferred item into a demo.
5. **A GPS module** for the sensor? It would let `timeSource: "gnss"` and real location be shown, still as claims.

**Design**
6. **Revocation time.** Status lists say "revoked" but not when. Should Capture's status lists carry a revocation date, or should revocation be done only by key rotation, which has a time in the log?
7. **Linkability.** All photos from one camera share its DID. Should the camera support a fresh identity per assignment (each needing an owner credential), as Settle does with per-payment keys?
8. **Tile size.** 64 pixels gives fine redaction and a 16 KB hash list for 1080p. A 12-megapixel photo has about 3,000 tiles (about 94 KB). Use 128-pixel tiles above 4 megapixels?
9. **The verdict as policy.** Should verdict rules be a Rego policy (as the trust core does for authorization), so a newsroom or court can publish its own acceptance rules?
10. **Registry privacy.** Publishing by hash lets anyone holding the same file find its store, which is the point. But the registry learns every lookup. Should lookups go through the relay, or use a private lookup?
11. **Sensor links of 8 bytes.** Enough, or 12?

**For the community**
12. Would CAWG accept an identity assertion type for DIDs with key event logs? Who in ToIP is working on content provenance?
13. Is there interest in a Trust Tasks family for device enrollment (`device/enroll`, `device/rotate`)? It is general, not only for cameras.

## 21. Sources

Read on 2026-11-06 unless noted. Per `docs/provenance.md`, these should get notes in `docs/sources/` when Capture's work is merged.

| Source | How read | Trust | Used for |
|---|---|---|---|
| C2PA Technical Specification 2.2, `https://spec.c2pa.org/specifications/specifications/2.2/specs/C2PA_Specification.html` (the site lists a newer current version) | through a fetch tool that summarizes, in five parts | summary only, with section numbers | 13.1, 9.2, 11.1 |
| CAWG Identity Assertion 1.1, `https://cawg.io/identity/1.1/` (DIF ratified 16 May 2025; site lists 1.3 as current) | fetch tool, first part only | summary only | 13.1 |
| `@contentauth/c2pa-web` 0.16.0 package: README and type declarations (`Builder.sign`, `Signer`, `CredentialHolder`) | downloaded and read directly | primary for its stated API; not run | 13.2 |
| RFC 9052 (COSE structures), RFC 8949 (CBOR, deterministic encoding), RFC 6962 (Merkle tree hashing), RFC 3161 (time-stamps) | from knowledge, not re-read | secondary | 8.1, 8.3, 10.1 |
| RFC 9864, Fully-Specified Algorithms for JOSE and COSE (October 2025): Ed25519 = −19, ESP256 = −9 | search results quoting the RFC | summary only; check the IANA registry when built | 8.1 |
| drand documentation, `https://docs.drand.love/developer/` and the quicknet announcement: chain `52db9ba7…e971`, 3-second period, `bls-unchained-g1-rfc9380` | search results | summary only | 10.1 |
| W3C WebAuthn Level 3: assertion format, flags UP, UV, BE, BS | from knowledge, not re-read | secondary | 7.2, 8.4 |
| Meshtastic `DATA_PAYLOAD_LEN` = 233, 256-byte LoRa packet | search results quoting generated code and forum posts | summary only | 12.4 |
| LoRaWAN Regional Parameters (RP002): payload limits per data rate | from knowledge, not read | guess until checked | 12.4 |
| Solana block time as validators' estimate | from knowledge | guess until checked | 10.1 |
| KERI specification (Trust over IP) | from knowledge; trail owns the details | secondary | 7.3 |
| IPTC Digital Source Type vocabulary, `http://cv.iptc.org/newscodes/digitalsourcetype/` | via the C2PA specification | summary only | 11.1, 13.3 |
| This repository: `packages/trust-core/src`, `@openvtc/trust-tasks-proof` 0.1.6 type declarations (curves `ed25519`, `p256`, `p384`; synchronous `Signer`), `projects/settle/docs/design.md`, `projects/settle/web/src/vault.ts` | read directly | primary | 7, 19 |

## Decisions made (2026-11-06)

The open questions above were settled by the assistant, at the convener's request, so the MVP can be built. Each can be revisited.

- **Camera.** The browser camera app runs on a laptop at `http://localhost`, where passkeys and the camera both work without HTTPS. A phone needs HTTPS on a real hostname; the README explains how with a tunnel, but the MVP doesn't depend on it.
- **Keys.** WebCrypto non-extractable keys for the camera app, and a software key file for the sensor. Secure elements (ATECC608, YubiKey) are deferred.
- **Sensors.** A sensor runs as a Node process with simulated readings (temperature and air quality), and can send them over the mesh transport's simulator, and over the user's LoRa radio once that's set up. A Raspberry Pi with a real sensor comes later.
- **Location.** No GPS: location is a claim made by the owner's installation credential, not something the device proves.
- **Anchoring time.** drand for "not before", and trail witness receipts for "not after". The Solana anchor is optional and off by default.
