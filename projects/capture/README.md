# Capture

Cameras and sensors with their own identities.

- A device signs what it captures, with a key the page won't give up.
- Every edit adds a signed link to a chain.
- Anyone can check, in a browser, where a photo or reading came from, when it was taken (as an interval it can prove, not only the device clock) and what was done to it.

The design is `docs/design.md`. Its last section, "Implementation notes", says what was built and how it differs.

## Run it

```
npm install
npm run capture                      # at the repository root; or: npm run app --workspace @zk-toip/capture
```

It prints the URLs. Open them on this machine at `http://localhost:4350`:

| Page | What it does |
|---|---|
| `/camera` | Makes this browser a camera (a non-exportable P-256 key in IndexedDB, sealed with a passkey or a passphrase), enrolls it with the owner, and signs each photo from the webcam. Photos are anchored by three witnesses a moment later. |
| `/edit` | Redacts (pixelate, blur or black out) and crops to the 64-pixel grid, then signs the edit as you and saves a PNG. |
| `/verify` | Drop any file. Shows the verdict, the device, the provable time interval, the edit chain, the tile map, and what broke. Also reads Content Credentials (C2PA). |
| `/sensors` | Two simulated stations sending signed readings over a simulated LoRa link. Every frame is checked in the browser. Turn up loss, make the gateway dishonest, request a backfill. |
| `/owner` | The photo desk's devices and their key histories. Retire a lost camera's key. |

One process runs everything: three witnesses (ports 4351 to 4353), the owner and maker who issue credentials, the registry, the drand client, the simulated radio with a gateway, and the two sensors "Riverside 4" and "Rooftop 2". Rooftop 2's clock is a day behind on purpose.

Settings, as environment variables:

- `CAPTURE_PORT` (default 4350; the witnesses use the next three ports).
- `CAPTURE_HOST` (default 127.0.0.1).
- `CAPTURE_DATA` (default `projects/capture/.data`). Delete it to start over.
- `CAPTURE_DRAND=dev` uses a local beacon instead of the public drand quicknet. Without network, it falls back to this on its own.
- `CAPTURE_WEB=static` serves the built app (`npm run build:web --workspace @zk-toip/capture` first).
- `CAPTURE_SENSOR_MS` (default 5000): the built-in sensors' reading interval.

Another sensor, in its own process:

```
npm run sensor --workspace @zk-toip/capture -- --name "Harbor 1" --lat 40.70 --lon -74.01
```

It makes a key file (mode 0600), enrolls with the owner the first time, and joins the world's simulated LoRa medium. Its chain is kept on disk, so a restart continues where it stopped. Add `--clock-skew-hours -24` to give it a wrong clock.

## The demo, in order

1. Camera: make the camera, take a photo. It shows "Signed", then "Anchored by 3 witnesses".
2. Verify it. A fresh verifier says "Signed, issuer not trusted". Choose "Trust Daily Planet photo desk", and it becomes a verified capture with its time interval.
3. Publish the photo. Strip its credentials (`npm run strip --workspace @zk-toip/capture -- photo.jpg`) and verify the stripped copy: the credentials are found in the registry by the file's fingerprint.
4. Edit: blur a face with a reason. Verify the PNG: the chain goes back to the camera, and the tile map shows which tiles are exactly as captured.
5. Change one byte of the PNG and verify it: broken.
6. Owner: retire the camera's key ("device lost"). Take another photo with the old camera and verify it: broken, "signed after this device's key was retired". The first photo still verifies: it was anchored before.
7. Sensors: Rooftop 2's times are struck out and its proven interval is shown. Set loss to 30%, then request a backfill. Turn on the dishonest gateway: one reading turns into a red cross.

The webcam in a laptop browser works at `http://localhost`. Chromium's test camera is named "fake_device_0", and the verifier warns about it, as it would for any virtual camera.

## On a phone

A phone camera and passkeys need HTTPS on a real host name. Serve the world through a tunnel:

```
CAPTURE_WEB=static npm run capture          # after npm run build:web --workspace @zk-toip/capture
cloudflared tunnel --url http://localhost:4350
# or: tailscale serve 4350, then open the https://<machine>.<tailnet>.ts.net address
```

Open the HTTPS address on the phone and go to `/camera`. Each origin has its own keys and trust list.

## Tests

```
npm test --workspace @zk-toip/capture        # Vitest
npm run e2e --workspace @zk-toip/capture     # Playwright, Chromium with a fake camera; add -- --headed to watch
```

The unit and integration tests cover: manifests; embedding in JPEG and PNG and the registry lookup; edit chains (valid, broken parent, an editor nobody vouches for); tile proofs; key rotation, stolen-key recovery and revocation; time (recorded drand quicknet rounds, witness receipts, a lying clock, contradicting evidence); capture/1 mandates; sensor frame sizes, reading chains (gap, reorder, replay, tamper, forged seal, equivocation, a 4-byte tag collision) and readings over the simulated LoRa link to the gateway, with loss, backfill and a dishonest gateway; and the whole world over HTTP, including a sensor in another process that restarts.

The e2e saves screenshots in `web/e2e-shots/`.

## What's built and what isn't

Built: the provenance core (`src/core`), the world (`src/world`), sensors and the gateway (`src/sensors`, `src/sensor`), and the web app (`web`).

Not built yet:

- Passkey signing for each photo ("evidence mode"). The formats and `@zk-toip/cose` support it; the camera uses a browser key.
- Enrollment over TSP through the relay. The camera and sensors enroll over the capture server's HTTP API.
- The relay path for sensor batches (`capture/readings/batch`). The gateway is in the world process.
- Anchoring sensor seals in the sensor's key log. Sensor readings get "not after" from the gateway's signed receipt.
- The Solana anchor, C2PA export, RFC 3161 time-stamps, secure elements and the real LoRa radio.

The sample C2PA image (`web/public/samples/c2pa-sample.jpg`) is `C.jpg` from the c2pa-rs test fixtures.
