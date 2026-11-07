import { describe, expect, it } from "vitest";
import { DataIntegrityProofVerifier, signTrustTask } from "@openvtc/trust-tasks-proof";
import type { TrustTaskDocument } from "@openvtc/trust-tasks/runtime";
import { DemoClock } from "../src/clock";
import { identityFromSeed, seedFrom } from "../src/identity";
import { issueCredential, signDocument, verifyDocument } from "../src/credentials";
import { CTT1_FORMAT, ctt1, decodeBody, encodeBody, jsonBody } from "../src/compact";
import { ourSpec } from "../src/tasks";

const clock = new DemoClock("2026-11-05T14:30:00.123Z");
const alice = identityFromSeed(seedFrom("ctt1/alice"));
const door = identityFromSeed(seedFrom("ctt1/door"));
const building = identityFromSeed(seedFrom("ctt1/building"));
const ctx = { sender: alice.did, receiver: door.did };

function taskDoc(payload: unknown, type = ourSpec("mesh-demo/door/open").typeUri): TrustTaskDocument<unknown> {
  const doc: TrustTaskDocument<unknown> = {
    id: "urn:uuid:3f1c2a4e-9b7d-4c1e-8a2f-0d5e6b7c8a90",
    type,
    issuer: alice.did,
    recipient: door.did,
    issuedAt: clock.iso(),
    payload,
  };
  return signTrustTask(doc, alice.signer, { created: clock.date() });
}

function guestPass() {
  return issueCredential(building, clock, {
    type: ["VerifiableCredential", "GuestPass"],
    validUntil: "2026-11-05T20:00:00Z",
    credentialSubject: { id: alice.did, door: "front", household: "4B", role: "dog walker", days: ["mon", "tue", "wed", "thu", "fri"], from: "12:00", until: "14:00" },
    credentialStatus: { type: "BitstringStatusListEntry", statusListIndex: 412, statusListCredential: "https://toip.tools/status/building/1" },
  });
}

const same = (a: unknown, b: unknown) => expect(JSON.stringify(b)).toBe(JSON.stringify(a));

describe("CTT1 body codec", () => {
  it("round-trips the reference messages to the identical document, much smaller", () => {
    const vectors = [
      taskDoc({}),
      taskDoc({ credential: guestPass(), challenge: "9f3a77c1e0b2d4f6" }),
      taskDoc({ attestation: signDocument({ type: "settle/attestation", issuer: alice.did, termsHash: "ab".repeat(32), claim: "complete", at: clock.iso() }, alice, clock) }),
      taskDoc({ sensor: "soil-3", t: "2026-11-05T14:29:58Z", kind: "moisture", value: 31.5, unit: "%" }),
    ];
    for (const doc of vectors) {
      const body = encodeBody(doc, ctx, ctt1);
      expect(body[0]).toBe(CTT1_FORMAT);
      same(doc, decodeBody(body, ctx));
      const json = encodeBody(doc, ctx);
      expect(body.length).toBeLessThan(json.length * 0.4);
    }
  });

  it("keeps outer and nested Data Integrity proofs verifiable after decoding", async () => {
    const doc = taskDoc({ credential: guestPass(), challenge: "9f3a77c1e0b2d4f6" });
    const back = decodeBody(encodeBody(doc, ctx, ctt1), ctx) as TrustTaskDocument<{ credential: object }>;
    const verifier = new DataIntegrityProofVerifier({ now: () => clock.now() });
    expect(await verifier.verify(back)).toBe(true);
    expect((await verifyDocument(back.payload.credential, clock)).valid).toBe(true);
  });

  it("compacts a standard proof to its creation time and 64 raw signature bytes", () => {
    const doc = taskDoc({});
    const withProof = ctt1.encode(doc, ctx)!;
    const { proof: _p, ...bare } = doc;
    const without = ctt1.encode(bare as TrustTaskDocument<unknown>, ctx)!;
    expect(withProof.length - without.length).toBeLessThanOrEqual(80);
  });

  it("encodes a non-standard proof generically, and still round-trips", () => {
    const doc = taskDoc({});
    const odd = { ...doc, proof: { ...(doc.proof as object), proofPurpose: "authentication" } };
    const body = encodeBody(odd as TrustTaskDocument<unknown>, ctx, ctt1);
    expect(body[0]).toBe(CTT1_FORMAT);
    same(odd, decodeBody(body, ctx));
  });

  it("binds the sender and receiver VIDs to the TSP envelope's", () => {
    const doc = taskDoc({});
    const body = ctt1.encode(doc, ctx)!;
    const other = identityFromSeed(seedFrom("ctt1/other")).did;
    const swapped = decodeBody(body, { sender: other, receiver: door.did });
    expect(swapped.issuer).toBe(other);
  });

  it("leaves values the rules don't fit as text, and still round-trips", () => {
    const tricky = taskDoc({
      upper: "urn:uuid:3F1C2A4E-9B7D-4C1E-8A2F-0D5E6B7C8A90",
      badDay: "2026-02-30T00:00:00Z",
      fraction: "2026-11-05T14:30:00.5Z",
      offset: "2026-11-05T14:30:00+01:00",
      early: "1969-12-31T23:59:59.999Z",
      notAKey: "did:key:z6MkNotARealKeyAtAll",
      vmOther: `${alice.did}#key-1`,
      prefixOnly: "https://trusttasks.org/",
      big: 2 ** 60,
      neg: -(2 ** 40),
      float: 0.1,
      f32: 1.5,
      tiny: 5e-324,
      empty: "",
      unicode: "naïve ☃ 𝄞",
      nested: [[[]], {}, [null, true, false, 0, -1]],
      "": "empty key",
      __proto__x: 1,
      "0": "integer-like key",
    });
    const body = encodeBody(tricky, ctx, ctt1);
    expect(body[0]).toBe(CTT1_FORMAT);
    same(tricky, decodeBody(body, ctx));
  });

  it("keeps a __proto__ key as data", () => {
    const doc = JSON.parse(JSON.stringify(taskDoc({})).replace('"payload":{}', '"payload":{"__proto__":{"polluted":true}}'));
    const back = decodeBody(encodeBody(doc, ctx, ctt1), ctx) as TrustTaskDocument<Record<string, unknown>>;
    same(doc, back);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(back.payload)).toBe(Object.prototype);
  });

  it("falls back to the JSON body when it can't prove identity", () => {
    const lone = taskDoc({ text: "broken \ud800 surrogate" });
    expect(ctt1.encode(lone, ctx)).toBeNull();
    const body = encodeBody(lone, ctx, ctt1);
    expect(body[0]).toBe(0x7b);
    same(lone, decodeBody(body, ctx));
    // A JSON reader sees Infinity as null; so does a CTT1 reader.
    const inf = { id: "urn:uuid:00000000-0000-4000-8000-000000000000", type: "t", payload: { n: Number.POSITIVE_INFINITY } } as TrustTaskDocument<unknown>;
    const b2 = encodeBody(inf, ctx, ctt1);
    same(JSON.parse(JSON.stringify(inf)), decodeBody(b2, ctx));
  });

  it("uses JSON when asked, byte for byte what packTrustTask seals", () => {
    const doc = taskDoc({ a: 1 });
    const body = encodeBody(doc, ctx, jsonBody);
    expect(new TextDecoder().decode(body)).toBe(JSON.stringify({ type: "https://trusttasks.org/binding/tsp/0.1/envelope", document: doc }));
    expect(encodeBody(doc, ctx)).toEqual(body);
  });

  it("round-trips random JSON documents", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
    const strings = [
      alice.did,
      door.did,
      building.did,
      `${building.did}#${building.did.slice(8)}`,
      "urn:uuid:3f1c2a4e-9b7d-4c1e-8a2f-0d5e6b7c8a90",
      "2026-11-05T14:30:00.123Z",
      "2026-11-05T14:30:00Z",
      "VerifiableCredential",
      "https://toip.tools/spec/todo/op/0.1",
      "https://trusttasks.org/spec/x",
      "z",
      "",
      "ü",
    ];
    const value = (depth: number): unknown => {
      const r = rnd();
      if (depth > 3 || r < 0.3) return pick<unknown>([null, true, false, Math.floor(rnd() * 1e6) - 5e5, rnd() * 1000, 2 ** 53 + 2, pick(strings), pick(strings) + "x"]);
      if (r < 0.6) return Array.from({ length: Math.floor(rnd() * 4) }, () => value(depth + 1));
      const o: Record<string, unknown> = {};
      for (let i = 0; i < rnd() * 5; i++) o[pick(["id", "type", "issuer", "proof", "k" + i, "payload", "value", "@context"])] = value(depth + 1);
      return o;
    };
    for (let i = 0; i < 2000; i++) {
      const doc = { id: "urn:uuid:00000000-0000-4000-8000-000000000000", type: "t", payload: value(0) } as TrustTaskDocument<unknown>;
      same(doc, decodeBody(encodeBody(doc, ctx, ctt1), ctx));
    }
  });

  it("refuses junk without throwing anything but an Error, and never hangs", () => {
    const good = ctt1.encode(taskDoc({ a: [1, 2, 3] }), ctx)!;
    let seed = 99;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (let i = 0; i < 3000; i++) {
      const junk = i % 2 ? good.slice(0, Math.floor(rnd() * good.length)) : Uint8Array.from({ length: Math.floor(rnd() * 64) }, () => Math.floor(rnd() * 256));
      if (i % 3 === 0 && junk.length > 1) junk[Math.floor(rnd() * junk.length)] ^= 0xff;
      junk[0] = CTT1_FORMAT;
      try {
        decodeBody(junk, ctx);
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
      }
    }
    expect(() => decodeBody(Uint8Array.of(CTT1_FORMAT, 0x9f), ctx)).toThrow();
    expect(() => decodeBody(new Uint8Array(0), ctx)).toThrow();
  });
});
