// Run a relay, and connect an endpoint to it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelay } from "@toip-tools/relay";
import { Endpoint, RelayTransport, SystemClock, identityFromSeed } from "@toip-tools/trust-core";

const relay = await startRelay({
  port: 0, // any free port; 8787 is the repo's default
  host: "127.0.0.1",
  dbPath: join(mkdtempSync(join(tmpdir(), "relay-")), "relay.db"),
  log: (line) => console.log("[relay]", line),
});

const identity = identityFromSeed(crypto.getRandomValues(new Uint8Array(32)));
const transport = new RelayTransport({ url: relay.url, identity });
transport.onStatus((s) => console.log("relay status:", s));
transport.start();
const me = new Endpoint({ identity, transport, clock: new SystemClock() });

console.log(`${me.vid} uses ${relay.url}; ${transport.pending()} messages waiting to send`);
setTimeout(async () => {
  transport.stop();
  await relay.close();
}, 300);
