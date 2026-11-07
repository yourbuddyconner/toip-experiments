/** Spend state, kept by the delegate (the guard): what each mandate has spent, and which approvals were used. */
import { isUnits } from "./shape";
import { PERIODS, type Mandate, type Period, type Reason, type Units } from "./types";

const DAY = 86_400_000;
const WINDOW: Record<Period, number> = { P1D: DAY, P7D: 7 * DAY, P30D: 30 * DAY, total: Infinity };

export interface SpendEntry {
  mandate: string;
  actionId: string;
  spend: Units;
  /** Milliseconds since the epoch, on the delegate's clock. */
  at: number;
  /** Units given back by refunds. */
  refunded?: Units;
}

export interface SpendLedgerState {
  entries: SpendEntry[];
  usedApprovals: string[];
}

export class SpendLedger {
  private readonly entries = new Map<string, SpendEntry>();
  private readonly used = new Set<string>();

  constructor(saved?: SpendLedgerState) {
    for (const e of saved?.entries ?? []) this.entries.set(e.actionId, { ...e });
    for (const id of saved?.usedApprovals ?? []) this.used.add(id);
  }

  /** Spent under `mandate` in each period: rolling windows ending at `now` (ms); `total` is everything. */
  spent(mandate: string, now: number): Record<Period, Units> {
    const sums = Object.fromEntries(PERIODS.map((p) => [p, 0n])) as Record<Period, bigint>;
    for (const e of this.entries.values()) {
      if (e.mandate !== mandate || e.at > now) continue;
      const net = BigInt(e.spend) - BigInt(e.refunded ?? "0");
      for (const p of PERIODS) if (e.at > now - WINDOW[p]) sums[p] += net;
    }
    return Object.fromEntries(PERIODS.map((p) => [p, String(sums[p])])) as Record<Period, Units>;
  }

  /** Counts `spend` against `mandate` from `at`. Call it when the action is allowed, before anything moves. */
  reserve(mandate: string, actionId: string, spend: Units, at: number): void {
    if (!isUnits(spend)) throw new Error(`spend must be decimal integer units, not ${spend}`);
    if (this.entries.has(actionId)) throw new Error(`action ${actionId} is already reserved`);
    this.entries.set(actionId, { mandate, actionId, spend, at });
  }

  /**
   * Checks the mandate's own budgets and reserves in one synchronous step, so two actions racing for
   * the last of a budget can't both fit. Returns the budgets it would exceed (and reserves nothing), or [].
   * With `actionType`, budgets scoped by `when` to other types are skipped.
   */
  tryReserve(mandate: Mandate, actionId: string, spend: Units, at: number, actionType?: string): Reason[] {
    if (!isUnits(spend)) throw new Error(`spend must be decimal integer units, not ${spend}`);
    const spent = this.spent(mandate.id, at);
    const over: Reason[] = [];
    for (const [dimension, c] of Object.entries(mandate.credentialSubject.constraints)) {
      if (!("budget" in c)) continue;
      if (actionType && c.when && !c.when.includes(actionType)) continue;
      if (BigInt(spent[c.period]) + BigInt(spend) > BigInt(c.budget)) {
        over.push({ code: "budget.exceeded", dimension, op: "budget", attr: c.attr, limit: c.budget, value: spend, spent: spent[c.period], period: c.period, approvable: false });
      }
    }
    if (over.length === 0) this.reserve(mandate.id, actionId, spend, at);
    return over;
  }

  /** Undoes a reservation: the action failed before anything left the wallet. */
  release(actionId: string): void {
    this.entries.delete(actionId);
  }

  /** A refund gives budget back (agents decision 4): all of it, or `units` of it. */
  refund(actionId: string, units?: Units): void {
    const e = this.entries.get(actionId);
    if (!e) throw new Error(`no reservation for ${actionId}`);
    const already = BigInt(e.refunded ?? "0");
    const back = units === undefined ? BigInt(e.spend) - already : BigInt(units);
    if (units !== undefined && !isUnits(units)) throw new Error(`units must be decimal integer units, not ${units}`);
    if (already + back > BigInt(e.spend)) throw new Error(`refund of ${units} is more than what is left of ${e.spend}`);
    e.refunded = String(already + back);
  }

  markApprovalUsed(id: string): void {
    this.used.add(id);
  }

  approvalUsed(id: string): boolean {
    return this.used.has(id);
  }

  save(): SpendLedgerState {
    return { entries: [...this.entries.values()].map((e) => ({ ...e })), usedApprovals: [...this.used] };
  }
}
