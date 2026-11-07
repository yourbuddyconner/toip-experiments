/**
 * The guard's interface to the loop (design §12.3). Types only: the loop module imports nothing else from the
 * guard, so it can't reach a key, the Settle party or the log (tests/boundary.test.ts checks).
 */

/** A decision, as the model and people see it: the outcome, reasons in plain words, and what it rests on. */
export interface DecisionView {
  outcome: "allow" | "escalate" | "deny";
  /** One sentence per reason, then one for the outcome. */
  sentences: string[];
  reasons: { code: string; dimension?: string; link?: number; approvable: boolean; detail?: string }[];
  actionHash: string;
  approver: string | null;
  /** Where the category came from (decision 5). */
  categorySource?: "worker's verified credential" | "the job as declared";
}

export type ToolResult<T> = { ok: true; value: T } | { ok: false; refused: DecisionView } | { ok: false; error: string };

export type HireResult =
  | { status: "hired"; payment: string; checkout: string; spend: string }
  | { status: "pending_approval"; request: string; decision: DecisionView }
  | { status: "refused"; decision: DecisionView }
  | { status: "error"; error: string };

export interface WorkerCard {
  name: string;
  did: string;
  kind: "human" | "agent";
  skills: string[];
  verified: string | null;
  rate?: string;
}

export interface WhoAmI {
  name: string;
  did: string;
  principal: string;
  passport: { model: string; operator: string } | null;
  mandate: string[];
  budgets: { dimension: string; limit: string; spent: string; left: string; period: string }[];
  wallet: string;
  paused: boolean;
  revoked: boolean;
}

export interface JobDraft {
  worker: string;
  title: string;
  description: string;
  category: string;
  maxPrice: string;
  release: "ci" | "principal" | "me";
  disputeWindowDays: number;
}

export interface DelegationDraft {
  subAgent: string;
  purpose: string;
  task: string;
  perPayment: string;
  perDay: string;
  total: string;
  categories: string[];
  validDays: number;
  funding: string;
}

export interface PaymentCard {
  payment: string;
  job?: string;
  with: string;
  title: string;
  amount: string;
  status: string;
  escrow?: string;
  attestations: string[];
}

/** Something that happened since the model last looked. Text from other parties sits under `untrusted`. */
export interface InboxEvent {
  type: string;
  at: string;
  [k: string]: unknown;
}

export interface GuardApi {
  whoami(): Promise<WhoAmI>;
  findWorkers(q: { skill: string }): Promise<WorkerCard[]>;
  offerJob(j: JobDraft): Promise<ToolResult<{ job: string }>>;
  inbox(o: { waitSeconds: number }): Promise<InboxEvent[]>;
  checkMandate(q: { quote: string }): Promise<ToolResult<DecisionView>>;
  hire(q: { quote: string; justification: string }): Promise<HireResult>;
  attest(a: { payment: string; claim: "complete" | "not-complete"; note?: string }): Promise<ToolResult<{}>>;
  dispute(d: { payment: string; reason: string }): Promise<ToolResult<{}>>;
  delegate(d: DelegationDraft): Promise<ToolResult<{ mandate: string; funded: string }>>;
  payments(): Promise<PaymentCard[]>;
  report(r: { text: string }): Promise<ToolResult<{}>>;
  // worker roles
  quote(q: { job: string; price: string; note?: string }): Promise<ToolResult<{ link: string }>>;
  decline(d: { job: string; reason: string }): Promise<ToolResult<{}>>;
  deliver(d: { job: string; note?: string }): Promise<ToolResult<{ commit?: string }>>;
  readFile(f: { path: string }): Promise<ToolResult<{ text: string }>>;
  writeFile(f: { path: string; text: string }): Promise<ToolResult<{ bytes: number }>>;
  runTests(): Promise<ToolResult<{ passed: boolean; output: string }>>;

  // the loop's bookkeeping: the guard logs it, the loop holds no handle on the log
  sessionStart(s: { model: string; systemHash: string; toolsHash: string; task: string }): Promise<void>;
  modelTurn(t: { model: string; requestHash: string; stopReason: string | null; usage: unknown; content: unknown }): Promise<void>;
  toolCall(t: { tool: string; input: unknown; id: string }): Promise<void>;
  toolResult(t: { tool: string; id: string; result: unknown; error: boolean }): Promise<void>;
  sessionEnd(s: { reason: string; summary?: string }): Promise<void>;
  /** "run", "paused" or "stopped": the principal's word, for the loop. */
  control(): "run" | "paused" | "stopped";
  /** Notices from the guard for the model (paused, revoked, approval granted), each delivered once. */
  notices(): string[];
}
