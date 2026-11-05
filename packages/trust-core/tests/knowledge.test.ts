import { expect, it } from "vitest";
import { DemoClock } from "../src/clock";
import { KnowledgeLog } from "../src/knowledge";

it("records facts with the demo time and filters by subject", () => {
  const clock = new DemoClock("2026-11-05T14:30:00Z");
  const k = new KnowledgeLog(clock);
  k.add({ about: "did:a", what: "name", value: "Alice", how: "join request" });
  k.add({ about: "did:b", what: "name", value: "Bob", how: "join request" });
  expect(k.about("did:a")).toEqual([{ about: "did:a", what: "name", value: "Alice", how: "join request", at: "2026-11-05T14:30:00.000Z" }]);
  expect(k.list()).toHaveLength(2);
});
