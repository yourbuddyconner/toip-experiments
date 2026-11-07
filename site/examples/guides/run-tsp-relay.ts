// Run a TSP mailbox relay in Node: it stores sealed messages in SQLite until the recipient connects,
// survives a restart, and shows its operator only metadata.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelay, type StoredMessage } from "@toip-tools/relay";
import { Endpoint, RelayTransport, SystemClock, identityFromSeed, type Identity } from "@toip-tools/trust-core";

const clock = new SystemClock();
const dir = mkdtempSync(join(tmpdir(), "relay-guide-"));
const dbPath = join(dir, "relay.db"); // in production, a persistent file you back up

const short = (did: string) => `${did.slice(8, 16)}…`;
const options = {
  port: 0, // any free port; npx @toip-tools/relay defaults to 8787
  host: "127.0.0.1",
  dbPath,
  limits: { perSenderPerRecipient: 100 }, // at most 100 messages waiting from one sender to one recipient
  onStored: (m: StoredMessage) =>
    console.log(`[relay] ${short(m.from)} -> ${short(m.to)}: ${m.bytes} bytes, ${m.delivery}`),
};

function connect(identity: Identity, url: string) {
  const transport = new RelayTransport({ url, identity });
  const online = new Promise<void>((resolve) => transport.onStatus((s) => s === "connected" && resolve()));
  transport.start();
  return { transport, online, endpoint: new Endpoint({ identity, transport, clock }) };
}

const NOTE = {
  typeUri: "https://example.org/spec/notes/note/0.1",
  isBearer: false,
  isProofRequired: true,
  isRecipientRequired: true,
  isIssuedAtRequired: true,
};

const alice = identityFromSeed(crypto.getRandomValues(new Uint8Array(32)));
const bob = identityFromSeed(crypto.getRandomValues(new Uint8Array(32)));

// Alice connects and leaves a note for Bob, who is offline.
let relay = await startRelay(options);
console.log("Relay at", relay.url);
const a = connect(alice, relay.url);
await a.online;
console.log("Alice sent:", await a.endpoint.notify(bob.did, NOTE, { text: "Back at 6." }));
console.log("Waiting for Bob:", relay.queued(bob.did));
a.endpoint.close();
a.transport.stop();

// Restart the relay on the same database. The note is still there.
await relay.close();
relay = await startRelay(options);
console.log("Restarted; waiting for Bob:", relay.queued(bob.did));

// Bob connects (signing the relay's challenge with his did:key) and the relay delivers.
const b = connect(bob, relay.url);
const got = new Promise<string>((resolve) => b.endpoint.handle<{ text: string }, void>(NOTE, (doc) => resolve(doc.payload.text)));
await b.online;
console.log("Bob read:", await got);
await new Promise((r) => setTimeout(r, 100)); // Bob's acknowledgement reaches the relay, which deletes its copy
console.log("Waiting for Bob:", relay.queued(bob.did));

b.endpoint.close();
b.transport.stop();
await relay.close();
rmSync(dir, { recursive: true, force: true });
