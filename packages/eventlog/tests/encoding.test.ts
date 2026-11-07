import { describe, expect, it } from "vitest";
import { blake3 } from "@noble/hashes/blake3.js";
import fixtures from "./fixtures/keripy-kels.json";
import {
  Code,
  decode,
  decodeIndexedSig,
  decodeKeyRefSig,
  digest,
  encode,
  encodeIndexedSig,
  encodeKeyRefSig,
  nextKeyDigest,
  nonTransferableAid,
  didKeyOf,
  aidOfDidKey,
} from "../src/cesr";
import { checkBody, makeBody, parseMessage, saidify, versionString } from "../src/said";
import { ed25519Signer, p256Signer, keyQb64 } from "../src/keys";
import { fromStream, toStream } from "../src/stream";

const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

describe("qb64", () => {
  const cases: [string, number, number][] = [
    ["D", 32, 44],
    ["B", 32, 44],
    ["E", 32, 44],
    ["I", 32, 44],
    ["0A", 16, 24],
    ["0B", 64, 88],
    ["0I", 64, 88],
    ["1AAJ", 33, 48],
    ["1AAI", 33, 48],
  ];
  it.each(cases)("round trip %s", (code, rawLen, qbLen) => {
    const raw = bytes(rawLen, 0xa5);
    const q = encode(code, raw);
    expect(q.length).toBe(qbLen);
    expect(q.startsWith(code)).toBe(true);
    const back = decode(q);
    expect(back.code).toBe(code);
    expect([...back.raw]).toEqual([...raw]);
  });

  it("variable-length bytes round trip with lead bytes", () => {
    for (const n of [0, 1, 2, 3, 37, 100, 200]) {
      const raw = bytes(n, 3);
      const q = encode("4B", raw);
      expect(q.length % 4).toBe(0);
      expect([...decode(q).raw]).toEqual([...raw]);
    }
  });

  it("rejects wrong lengths and unknown codes", () => {
    expect(() => encode("D", bytes(31))).toThrow();
    expect(() => encode("Z", bytes(32))).toThrow();
    const q = encode("D", bytes(32));
    expect(() => decode(q.slice(0, 43))).toThrow();
    expect(() => decode("Z" + q.slice(1))).toThrow();
    expect(() => decode(q + "A")).toThrow();
  });

  it("indexed signatures: A, B, 2A, E", () => {
    const sig = bytes(64, 9);
    for (const s of [
      { code: "A", index: 3, sig },
      { code: "B", index: 5, sig },
      { code: "2A", index: 0, ondex: 1, sig },
      { code: "2A", index: 70, ondex: 2, sig },
      { code: "E", index: 1, sig },
      { code: "2F", index: 1, sig },
    ] as const) {
      const q = encodeIndexedSig(s);
      expect(q.length).toBe(s.code.length === 1 ? 88 : 92);
      const back = decodeIndexedSig(q);
      expect(back.code).toBe(s.code);
      expect(back.index).toBe(s.index);
      if (s.code === "2A") expect(back.ondex).toBe(s.ondex);
      expect([...back.sig]).toEqual([...sig]);
    }
  });

  it("-F group round trip", () => {
    const aid = digest("x");
    const text = encodeKeyRefSig({ aid, estSn: 2, estSaid: digest("y"), sigs: [{ code: "A", index: 0, sig: bytes(64) }] });
    expect(text.startsWith("-FAB")).toBe(true);
    const back = decodeKeyRefSig(text);
    expect(back.aid).toBe(aid);
    expect(back.estSn).toBe(2);
    expect(back.sigs).toHaveLength(1);
  });

  it("did:key and B AIDs convert both ways", () => {
    const s = ed25519Signer(bytes(32, 1));
    const b = nonTransferableAid(s.publicKey);
    const did = didKeyOf(b);
    expect(did.startsWith("did:key:z6Mk")).toBe(true);
    expect(aidOfDidKey(did)).toBe(b);
  });
});

describe("digests and SAIDs", () => {
  it("said: CESR known answers", () => {
    const ex1 = "field_0_01234567############################################field_2_98765432";
    const said1 = encode("E", blake3(new TextEncoder().encode(ex1)));
    expect(said1).toBe("ENI2bDYghiu1KYYkFrPofH8tJ5tNiNt8WrTIc4s_5IIH");
    const ex2 = '{"said":"############################################","first":"Sue","last":"Smith","role":"Founder"}';
    expect(digest(ex2)).toBe("EJymtAC4piy_HkHWRs4JSRv0sb53MZJr8BQ4SMixXIVJ");
  });

  it("next digest: known answer from KERIpy", () => {
    for (const v of fixtures.vectors) {
      const signer = v.curve === "p256" ? p256Signer(hex(v.seed)) : ed25519Signer(hex(v.seed));
      if (v.nontransferable) expect(nonTransferableAid(signer.publicKey)).toBe(v.key);
      else expect(keyQb64(signer)).toBe(v.key);
      expect(nextKeyDigest(v.key)).toBe(v.digest);
    }
  });

  it("saidify reproduces a KERIpy inception", () => {
    const [first] = fromStream(fixtures.kels[0].stream).messages;
    const b = first.body as Record<string, unknown>;
    const { raw } = saidify("KERI", { ...b, v: "", d: "", i: "" }, ["d", "i"]);
    expect(raw).toBe(first.raw);
  });

  it("version string: the length is right, and wrong after any change of length", () => {
    const { raw } = saidify("ZKTR", { v: "", t: "tin", d: "", i: "", s: "0", ci: digest("c"), dt: "2026-11-06T00:00:00.000Z", m: "x" }, ["d", "i"]);
    expect(raw.slice(6, 23)).toBe(versionString("ZKTR", raw.length));
    expect(parseMessage(raw).ok).toBe(true);
    const longer = raw.replace('"m":"x"', '"m":"xy"');
    const r = parseMessage(longer);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem.code).toBe("badVersion");
  });

  it("canonical raw: whitespace, reordered fields and escaped non-ASCII are rejected", () => {
    const { raw } = saidify("ZKTR", { v: "", t: "tin", d: "", i: "", s: "0", ci: digest("c"), dt: "2026-11-06T00:00:00.000Z", m: "é" }, ["d", "i"]);
    const variants = [
      raw.replace('"t":"tin",', '"t": "tin" ,').replace('"m":"é"', '"m":"é"'),
      raw.replace(/"s":"0","ci":("[^"]+")/, '"ci":$1,"s":"0"'),
      raw.replace('"m":"é"', '"m":"\\u00e9"'),
    ];
    for (const v of variants) {
      // fix the length so only the canonical check can fail
      const fixed = v.slice(0, 6) + versionString("ZKTR", new TextEncoder().encode(v).length) + v.slice(23);
      const r = parseMessage(fixed);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(["badFields", "saidMismatch"]).toContain(r.problem.code);
    }
  });

  it("bodies: SAID over JCS with a salt", () => {
    const { body, said } = makeBody({ kind: "agent/payment", amount: "340.00" });
    expect(body.d).toBe(said);
    expect(String(body.u).startsWith("0A")).toBe(true);
    expect(checkBody(body)).toBe(true);
    expect(checkBody({ ...body, amount: "3400.00" })).toBe(false);
    const again = makeBody({ kind: "agent/payment", amount: "340.00" });
    expect(again.said).not.toBe(said);
  });
});

describe("streams", () => {
  it("parses KERIpy streams and emits identical text", () => {
    for (const k of fixtures.kels) {
      const { messages, problems } = fromStream(k.stream);
      expect(problems).toEqual([]);
      expect(messages.length).toBe(3 - (k.name === "multisig" ? 1 : 0));
      expect(toStream(messages)).toBe(k.stream);
    }
  });

  it("reports garbage as a problem, never throws", () => {
    const r = fromStream("{not json");
    expect(r.problems.length).toBeGreaterThan(0);
    const r2 = fromStream(fixtures.kels[0].stream.slice(0, -5));
    expect(r2.problems.length).toBeGreaterThan(0);
  });
});
