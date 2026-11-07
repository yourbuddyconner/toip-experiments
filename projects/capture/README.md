# Capture

Cameras and sensors with their own identities.

- A device signs what it captures, with a key the page or chip won't give up.
- Every edit adds a signed link to a chain.
- Anyone can check, in a browser, where a photo or reading came from, when it was taken (as an interval it can prove, not only the device clock) and what was done to it.

It has four parts:

- **Camera app** (browser or phone). Each photo gets a signed capture manifest. Its key is a non-extractable WebCrypto key, or a passkey in evidence mode.
- **Editor.** Redact and crop. The verifier can then prove that every pixel outside the redacted area is exactly what the camera captured, without seeing the original.
- **Sensors** (Node, optionally on a Raspberry Pi). Signed, hash-chained readings small enough for LoRa: 42 bytes per reading and 141 bytes per signed seal.
- **Verifier and sensor dashboard.** They check everything locally and trust no server.

Device key history comes from `projects/trail`, and the radio links from `projects/mesh`. The format is shaped like C2PA (Content Credentials). The verifier reads C2PA, and a C2PA export is planned.

State: design written, not built. Read `docs/design.md`.
