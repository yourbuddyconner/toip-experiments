# @toip-tools/trust-core

Identities, signed and encrypted Trust Tasks over TSP, credentials, status lists and local policy.

An `Identity` combines an Ed25519 signing key, its `did:key` identifier, and a derived X25519 encryption key. An `Endpoint` sends Trust Tasks in TSP Direct messages. Each document carries a Data Integrity proof (`eddsa-jcs-2022`) and is encrypted for its recipient with HPKE. The receiver checks the signature, recipient, timestamp, and replay history before it calls your handler.

The protocol implementation comes from the OpenVTC TypeScript libraries: `@openvtc/vti-tsp-js`, `@openvtc/trust-tasks`, `@openvtc/trust-tasks-tsp`, and `@openvtc/trust-tasks-proof`. Choose a `Transport` for delivery: the in-memory `Bus` for tests and demos, or `RelayTransport` for a WebSocket relay (`@toip-tools/relay`).

It runs in browsers and in Node 22 or later.

## Install

```sh
npm install @toip-tools/trust-core
```

## Example

Two endpoints exchange a signed, encrypted Trust Task over the in-memory `Bus`:

```ts
import { Bus, Endpoint, Refusal, SystemClock, identityFromSeed, ourSpec } from "@toip-tools/trust-core";

const clock = new SystemClock();
const bus = new Bus(clock);
const random = () => crypto.getRandomValues(new Uint8Array(32));
const shop = new Endpoint({ identity: identityFromSeed(random()), transport: bus, clock });
const customer = new Endpoint({ identity: identityFromSeed(random()), transport: bus, clock });

// ourSpec("x") is https://toip.tools/spec/x/0.1: signed, addressed, timestamped.
const QUOTE = ourSpec("example/quote");

shop.handle<{ item: string }, { cents: number }>(QUOTE, (doc) =>
  doc.payload.item === "bike tune-up" ? { cents: 4500 } : new Refusal("unknownItem", `no price for ${doc.payload.item}`),
);

const reply = await customer.request<{ item: string }, { cents: number }>(shop.vid, QUOTE, { item: "bike tune-up" });
console.log(reply.payload.cents, "signed by", reply.issuer === shop.vid ? "the shop" : "someone else");
```

## API

- **Identity**: `identityFromSeed`, `seedFrom`, `resolveDidKey`, `Identity`.
- **Messaging**: `Endpoint`, `ourSpec`, `Refusal`, `TaskError`, `Traffic`.
- **Transports**: `Bus`, `RelayTransport`, `Transport`, `Delivery`, `OutboxStore`.
- **Credentials**: `issueCredential`, `verifyCredential`, `signDocument`, `verifyDocument`, `Credential`.
- **Status lists**: `StatusList`, `checkStatus`, `isRevokedIn`, `StatusListDoc`.
- **Sealing data for several readers**: `sealItem`, `openItem`, `resealText`.
- **Policy**: `Policies` (Rego compiled to WebAssembly).
- **Time and encoding**: `SystemClock`, `DemoClock`, `toB64u`, `fromB64u`, `canonicalJson`.

The full guide is at https://toip.tools/toolkit/trust-core/.
