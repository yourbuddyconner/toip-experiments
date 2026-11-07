/** Shared constants and small helpers. */
import { ourSpec } from "@zk-toip/trust-core";

export const HARNESS = "zk-toip/agents@0.1.0";

/** Default ports, away from Settle's 4300–4302 and the rest of the repository. */
export const DEFAULT_PORTS = { app: 4330, hub: 4331, settle: 4332, relay: 4333, rpc: 4334 } as const;

export const USDC = (n: number): bigint => BigInt(Math.round(n * 1_000_000));
export const units = (n: number): string => USDC(n).toString();
export const usdc = (u: string | bigint | number): string => `${(Number(BigInt(u)) / 1e6).toFixed(2)} USDC`;

/** Parses "20", "20.5" or "20.50 USDC" into units. Returns null when it isn't an amount. */
export function parseUsdc(s: string): bigint | null {
  const m = /^\s*(\d{1,9})(?:\.(\d{1,6}))?\s*(?:usdc)?\s*$/i.exec(String(s));
  if (!m) return null;
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
}

/** The full Trust Task URI for a short name, e.g. "settle/checkout/start". */
export const taskUri = (name: string): string => ourSpec(name).typeUri;

/** Plain phrases for mandate dimensions, for `explain`. */
export const DIMENSION_LABELS: Record<string, string> = {
  spendPerTx: "per payment",
  spendPerDay: "per day",
  spendTotal: "in total",
  categories: "categories of work",
  attesters: "who may confirm work",
  arbiters: "arbiters",
  asset: "tokens",
  actions: "kinds of action",
  tasks: "Trust Tasks",
  minWindow: "dispute window",
  priceMin: "the lowest price",
  priceMax: "the highest price",
};

export const SPEND_ATTRS = new Set(["spend", "price"]);

/** How long a request for approval waits before it lapses (§9.3). */
export const APPROVAL_REQUEST_TTL_SECONDS = 30 * 60;
