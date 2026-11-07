// Two endpoints exchange a signed, encrypted Trust Task over the in-memory Bus.
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
