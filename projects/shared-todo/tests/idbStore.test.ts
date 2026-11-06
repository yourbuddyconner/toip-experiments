import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { IndexedDBStore } from "../src/web/idbStore";

it("stores, lists by prefix, and deletes values", async () => {
  const s = await IndexedDBStore.open("test-" + Math.random());
  await s.put("list/a", { name: "A", n: new Uint8Array([1, 2]) });
  await s.put("list/b", { name: "B" });
  await s.put("profile", { name: "Alice" });
  expect(await s.get("list/a")).toEqual({ name: "A", n: new Uint8Array([1, 2]) });
  expect((await s.keys("list/")).sort()).toEqual(["list/a", "list/b"]);
  await s.delete("list/a");
  expect(await s.get("list/a")).toBeUndefined();
});
