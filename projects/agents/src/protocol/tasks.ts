/** The agents/* Trust Tasks (design §10.1). All one-way, signed, sealed in TSP Direct messages. */
import { ourSpec, type Credential } from "@toip-tools/trust-core";
import type { Presentation } from "@toip-tools/mandates";
import type { PaymentLink } from "@toip-tools/settle/src/agents/party";

export const JOB_OFFER = ourSpec("agents/job/offer");
export const JOB_QUOTE = ourSpec("agents/job/quote");
export const JOB_DECLINE = ourSpec("agents/job/decline");
export const JOB_REFUSED = ourSpec("agents/job/refused");
export const JOB_WATCH = ourSpec("agents/job/watch");
export const JOB_DELIVER = ourSpec("agents/job/deliver");
export const CONTROL = ourSpec("agents/control");
export const REPORT = ourSpec("agents/report");
/** A delegator or principal gives an agent work in words (our addition: the design passes the task as the first user message). */
export const TASK = ourSpec("agents/task");

export type Release = { kind: "attester"; attester: string } | { kind: "payer" };

export interface JobOffer {
  job: string;
  title: string;
  description: string;
  category: string;
  /** The most the hirer offers, in units. */
  maxUnits: string;
  release: Release;
  disputeWindowDays: number;
  deliverable: "git" | "note";
  /** For code jobs: where to push the work (a git URL or a local path in the demo). */
  repo?: string;
  deadline: string;
  hirerName: string;
  passport: Credential;
  /** A presentation of the agents/job/offer action. */
  presentation?: Presentation;
}

export interface JobQuote {
  job: string;
  link: PaymentLink;
  note?: string;
}

export interface JobDecline {
  job: string;
  reason: string;
}

export interface JobRefused {
  job: string;
  link?: string;
  reasons: string[];
}

export interface CiCheck {
  kind: "ci";
  repo: string;
  command: "node --test";
  timeoutSeconds: number;
}

export interface JobWatch {
  job: string;
  termsHash: string;
  check: CiCheck;
}

export type Deliverable = { kind: "git"; repo: string; commit: string } | { kind: "note"; text: string };

export interface JobDeliver {
  job: string;
  termsHash: string;
  deliverable: Deliverable;
}

export type ControlOp = "pause" | "resume" | "stop" | "disclose" | "revoke";
export interface Control {
  op: ControlOp;
  /** For "revoke": a mandate this agent issued. */
  mandate?: string;
}

export interface Report {
  text: string;
  refs?: Record<string, unknown>;
}

export interface TaskMessage {
  text: string;
}
