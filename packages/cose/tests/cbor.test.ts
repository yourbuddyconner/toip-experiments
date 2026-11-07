import { describe, expect, it } from "vitest";
import { decodeCbor, encodeCbor, Tagged } from "../src/index";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (h: string) => new Uint8Array(Buffer.from(h.replace(/\s+/g, ""), "hex"));

describe("deterministic CBOR (RFC 8949 §4.2.1)", () => {
  it("round-trips the data model", () => {
    const value = {
      n: 0,
      neg: -1000,
      big: 2n ** 64n - 1n,
      s: "héllo",
      b: new Uint8Array([1, 2, 3]),
      a: [1, "two", [3], { four: 4 }],
      t: true,
      f: false,
      z: null,
      x: 1.5,
    };
    expect(decodeCbor(encodeCbor(value))).toEqual(value);
  });

  it("keeps integer-keyed maps as Maps and text-keyed maps as objects", () => {
    const value = { headers: new Map<number, unknown>([[1, -8], [4, new Uint8Array([0x31])]]), claim: { v: 1 } };
    const back = decodeCbor<{ headers: Map<number, unknown>; claim: { v: number } }>(encodeCbor(value));
    expect(back.headers).toBeInstanceOf(Map);
    expect(back.headers.get(1)).toBe(-8);
    expect(back.claim).toEqual({ v: 1 });
  });

  it("round-trips tags", () => {
    const bytes = encodeCbor(new Tagged(18, [1, 2]));
    expect(hex(bytes)).toBe("d2820102");
    const back = decodeCbor<Tagged>(bytes);
    expect(back).toBeInstanceOf(Tagged);
    expect(back.tag).toBe(18);
    expect(back.value).toEqual([1, 2]);
    expect(decodeCbor<Tagged>(encodeCbor(new Tagged(1234, "x"))).tag).toBe(1234);
  });

  it("sorts map keys by their encoded bytes, not by length first", () => {
    // "a" = 61 61, "b" = 61 62, "aa" = 62 61 61
    expect(hex(encodeCbor({ aa: 3, b: 2, a: 1 }))).toBe("a3" + "616101" + "616202" + "62616103");
    // 1 = 01, 10 = 0a, 100 = 18 64, -1 = 20
    expect(hex(encodeCbor(new Map([[-1, 0], [100, 0], [10, 0], [1, 0]])))).toBe("a4" + "0100" + "0a00" + "186400" + "2000");
    // integers (major 0, 1) before text (major 3)
    expect(hex(encodeCbor(new Map<unknown, number>([["a", 0], [-1, 0], [1, 0]])))).toBe("a3" + "0100" + "2000" + "616100");
  });

  it("uses the shortest form for integers and lengths", () => {
    const cases: [number | bigint, string][] = [
      [0, "00"], [23, "17"], [24, "1818"], [255, "18ff"], [256, "190100"], [65535, "19ffff"],
      [65536, "1a00010000"], [2 ** 32, "1b0000000100000000"], [-1, "20"], [-24, "37"], [-25, "3818"], [-257, "390100"],
    ];
    for (const [n, h] of cases) expect(hex(encodeCbor(n)), String(n)).toBe(h);
    expect(hex(encodeCbor("x".repeat(23))).slice(0, 2)).toBe("77");
    expect(hex(encodeCbor("x".repeat(24))).slice(0, 4)).toBe("7818");
    expect(hex(encodeCbor(new Uint8Array(256))).slice(0, 6)).toBe("590100");
  });

  it("uses the shortest float that keeps the value", () => {
    expect(hex(encodeCbor(1.5))).toBe("f93e00");
    expect(hex(encodeCbor(100000.5))).toBe("fa47c35040");
    expect(hex(encodeCbor(1.1))).toBe("fb3ff199999999999a");
  });

  it("never writes indefinite lengths", () => {
    const bytes = encodeCbor({ list: [1, 2, 3], text: "abc", bytes: new Uint8Array(3), map: { a: 1 } });
    for (const b of [0x5f, 0x7f, 0x9f, 0xbf, 0xff]) expect(bytes.includes(b), b.toString(16)).toBe(false);
  });

  it("drops undefined properties, so optional fields can be left out", () => {
    expect(encodeCbor({ a: 1, b: undefined })).toEqual(encodeCbor({ a: 1 }));
  });

  describe("decoding is strict by default", () => {
    const bad: [string, string][] = [
      ["indefinite array", "9f0102ff"],
      ["indefinite text", "7f616161ff"],
      ["indefinite bytes", "5f4101ff"],
      ["indefinite map", "bf616101ff"],
      ["integer not in shortest form", "1817"],
      ["length not in shortest form", "780161"],
      ["map keys out of order", "a2616202616101"],
      ["duplicate map keys", "a2616101616102"],
      ["float not in shortest form", "fb3ff8000000000000"],
      ["undefined", "f7"],
      ["trailing bytes", "0101"],
      ["truncated", "8201"],
    ];
    for (const [name, h] of bad) {
      it(`rejects ${name}`, () => expect(() => decodeCbor(unhex(h))).toThrow());
    }
    it("accepts them when asked not to be strict", () => {
      expect(decodeCbor(unhex("9f0102ff"), { strict: false })).toEqual([1, 2]);
      expect(decodeCbor(unhex("a2616202616101"), { strict: false })).toEqual({ a: 1, b: 2 });
    });
  });
});
