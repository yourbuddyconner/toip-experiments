import { describe, expect, it } from "vitest";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalJson } from "@toip-tools/trust-core";
import { toField } from "../src/field";
import {
  dayFromIso,
  dayOf,
  decodeMembershipCode,
  deriveSecret,
  encodeMembershipCode,
  groupFieldOf,
  groupIdOf,
  isoFromDay,
  memberSecret,
  messageOf,
  scopeOf,
} from "../src/encode";

const enc = new TextEncoder();
const seed = sha256(enc.encode("a wallet seed"));
const groupId = "did:key:z6MkAcme#employees";

describe("scopes and messages", () => {
  it("scopeOf = toField(SHA-256(JCS([tag, app, ...parts])))", () => {
    const expected = toField(sha256(enc.encode(canonicalJson(["anon-membership/v1/scope", "tipline/v1", "did:key:z6MkBox", "story-1"]))));
    expect(scopeOf("tipline/v1", "did:key:z6MkBox", "story-1")).toBe(expected);
  });

  it("scopes differ by app and by every part", () => {
    const a = scopeOf("tipline/v1", "box", "s1");
    expect(scopeOf("tipline/v1", "box", "s2")).not.toBe(a);
    expect(scopeOf("agora/v1", "box", "s1")).not.toBe(a);
    expect(scopeOf("tipline/v1", "box", "s1")).toBe(a);
    // No ambiguity from joining parts.
    expect(scopeOf("x", "ab", "c")).not.toBe(scopeOf("x", "a", "bc"));
  });

  it("scope parts may be numbers and fields (as hex)", () => {
    expect(scopeOf("agora/v1/post-epoch", "forum", 20763)).not.toBe(scopeOf("agora/v1/post-epoch", "forum", 20764));
    expect(scopeOf("x", 5n)).toBe(scopeOf("x", "0x" + "0".repeat(63) + "5"));
  });

  it("messageOf = toField(SHA-256(JCS([tag, app, value]))), independent of key order", () => {
    const v = { kind: "tip", story: "s", tipId: "urn:tipline:1" };
    const expected = toField(sha256(enc.encode(canonicalJson(["anon-membership/v1/message", "tipline/v1", v]))));
    expect(messageOf("tipline/v1", v)).toBe(expected);
    expect(messageOf("tipline/v1", { tipId: "urn:tipline:1", story: "s", kind: "tip" })).toBe(expected);
    expect(messageOf("tipline/v1", { ...v, story: "t" })).not.toBe(expected);
  });
});

describe("groups and secrets", () => {
  it("names a group <issuer DID>#<name> and refuses bad names", () => {
    expect(groupIdOf("did:key:z6MkAcme", "employees")).toBe(groupId);
    expect(() => groupIdOf("did:key:z6MkAcme", "")).toThrow();
    expect(() => groupIdOf("did:key:z6MkAcme", "a#b")).toThrow();
    expect(() => groupIdOf("not-a-did", "x")).toThrow();
  });

  it("groupFieldOf is f(utf8(groupId))", () => {
    expect(groupFieldOf(groupId)).toBe(toField(sha256(enc.encode(groupId))));
    expect(groupFieldOf("urn:agora:group:cascade-nursing-v1")).not.toBe(groupFieldOf(groupId));
  });

  it("memberSecret = toField(HMAC-SHA256(seed, JCS([tag, groupId]))), one per group", () => {
    const expected = toField(hmac(sha256, seed, enc.encode(canonicalJson(["anon-membership/v1/secret", groupId]))));
    expect(memberSecret(seed, groupId)).toBe(expected);
    expect(memberSecret(seed, groupId + "x")).not.toBe(expected);
  });

  it("deriveSecret is HMAC-SHA256 over the info string", () => {
    expect(deriveSecret(seed, "agora/v1/identity-secret")).toBe(toField(hmac(sha256, seed, enc.encode("agora/v1/identity-secret"))));
    expect(() => deriveSecret(new Uint8Array(8), "x")).toThrow(/16 bytes/);
  });
});

describe("membership codes", () => {
  const secret = memberSecret(seed, groupId);

  it("round-trips, in groups of 4 Crockford base32 characters", () => {
    const code = encodeMembershipCode(secret, groupId);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{1,4})+$/);
    expect(code.replace(/-/g, "").length).toBe(53); // 33 bytes
    expect(decodeMembershipCode(code, groupId)).toBe(secret);
  });

  it("accepts lower case, spaces, and the letters Crockford reads as digits", () => {
    const code = encodeMembershipCode(secret, groupId);
    const loose = code.toLowerCase().replace(/-/g, " ").replace(/0/g, "o").replace(/1/g, "l");
    expect(decodeMembershipCode(loose, groupId)).toBe(secret);
  });

  it("catches typos and a code for another group", () => {
    const code = encodeMembershipCode(secret, groupId);
    const i = code.search(/[2-9]/);
    const typo = code.slice(0, i) + (code[i] === "2" ? "3" : "2") + code.slice(i + 1);
    expect(decodeMembershipCode(typo, groupId)).toBeNull();
    expect(decodeMembershipCode(code, "did:key:z6MkOther#employees")).toBeNull();
    expect(decodeMembershipCode(code.slice(0, -2), groupId)).toBeNull();
    expect(decodeMembershipCode("not a code!", groupId)).toBeNull();
  });
});

describe("days", () => {
  it("counts days since 1970-01-01 UTC", () => {
    expect(dayOf(Date.parse("2026-11-06T23:59:59Z"))).toBe(20763);
    expect(dayFromIso("2026-11-06")).toBe(20763);
    expect(isoFromDay(20763)).toBe("2026-11-06");
    expect(() => dayFromIso("2026-13-01")).toThrow();
  });
});
