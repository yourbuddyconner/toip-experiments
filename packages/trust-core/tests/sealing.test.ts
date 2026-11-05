import { describe, expect, it } from "vitest";
import { identityFromSeed, seedFrom } from "../src/identity";
import { openItem, resealText, sealItem } from "../src/sealing";

const alice = identityFromSeed(seedFrom("s/alice"));
const bob = identityFromSeed(seedFrom("s/bob"));
const carol = identityFromSeed(seedFrom("s/carol"));
const reader = (id: typeof alice) => ({ did: id.did, encryptionPublic: id.encryptionPublic });

describe("private item sealing", () => {
  it("opens for each reader and not for anyone else", async () => {
    const { sealed } = await sealItem("Carol's birthday present", [reader(alice), reader(bob)]);
    expect(JSON.stringify(sealed)).not.toContain("birthday");
    expect((await openItem(sealed, alice))?.text).toBe("Carol's birthday present");
    expect((await openItem(sealed, bob))?.text).toBe("Carol's birthday present");
    expect(await openItem(sealed, carol)).toBeNull();
  });

  it("returns null, not an exception, for a corrupted wrapped key", async () => {
    const { sealed } = await sealItem("secret", [reader(alice)]);
    const bad = { ...sealed, keys: sealed.keys.map((k) => ({ ...k, wrapped: k.wrapped.slice(0, -4) + "AAAA" })) };
    expect(await openItem(bad, alice)).toBeNull();
  });

  it("re-seals edited text under the same item key", async () => {
    const { key, sealed } = await sealItem("v1", [reader(alice), reader(bob)]);
    const edited = resealText("v2", key, sealed);
    expect((await openItem(edited, bob))?.text).toBe("v2");
    expect(await openItem(edited, carol)).toBeNull();
  });
});
