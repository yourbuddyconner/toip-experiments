// Seals a real Trust Task from Alice to Bob when the site is built, for the landing page.
import { Bus, Endpoint, SystemClock, identityFromSeed, seedFrom } from "@toip-tools/trust-core";

export interface SealedSample {
  alice: string;
  bob: string;
  bytes: number;
  /** The wire, cut where an observer would see structure. */
  parts: { kind: "head" | "sender" | "frame" | "receiver" | "sealed" | "signature"; hex: string; text?: string; length: number }[];
  document: Record<string, unknown>;
  builtAt: string;
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

export async function sealSample(): Promise<SealedSample> {
  const clock = new SystemClock();
  const bus = new Bus(clock);
  const alice = new Endpoint({ identity: identityFromSeed(seedFrom("quickstart/alice")), transport: bus, clock });
  const bob = new Endpoint({ identity: identityFromSeed(seedFrom("quickstart/bob")), transport: bus, clock });
  const HELLO = {
    typeUri: "https://example.org/spec/quickstart/hello/0.1",
    isBearer: false,
    isProofRequired: true,
    isRecipientRequired: true,
    isIssuedAtRequired: true,
  };
  bob.handle(HELLO, () => undefined);
  await alice.notify(bob.vid, HELLO, { text: "Hello Bob, it's Alice." });
  await bus.settle();
  const rec = bus.records()[0];
  if (!rec.opened) throw new Error(`hero: Bob could not open the sample (${rec.refused})`);

  const wire = rec.raw;
  const latin = Buffer.from(wire).toString("latin1");
  const s = latin.indexOf(alice.vid);
  const r = latin.indexOf(bob.vid);
  if (s < 0 || r < s) throw new Error("hero: the TSP envelope no longer carries the VIDs in clear; update hero.ts");
  const sigLen = 64;
  const cut = (a: number, b: number) => wire.slice(a, b);
  const parts: SealedSample["parts"] = [
    { kind: "head", hex: hex(cut(0, s)), length: s },
    { kind: "sender", hex: hex(cut(s, s + alice.vid.length)), text: alice.vid, length: alice.vid.length },
    { kind: "frame", hex: hex(cut(s + alice.vid.length, r)), length: r - s - alice.vid.length },
    { kind: "receiver", hex: hex(cut(r, r + bob.vid.length)), text: bob.vid, length: bob.vid.length },
    { kind: "sealed", hex: hex(cut(r + bob.vid.length, wire.length - sigLen)), length: wire.length - sigLen - r - bob.vid.length },
    { kind: "signature", hex: hex(cut(wire.length - sigLen, wire.length)), length: sigLen },
  ];
  alice.close();
  bob.close();
  return { alice: alice.vid, bob: bob.vid, bytes: wire.length, parts, document: rec.opened.document as unknown as Record<string, unknown>, builtAt: clock.iso() };
}
