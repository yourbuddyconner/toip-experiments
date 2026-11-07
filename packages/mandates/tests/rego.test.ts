import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { MandateEngine, POLICY_ID } from "../src/index";

const policyDir = fileURLToPath(new URL("../policy/", import.meta.url));
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const hasOpa = spawnSync("opa", ["version"]).status === 0;

describe("the mandates/check/1 policy", () => {
  it("the compiled wasm's hash matches the one recorded", async () => {
    const wasm = readFileSync(`${policyDir}policy.wasm`);
    const recorded = readFileSync(`${policyDir}policy.sha256`, "utf8").trim();
    expect(`sha256:${hex(sha256(wasm))}`).toBe(recorded);
    const engine = await MandateEngine.load();
    expect(engine.policyHash).toBe(recorded);
    expect(POLICY_ID).toBe("mandates/check/1");
    const fromBytes = await MandateEngine.load(wasm);
    expect(fromBytes.policyHash).toBe(recorded);
  });

  it("refuses a policy bundle that lacks the entrypoints", async () => {
    const fixture = readFileSync(new URL("../../trust-core/tests/fixtures/policy.wasm", import.meta.url));
    await expect(MandateEngine.load(fixture)).rejects.toThrow(/entrypoint/);
  });

  it.runIf(hasOpa)("passes the policy's own opa test cases", () => {
    const r = spawnSync("opa", ["test", policyDir], { encoding: "utf8" });
    expect(r.stdout + r.stderr).toMatch(/PASS/);
    expect(r.status).toBe(0);
  });
});
