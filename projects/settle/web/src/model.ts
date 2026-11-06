/** What the pages show about a payment, derived from the party's own view of it. */
import { useEffect, useState, useSyncExternalStore } from "react";
import { STATE } from "../../src/chain/escrow";
import type { PaymentState } from "../../src/agents/base";
import type { Session } from "./session";

export const money = (u: string | bigint | number | undefined) => {
  const n = Number(BigInt(u ?? 0)) / 1e6;
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
export const toUnits = (s: string): bigint | null => {
  const m = /^\s*(\d{1,9})(?:\.(\d{1,6}))?\s*$/.exec(s);
  if (!m) return null;
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
};
export const day = (unixSeconds: number) => new Date(unixSeconds * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
export const when = (iso?: string) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
export const short = (s?: string) => (s ? `${s.slice(0, 6)}…${s.slice(-4)}` : "");

export type Tone = "held" | "done" | "problem" | "quiet";
export interface Status {
  label: string;
  tone: Tone;
}

export function statusOf(p: PaymentState): Status {
  if (p.chain?.state === STATE.reclaimed) return { label: "Reclaimed by payer", tone: "quiet" };
  if (p.settled) {
    if (p.settled.payeeUnits === "0") return { label: "Refunded", tone: "quiet" };
    if (p.terms && p.settled.payeeUnits !== p.terms.amount.units) return { label: "Split by arbiter", tone: "done" };
    return { label: "Released", tone: "done" };
  }
  if (p.cancelled) return { label: "Cancelled", tone: "quiet" };
  if (p.disputes.length) return { label: p.ruling ? "Ruled" : "Disputed", tone: "problem" };
  if (p.escrow) {
    if (p.role === "attester") return { label: p.attestations.length ? "You confirmed" : "Needs your confirmation", tone: "held" };
    return { label: "In escrow", tone: "held" };
  }
  if (p.terms) return { label: "Agreeing terms", tone: "quiet" };
  return { label: p.role === "payee" ? "Invoice sent" : "Invoice received", tone: "quiet" };
}

/** Whether this party is the one who should act now, and what the action is. */
export function needsYou(p: PaymentState, me: string): string | null {
  if (p.settled || p.cancelled || !p.terms || !p.escrow || p.chain?.state === STATE.reclaimed) return null;
  const attester = p.terms.conditions.attester === me;
  if (attester && !p.attestations.some((a) => a.issuer === me)) return p.role === "attester" ? "Confirm the work for someone else" : "Confirm the work is done";
  if (p.role === "payee" && p.disputes.length && !p.ruling) return "A customer reported a problem";
  if (p.chain && (p.chain.payeeOwed !== "0" || p.chain.payerOwed !== "0")) return "Collect money the escrow owes you";
  return null;
}

/** Re-renders when the session changes. */
export function useSession(s: Session): number {
  return useSyncExternalStore(s.subscribe, s.getVersion);
}

// ---------------------------------------------------------------- routing

const listeners = new Set<() => void>();
window.addEventListener("popstate", () => listeners.forEach((l) => l()));

export function navigate(to: string): void {
  if (to === location.pathname) return;
  history.pushState(null, "", to);
  listeners.forEach((l) => l());
  window.scrollTo(0, 0);
}

export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const l = () => setPath(location.pathname);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return path;
}

/** A link to Solana Explorer for this network's chain, or null on the platform's own local cluster (no explorer can see it). */
export function explorer(config: { cluster: string; rpcUrl: string }, kind: "tx" | "address", id: string): string | null {
  if (config.cluster === "local") return null;
  const q = ["devnet", "testnet"].includes(config.cluster)
    ? `?cluster=${config.cluster}`
    : config.cluster === "mainnet" || config.cluster === "mainnet-beta"
      ? ""
      : `?cluster=custom&customUrl=${encodeURIComponent(config.rpcUrl)}`;
  return `https://explorer.solana.com/${kind}/${id}${q}`;
}
