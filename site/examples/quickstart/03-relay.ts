// Step 3: the same kind of message over a real relay, to someone who is offline.
// Run from the repository root:
//   npx tsx --tsconfig site/tsconfig.json site/examples/quickstart/03-relay.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelay } from "@toip-tools/relay";
import { Endpoint, RelayTransport, SystemClock, identityFromSeed, seedFrom, type Identity } from "@toip-tools/trust-core";

const short = (did: string) => `${did.slice(0, 14)}…${did.slice(-4)}`;
const clock = new SystemClock();

// A mailbox relay on a free port. It stores sealed messages until their recipient collects them.
const dir = mkdtempSync(join(tmpdir(), "quickstart-relay-"));
const relay = await startRelay({ port: 0, host: "127.0.0.1", dbPath: join(dir, "relay.db") });
console.log(`Relay listening at ${relay.url}`);

// Each device signs in to the relay as its own did:key, by signing a challenge.
function connect(identity: Identity) {
  const transport = new RelayTransport({ url: relay.url, identity });
  const online = new Promise<void>((resolve) => transport.onStatus((s) => s === "connected" && resolve()));
  transport.start();
  return { transport, online };
}

const NOTE = {
  typeUri: "https://example.org/spec/quickstart/note/0.1",
  isBearer: false,
  isProofRequired: true,
  isRecipientRequired: true,
  isIssuedAtRequired: true,
};

const aliceId = identityFromSeed(seedFrom("quickstart/alice"));
const bobId = identityFromSeed(seedFrom("quickstart/bob"));

// Alice comes online. Bob doesn't.
const a = connect(aliceId);
const alice = new Endpoint({ identity: aliceId, transport: a.transport, clock });
await a.online;
console.log(`Alice connected as ${short(alice.vid)}`);

// notify() is one-way: no reply expected, so it works when Bob is away.
const delivery = await alice.notify(bobId.did, NOTE, { text: "Dinner at 7? Bring the bread." });
console.log(`Alice sent a note: ${delivery}. Waiting at the relay for Bob: ${relay.queued(bobId.did)}`);

// Later, Bob comes online and collects it.
const b = connect(bobId);
const bob = new Endpoint({ identity: bobId, transport: b.transport, clock });
const received = new Promise<string>((resolve) => {
  bob.handle<{ text: string }, void>(NOTE, (doc, { sender }) => resolve(`from ${short(sender)}: "${doc.payload.text}"`));
});
await b.online;
console.log(`Bob connected as ${short(bob.vid)}`);
console.log(`Bob opened a note ${await received}`);

// Bob acknowledges after his handler finishes; then the relay deletes its copy.
await new Promise((r) => setTimeout(r, 100));
console.log(`Waiting at the relay for Bob: ${relay.queued(bobId.did)}`);
console.log("The relay saw who wrote to whom, when, and how many bytes. It could not read the note.");

alice.close();
bob.close();
a.transport.stop();
b.transport.stop();
await relay.close();
rmSync(dir, { recursive: true, force: true });
