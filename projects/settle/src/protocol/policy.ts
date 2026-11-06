import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Policies } from "@zk-toip/trust-core";

export const POLICY_WASM = join(import.meta.dirname, "..", "..", "policies", "policy.wasm");
export const ENTRYPOINT = "settle/attested_completion/decision";

export interface PolicyInput {
  role: "payer" | "payee" | "arbiter";
  now: number;
  proposal: { payeeUnits: string };
  terms: { amountUnits: string; attester: string; disputeWindowSeconds: number };
  attestations: { issuer: string; claim: string; atSeconds: number; verified: boolean }[];
  disputes: { issuer: string }[];
  ruling: { payeeUnits: string } | null;
  payeeCancels?: boolean;
}

export interface PolicyDecision {
  sign: boolean;
  reasons: string[];
}

export class SettlePolicy {
  private constructor(private readonly p: Policies) {}

  static async load(wasm: BufferSource = readFileSync(POLICY_WASM)): Promise<SettlePolicy> {
    return new SettlePolicy(await Policies.load(wasm));
  }

  decide(input: PolicyInput): PolicyDecision {
    const d = this.p.evaluate<{ sign: boolean; reasons: string[] }>(ENTRYPOINT, input);
    return { sign: d.sign, reasons: [...(d.reasons ?? [])].sort() };
  }
}
