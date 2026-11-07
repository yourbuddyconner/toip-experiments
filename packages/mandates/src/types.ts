import type { Credential, StatusListDoc } from "@zk-toip/trust-core";

/** A decimal integer string, at most 2^53 − 1. */
export type Units = string;
export type Period = "P1D" | "P7D" | "P30D" | "total";
export const PERIODS: readonly Period[] = ["P1D", "P7D", "P30D", "total"];

export type Op = "anyOf" | "noneOf" | "within" | "is" | "max" | "min" | "budget";
export const OPS: readonly Op[] = ["anyOf", "noneOf", "within", "is", "max", "min", "budget"];

export type Constraint = { attr: string; when?: string[] } & (
  | { anyOf: string[] }
  | { noneOf: string[] }
  | { within: string[] }
  | { is: string | number | boolean }
  | { max: Units | number }
  | { min: Units | number }
  | { budget: Units; period: Period }
);

export interface StatusEntry {
  type: "BitstringStatusListEntry";
  statusListIndex: number;
  statusListCredential: string;
}

export interface MandateSubject {
  /** The delegate's DID. */
  id: string;
  mandateVersion: 1;
  /** Which action vocabulary: "settle/1", "capture/1", or one added with registerProfile. */
  profile: string;
  /** For people only. Never evaluated. */
  purpose?: string;
  parent: { id: string; hash: string } | null;
  constraints: Record<string, Constraint>;
  delegation: { maxDepth: number };
  escalation?: { approvable: string[]; approvalTtlSeconds: number };
  revocation: { maxAgeSeconds: number };
}

export type Mandate = Credential & {
  type: ["VerifiableCredential", "Mandate"];
  credentialSubject: MandateSubject;
  validUntil: string;
  credentialStatus: StatusEntry;
};

export type AttrValue = string | number | boolean | string[];

export interface Action {
  type: string;
  profile: string;
  id: string;
  /** The DID that acts: the leaf mandate's subject. */
  actor: string;
  at: string;
  attrs: Record<string, AttrValue> & { spend: Units };
}

export interface Reason {
  code: string;
  /** Which link, numbered from 0 at the root. */
  link?: number;
  dimension?: string;
  op?: string;
  attr?: string;
  limit?: unknown;
  value?: unknown;
  /** Budgets: what was already spent in the period. */
  spent?: Units;
  period?: Period;
  /** requirement.failed: which requirement. */
  requirement?: string;
  /** Structural reasons: what exactly was wrong, for people. */
  detail?: string;
  approvable: boolean;
}

export type Outcome = "allow" | "escalate" | "deny";

export interface Decision {
  outcome: Outcome;
  reasons: Reason[];
  /** For "escalate": who can approve. */
  approver: string | null;
  actionHash: string;
  /** Mandate ids, root first. */
  chain: string[];
  /** Issuer and subject of each link, root first, so a decision can be explained on its own. */
  parties: { issuer: string; subject: string }[];
  policy: { id: string; hash: string };
  at: string;
}

export interface Approval {
  type: "mandates/approval";
  version: 1;
  id: string;
  issuer: string;
  subject: string;
  chain: string[];
  action: Action;
  actionHash: string;
  validFrom: string;
  validUntil: string;
  uses: 1;
  proof?: unknown;
}

export interface SpendStatement {
  mandate: string;
  spent: Partial<Record<Period, Units>>;
}

export interface Presentation {
  type: "mandates/presentation";
  issuer: string;
  audience: string;
  action: Action;
  actionHash: string;
  chain: Mandate[];
  approvals: Approval[];
  passport?: Credential;
  rootCredentials?: Credential[];
  spend?: SpendStatement;
  trailRef?: { i: string; s: number; d: string };
  statusLists?: StatusListDoc[];
  at: string;
  proof?: unknown;
}

export interface Requirements {
  /** Default 3. */
  maxLinks?: number;
  /** "<type>@<issuer DID>" of credentials the root must hold, e.g. "VerifiedBusiness@did:key:…". */
  rootMustHold?: string[];
  /** Default "optional" (see the README). */
  passport?: "required" | "optional";
  passportIssuerMustBeRoot?: boolean;
  /** Default 3600. */
  maxStatusAgeSeconds?: number;
}

export interface StatusResolver {
  get(listId: string): Promise<StatusListDoc | null>;
}

/** An action vocabulary. `rootRequires` lists what a root mandate must constrain: an attribute name, or "attr:op". */
export interface Profile {
  id: string;
  actions: Record<string, { required: string[] }>;
  rootRequires: string[];
}
