import { describe, expect, it } from "vitest";
import { Bus, DemoClock, Endpoint, ctt1, issueCredential, ourSpec, signDocument, type Identity } from "@zk-toip/trust-core";
import { estimate } from "../src/frame";
import { sealSender } from "../src/keys";
import { encodePacket } from "../src/packet";
import { splitTsp } from "../src/tsp";
import { ident } from "./helpers";

const clock = new DemoClock("2026-11-06T12:04:00.123Z");
const building = ident("sizes/building");
const rosa = ident("sizes/rosa");
const door = ident("sizes/door");

function endpoint(id: Identity, compact: boolean) {
  return new Endpoint({ identity: id, transport: new Bus(clock), clock, bodyCodecFor: compact ? () => ctt1 : undefined });
}

const guestPass = () =>
  issueCredential(building, clock, {
    type: ["VerifiableCredential", "GuestPass"],
    validUntil: "2026-11-30T23:59:59Z",
    credentialSubject: { id: rosa.did, door: "front", household: "4B", role: "dog walker" },
  });

const attestation = () =>
  signDocument({ type: "settle/attestation", issuer: rosa.did, termsHash: "9f3a77c1e0b2d4f6".repeat(4), claim: "complete", at: clock.iso(), note: "sink fixed" }, rosa, clock);

/** The design's table (section 5.1): document JSON, TSP-sealed today, our compact form on the air. */
const table = [
  { name: "empty request", spec: ourSpec("mesh-demo/ping"), payload: () => ({}), sealed: 996, air: 252 },
  { name: "guest-pass presentation", spec: ourSpec("mesh-demo/door/open"), payload: () => ({ credential: guestPass(), challenge: "9f3a77c1e0b2d4f6" }), sealed: 1824, air: 477, intro: 559 },
  { name: "settle attestation", spec: ourSpec("settle/escrow/attest"), payload: () => ({ attestation: attestation() }), sealed: 1605, air: 432 },
  { name: "sensor reading", spec: ourSpec("capture/reading"), payload: () => ({ sensor: "soil-3", t: "2026-11-06T12:03:58Z", kind: "moisture", value: 31.5, unit: "%" }), sealed: 1140, air: 312 },
];

describe("sizes, against the design's measurements", () => {
  it("cuts each reference message to about a quarter on the air", async () => {
    const rows: string[] = [];
    for (const m of table) {
      const payload = m.payload();
      const json = await endpoint(rosa, false).seal(door.did, m.spec, payload);
      const compact = await endpoint(rosa, true).seal(door.did, m.spec, payload);
      const p = splitTsp(compact);
      const pair = encodePacket({ kind: "pair", tag: new Uint8Array(4), enc: p.enc, ct: p.ct, signature: p.signature }).length;
      const intro = encodePacket({ kind: "intro", sealedSender: await sealSender(rosa.did, door.encryptionPublic, p.enc), enc: p.enc, ct: p.ct, signature: p.signature }).length;
      const frames = estimate(intro, { mtu: 250, airtimeMs: () => 0 }).frames;
      rows.push(`${m.name.padEnd(24)} sealed ${String(json.length).padStart(5)} (design ${m.sealed})  on air ${String(pair).padStart(4)} (design ${m.air})  as INTRO ${intro}${m.intro ? ` (design ${m.intro})` : ""}  ${Math.round((100 * pair) / json.length)}%  ${frames} frames`);
      console.log(rows.at(-1));
      expect(Math.abs(json.length - m.sealed) / m.sealed).toBeLessThan(0.15);
      expect(Math.abs(pair - m.air) / m.air).toBeLessThan(0.15);
      expect(pair / json.length).toBeLessThan(0.3);
      if (m.intro) expect(Math.abs(intro - m.intro) / m.intro).toBeLessThan(0.15);
      // A TSP-sealed Trust Task never fits in one 250-byte frame: two frames is the floor.
      expect(Math.ceil(pair / 242)).toBeGreaterThanOrEqual(2);
    }
  });
});
