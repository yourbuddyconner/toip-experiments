# @toip-tools/relay

A WebSocket mailbox that stores and delivers encrypted TSP messages.

A relay lets parties exchange messages even when they aren't online together. Devices authenticate with their `did:key` by signing a challenge bound to the relay's URL. The relay delivers a message at once to a connected recipient. Otherwise it stores the message in SQLite until the recipient acknowledges it, with limits per sender and per recipient.

The relay can see sender and recipient identifiers, timing, and message sizes. The contents stay encrypted. It delivers TSP Direct messages. It does not implement TSP Routed Mode.

It runs in Node 22.13 or later, because it uses `node:sqlite`. Clients use `RelayTransport` from `@toip-tools/trust-core`, in browsers or in Node.

## Install

```sh
npm install @toip-tools/relay
```

## Run a relay

```sh
npx @toip-tools/relay
```

Configure it with environment variables:

- `PORT`: the port to listen on. The default is 8787.
- `HOST`: the address to bind to.
- `RELAY_DB`: the SQLite file. The default is `./relay.db`.
- `RELAY_PUBLIC_URL`: the URL clients use, for example `wss://relay.example.com/v1`.

## Start a relay in code, and connect to it

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelay } from "@toip-tools/relay";
import { Endpoint, RelayTransport, SystemClock, identityFromSeed } from "@toip-tools/trust-core";

const relay = await startRelay({
  port: 0, // any free port
  host: "127.0.0.1",
  dbPath: join(mkdtempSync(join(tmpdir(), "relay-")), "relay.db"),
  log: (line) => console.log("[relay]", line),
});

const identity = identityFromSeed(crypto.getRandomValues(new Uint8Array(32)));
const transport = new RelayTransport({ url: relay.url, identity });
transport.start();
const me = new Endpoint({ identity, transport, clock: new SystemClock() });
console.log(`${me.vid} uses ${relay.url}`);

transport.stop();
await relay.close();
```

## API

- **Server**: `startRelay`, `Relay`, `RelayOptions`, `RelayLimits`.
- **Limits**: `MAX_MESSAGE_BYTES`, `MAX_QUEUED_PER_RECIPIENT`, `QUEUE_TTL_MS`.

The full guide is at https://toip.tools/toolkit/relay/.
