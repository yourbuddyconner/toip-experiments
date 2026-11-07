// Step 2: a signed, encrypted Trust Task from Alice to Bob, over an in-memory network.
// Run from the repository root:
//   npx tsx --tsconfig site/tsconfig.json site/examples/quickstart/02-trust-task.ts
import { Bus, Endpoint, SystemClock, identityFromSeed, seedFrom } from "@toip-tools/trust-core";

const short = (did: string) => `${did.slice(0, 14)}…${did.slice(-4)}`;
const clock = new SystemClock();

// The Bus delivers sealed bytes by DID and lets us watch the wire. Step 3 swaps it for the relay.
const bus = new Bus(clock);
// #region hero
const alice = new Endpoint({ identity: identityFromSeed(seedFrom("quickstart/alice")), transport: bus, clock });
const bob = new Endpoint({ identity: identityFromSeed(seedFrom("quickstart/bob")), transport: bus, clock });
// #endregion

// A message type is a URI you control, plus what a receiver demands of every message of that type.
const HELLO = {
  typeUri: "https://example.org/spec/quickstart/hello/0.1",
  isBearer: false, // addressed to one recipient, not usable by whoever holds it
  isProofRequired: true, // must carry the sender's signature
  isRecipientRequired: true,
  isIssuedAtRequired: true,
};

// Bob's handler runs only after the message decrypts, its signature verifies against the
// sender's DID, it is addressed to Bob, it is fresh, and it is not a replay.
// #region hero
bob.handle<{ text: string }, { reply: string }>(HELLO, (doc, { sender }) => {
  console.log(`Bob opened ${doc.type}`);
  console.log(`  from ${short(sender)}, signed with ${doc.proof?.cryptosuite}`);
  console.log(`  says: "${doc.payload.text}"`);
  return { reply: "Hi Alice. Your signature checks out." };
});

const answer = await alice.request<{ text: string }, { reply: string }>(bob.vid, HELLO, { text: "Hello Bob, it's Alice." });
// #endregion
console.log(`Alice got a reply of type ${answer.type.split("/spec/")[1]}`);
console.log(`  "${answer.payload.reply}"`);

// What anyone watching the network saw: who, to whom, how big. Not the contents.
console.log("\nOn the wire:");
for (const r of bus.records()) console.log(`  #${r.seq} ${short(r.from)} -> ${short(r.to)}  ${r.bytes} bytes  …${r.head.slice(-16)}`);

// Flip one bit of Alice's message and send it again. Bob's TSP layer refuses it before any handler runs.
const forged = bus.records()[0].raw.slice();
forged[forged.length - 40] ^= 0x01;
const rec = bus.send(alice.vid, bob.vid, forged);
await bus.settle();
console.log(`\nA copy with one bit flipped: refused (${rec.refused})`);
