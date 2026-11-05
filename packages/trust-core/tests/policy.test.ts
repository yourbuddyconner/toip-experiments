import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Policies } from "../src/policy";

const wasm = readFileSync(new URL("./fixtures/policy.wasm", import.meta.url));

describe("Policies", () => {
  it("evaluates a named entrypoint of a compiled Rego bundle", async () => {
    const p = await Policies.load(wasm);
    expect(p.evaluate("fixture/decision", { role: "admin", kind: "add" })).toEqual({ allow: true, reasons: [] });
    expect(p.evaluate("fixture/decision", { role: "viewer", kind: "add" })).toEqual({ allow: false, reasons: ["viewer may not add"] });
  });

  it("refuses an entrypoint that is not in the bundle", async () => {
    const p = await Policies.load(wasm);
    expect(() => p.evaluate("nope/decision", {})).toThrow(/entrypoint/);
  });
});
