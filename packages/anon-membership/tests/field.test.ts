import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  FIELD_MODULUS,
  fieldFromBytes,
  fieldFromHex,
  fieldToBytes,
  fieldFromBytes32,
  fieldToHex,
  toField,
} from "../src/field";

describe("fields", () => {
  it("has BN254's scalar modulus", () => {
    expect(FIELD_MODULUS).toBe(21888242871839275222246405745257275088548364400416034343698204186575808495617n);
  });

  it("writes 0x and 64 lowercase hex digits", () => {
    expect(fieldToHex(0n)).toBe("0x" + "0".repeat(64));
    expect(fieldToHex(255n)).toBe("0x" + "0".repeat(62) + "ff");
    expect(fieldFromHex(fieldToHex(12345n))).toBe(12345n);
  });

  it("refuses values at or above the modulus", () => {
    expect(() => fieldToHex(FIELD_MODULUS)).toThrow();
    expect(() => fieldFromHex(fieldToHex(FIELD_MODULUS - 1n).replace(/^0x/, "0x"))).not.toThrow();
    expect(() => fieldFromHex("0x" + FIELD_MODULUS.toString(16).padStart(64, "0"))).toThrow(/modulus/);
    expect(() => fieldFromHex("0x" + "f".repeat(64))).toThrow(/modulus/);
  });

  it("refuses malformed hex", () => {
    expect(() => fieldFromHex("12")).toThrow();
    expect(() => fieldFromHex("0x12")).toThrow();
    expect(() => fieldFromHex("0x" + "G".repeat(64))).toThrow();
    expect(() => fieldFromHex("0x" + "A".repeat(64))).toThrow();
  });

  it("toField reads the first 31 bytes of a digest, big-endian", () => {
    const d = new Uint8Array(32).fill(0xff);
    expect(toField(d)).toBe((1n << 248n) - 1n);
    const e = new Uint8Array(32);
    e[30] = 1;
    e[31] = 9; // ignored
    expect(toField(e)).toBe(1n);
    expect(() => toField(new Uint8Array(31))).toThrow();
  });

  it("fieldFromBytes is toField of SHA-256", () => {
    const b = new TextEncoder().encode("RN");
    expect(fieldFromBytes(b)).toBe(toField(sha256(b)));
  });

  it("round-trips 32-byte big-endian encodings", () => {
    const f = 0x1234n;
    const b = fieldToBytes(f);
    expect(b.length).toBe(32);
    expect(b[31]).toBe(0x34);
    expect(b[30]).toBe(0x12);
    expect(fieldFromBytes32(b)).toBe(f);
    expect(() => fieldFromBytes32(new Uint8Array(32).fill(0xff))).toThrow(/modulus/);
  });
});
