import { expect, it } from "vitest";
import { initHashing, poseidon2 } from "../src/hash";

// Its own file, so the module's state is fresh.
it("refuses to hash before initHashing, and works after", async () => {
  expect(() => poseidon2([1n])).toThrow(/initHashing/);
  await initHashing();
  await initHashing(); // idempotent
  expect(typeof poseidon2([1n])).toBe("bigint");
});
