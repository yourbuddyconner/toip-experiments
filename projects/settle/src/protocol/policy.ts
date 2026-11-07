/** The Settle payment policy, evaluated on each signer's own device. Browser-safe: pass the wasm bytes. */
import { Policies } from "@toip-tools/trust-core";

export const ENTRYPOINT = "settle/attested_completion/decision";

export interface PolicyInput {
  role: "payer" | "payee" | "arbiter";
  now: number;
  proposal: { payeeUnits: string };
  terms: { amountUnits: string; attester: string; disputeWindowSeconds: number };
  /** The attester's latest verified word, and when this party received it (chain time). */
  completion: { claim: string; atSeconds: number } | null;
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

  static async load(wasm: BufferSource): Promise<SettlePolicy> {
    return new SettlePolicy(await Policies.load(wasm));
  }

  decide(input: PolicyInput): PolicyDecision {
    const d = this.p.evaluate<{ sign: boolean; reasons: string[] }>(ENTRYPOINT, input);
    return { sign: d.sign, reasons: [...(d.reasons ?? [])].sort() };
  }
}
