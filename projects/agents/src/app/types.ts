/** What the app's API returns. Shared by the server and the web pages. Types only. */

export interface MandateView {
  id: string;
  issuer: string;
  issuerName: string;
  subject: string;
  subjectName: string;
  lines: string[];
  revoked: boolean;
  validUntil: string;
  /** For a sub-mandate: its parent and what narrowed. */
  parent?: string;
  narrowing?: { dimension: string; parent: string; child: string }[];
}

export interface BudgetView {
  dimension: string;
  period: string;
  limit: string;
  spent: string;
  left: string;
  /** 0 to 1, for a meter; null when it isn't a running budget. */
  used: number | null;
}

export interface AgentView {
  name: string;
  did: string;
  role: "hirer" | "worker";
  model: string;
  operator: string;
  wallet: string;
  paused: boolean;
  revoked: boolean;
  running: boolean;
  mandates: string[];
  budgets: BudgetView[];
  trail: { aid: string; entries: number };
  /** The principal may control this agent (pause, resume, review). */
  controllable: boolean;
}

export interface ApprovalView {
  request: string;
  from: string;
  fromName: string;
  state: "waiting" | "approved" | "denied";
  payee: { name: string; did: string; credentials: string[] };
  price: string;
  fee: string;
  spend: string;
  category: string;
  attester: string;
  arbiter: string;
  disputeWindowDays: number;
  purpose: string;
  sentences: string[];
  justification: string;
  expiresAt: string;
  actionHash: string;
}

export interface ConfirmView {
  payment: string;
  purpose: string;
  payee: string;
  payer: string;
  amount: string;
}

export interface AuditEntryView {
  s: number;
  kind: string;
  dt: string;
  receipts: string[];
  status: string;
  summary: string;
  tone: "normal" | "allow" | "refuse" | "escalate" | "money";
}

export interface AuditViewDto {
  agent: string;
  name: string;
  at: string;
  ok: boolean;
  banner: string;
  problems: string[];
  entries: AuditEntryView[];
}

export interface ConsoleState {
  principal: { name: string; did: string; wallet: string };
  setup: { mandateIssued: boolean; funded: boolean; tasked: boolean };
  mode: "scripted" | "live";
  agents: AgentView[];
  mandates: MandateView[];
  approvals: ApprovalView[];
  confirm: ConfirmView[];
  reports: { name: string; text: string; at: string }[];
  audits: AuditViewDto[];
  quickfixQuote: string | null;
  injection: { status: string; sentences: string[]; approvalRequested: boolean } | null;
}

export interface CourierOfferView {
  job: string;
  fromName: string;
  title: string;
  description: string;
  category: string;
  maxPrice: string;
  confirmedBy: string;
  verified: boolean;
  chain: string[];
  sentences: string[];
  quoted: string | null;
  paid: string | null;
  delivered: string | null;
  settled: string | null;
  behind: string | null;
}

export interface CourierState {
  name: string;
  did: string;
  wallet: string;
  offers: CourierOfferView[];
  refusals: { fromName: string; title: string; reasons: string[]; at: string }[];
}
