/** Loads the compiled policy from disk (Node). Browsers fetch policies/policy.wasm and call SettlePolicy.load. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SettlePolicy } from "./policy";

export const POLICY_WASM = join(import.meta.dirname, "..", "..", "policies", "policy.wasm");

export const loadPolicy = (): Promise<SettlePolicy> => SettlePolicy.load(readFileSync(POLICY_WASM));
