import { describe, expect, it } from "vitest";
import { x25519 } from "@noble/curves/ed25519.js";
import { DemoClock } from "../src/clock";
import { identityFromSeed, resolveDidKey, seedFrom } from "../src/identity";

describe("identity", () => {
  it("is deterministic from a seed and is an Ed25519 did:key", () => {
    const a = identityFromSeed(seedFrom("community-rides/alice"));
    const b = identityFromSeed(seedFrom("community-rides/alice"));
    expect(a.did).toBe(b.did);
    expect(a.did.startsWith("did:key:z6Mk")).toBe(true);
  });

  it("is a bare DID that matches its signer", () => {
    const id = identityFromSeed(seedFrom("z"));
    expect(id.did).not.toContain("#");
    expect(id.signer.did).toBe(id.did);
  });

  it("resolves its own did:key back to its public keys", () => {
    const id = identityFromSeed(seedFrom("x"));
    const keys = resolveDidKey(id.did);
    expect(keys.signingKey).toEqual(id.signingPublic);
    expect(keys.encryptionKey).toEqual(id.encryptionPublic);
  });

  it("derives a consistent X25519 key pair", () => {
    const id = identityFromSeed(seedFrom("y"));
    expect(x25519.getPublicKey(id.encryptionSecret)).toEqual(id.encryptionPublic);
  });

  it("refuses anything that is not an Ed25519 did:key", () => {
    expect(() => resolveDidKey("did:web:example.com")).toThrow("not an Ed25519 did:key");
  });
});

describe("DemoClock", () => {
  it("advances and notifies", () => {
    const c = new DemoClock("2026-11-05T14:30:00Z");
    let calls = 0;
    c.subscribe(() => calls++);
    c.advance(60_000);
    expect(c.iso()).toBe("2026-11-05T14:31:00.000Z");
    expect(calls).toBe(1);
  });
});
