// Send an end-to-end encrypted, signed message with the Trust Spanning Protocol (TSP Direct mode),
// and see what the network sees.
import { Bus, Endpoint, SystemClock, identityFromSeed } from "@toip-tools/trust-core";

const clock = new SystemClock();
const random = () => crypto.getRandomValues(new Uint8Array(32));

// The Bus is an in-memory network that records every message. Swap in RelayTransport for a real one.
const network = new Bus(clock);
const alice = new Endpoint({ identity: identityFromSeed(random()), transport: network, clock });
const bob = new Endpoint({ identity: identityFromSeed(random()), transport: network, clock });

// A message type is a URI you choose, and what every message of that type must carry.
const CHAT = {
  typeUri: "https://example.org/spec/chat/message/0.1",
  isBearer: false, // bound to one recipient
  isProofRequired: true, // signed by the sender
  isRecipientRequired: true,
  isIssuedAtRequired: true,
};

// Bob's handler runs only after the message decrypts, the signature matches the sender's DID,
// it is addressed to Bob, it is recent, and it is not a replay.
const received = new Promise<string>((resolve) =>
  bob.handle<{ text: string }, void>(CHAT, (doc, { sender }) => resolve(`${doc.payload.text} (from ${sender === alice.vid ? "Alice" : sender})`)),
);

// notify() is one-way. Use request() when you want a signed reply.
const delivery = await alice.notify(bob.vid, CHAT, { text: "The key is under the blue pot." });
console.log("Delivery:", delivery);
console.log("Bob read:", await received);

// The network sees who wrote to whom, when, and how many bytes. Not the words.
const [wire] = network.records();
console.log(`On the wire: ${wire.from.slice(0, 16)}… -> ${wire.to.slice(0, 16)}…, ${wire.bytes} bytes`);
console.log("Plaintext visible on the wire:", Buffer.from(wire.raw).includes("blue pot"));

// Change one byte in transit and TSP refuses it before any handler runs.
const forged = wire.raw.slice();
forged[forged.length - 40] ^= 0x01;
const result = network.send(alice.vid, bob.vid, forged);
await network.settle();
console.log("A tampered copy:", result.refused ? `refused (${result.refused})` : "accepted");
