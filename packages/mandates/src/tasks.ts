/**
 * The mandates/* Trust Tasks (agents design §10.1, §9.3): one-way, signed, sealed in TSP Direct messages.
 * `serveMandateTasks` mounts handlers on a trust-core Endpoint; they check what they can and call back.
 */
import { ourSpec, verifyDocument, type Clock, type Endpoint, type StatusListDoc } from "@toip-tools/trust-core";
import { defaultEngine, type MandateEngine } from "./engine";
import { actionHash, jcsHash } from "./hash";
import type { Action, Approval, Decision, Mandate, Reason, StatusResolver } from "./types";

export type SpecPolicy = ReturnType<typeof ourSpec>;

/** Delegator → delegate: a new mandate, with the chain above it. */
export const MANDATE_ISSUE: SpecPolicy = ourSpec("mandates/issue");
/** Delegator → delegate: a revocation notice, with the newly signed list. */
export const MANDATE_REVOKED: SpecPolicy = ourSpec("mandates/revoked");
/** Delegate → approver. */
export const APPROVAL_REQUEST: SpecPolicy = ourSpec("mandates/approval/request");
/** Approver → delegate. */
export const APPROVAL_GRANT: SpecPolicy = ourSpec("mandates/approval/grant");
/** Approver → delegate. */
export const APPROVAL_DENY: SpecPolicy = ourSpec("mandates/approval/deny");

export interface IssuePayload {
  mandate: Mandate;
  chain: Mandate[];
}
export interface RevokedPayload {
  mandate: string;
  statusList: StatusListDoc;
}
export interface ApprovalRequestPayload {
  request: string;
  action: Action;
  actionHash: string;
  chain: Mandate[];
  decision: Decision;
  /** The delegate's words (a model's, for an agent). Show them as such. */
  justification?: string;
  expiresAt: string;
}
export interface ApprovalGrantPayload {
  request: string;
  approval: Approval;
}
export interface ApprovalDenyPayload {
  request: string;
  reason?: string;
}

type Sender = { sender: string };
type Maybe = void | Promise<void>;

export interface MandateTaskHandlers {
  clock: Clock;
  /** Default: the bundled policy. */
  engine?: MandateEngine;
  /** With a resolver, an issued mandate's status lists are checked too. */
  status?: StatusResolver;
  /** A mandate for this endpoint whose whole chain verifies and narrows. */
  onIssue?(m: IssuePayload & Sender): Maybe;
  /** A list signed by the sender. Check your mandate against it with isRevoked. */
  onRevoked?(n: RevokedPayload & Sender): Maybe;
  /** A request from the leaf of a chain that verifies, with an action matching its hash. */
  onApprovalRequest?(r: ApprovalRequestPayload & Sender): Maybe;
  /** An approval signed by the sender. Pass it to decide, which checks the rest. */
  onApprovalGrant?(g: ApprovalGrantPayload & Sender): Maybe;
  onApprovalDeny?(d: ApprovalDenyPayload & Sender): Maybe;
  /** A message that failed its checks, and why. */
  onRejected?(r: { type: string; sender: string; reasons: Reason[] }): Maybe;
}

const bad = (code: string, detail: string): Reason => ({ code, detail, approvable: false });

/** Mounts a handler for each callback given. A project mounts what its role needs. */
export function serveMandateTasks(ep: Endpoint, h: MandateTaskHandlers): void {
  const engine = () => (h.engine ? Promise.resolve(h.engine) : defaultEngine());
  const reject = async (type: string, sender: string, reasons: Reason[]) => {
    await h.onRejected?.({ type, sender, reasons });
  };

  if (h.onIssue) {
    const on = h.onIssue;
    ep.handle<IssuePayload, void>(MANDATE_ISSUE, async (doc, { sender }) => {
      const { mandate, chain } = doc.payload ?? ({} as IssuePayload);
      const full = [...(Array.isArray(chain) ? chain : []), mandate];
      const reasons: Reason[] = [];
      if (mandate?.issuer !== sender) reasons.push(bad("chain.brokenLink", "the mandate wasn't issued by its sender"));
      else reasons.push(...(await (await engine()).checkChain({ chain: full, presenter: ep.vid, clock: h.clock, ...(h.status ? { status: h.status } : {}) })));
      if (reasons.length) return void (await reject(MANDATE_ISSUE.typeUri, sender, reasons));
      await on({ mandate, chain, sender });
    });
  }

  if (h.onRevoked) {
    const on = h.onRevoked;
    ep.handle<RevokedPayload, void>(MANDATE_REVOKED, async (doc, { sender }) => {
      const p = doc.payload;
      const list = p?.statusList;
      const sig = list ? await verifyDocument(list, h.clock).catch(() => ({ valid: false })) : { valid: false };
      if (!sig.valid || list.issuer !== sender) return void (await reject(MANDATE_REVOKED.typeUri, sender, [bad("status.wrongIssuer", "the list isn't signed by its sender")]));
      await on({ mandate: p.mandate, statusList: list, sender });
    });
  }

  if (h.onApprovalRequest) {
    const on = h.onApprovalRequest;
    ep.handle<ApprovalRequestPayload, void>(APPROVAL_REQUEST, async (doc, { sender }) => {
      const p = doc.payload;
      const reasons: Reason[] = [];
      let hash = "";
      try {
        hash = actionHash(p.action);
      } catch {
        hash = "";
      }
      if (!p || hash !== p.actionHash) reasons.push(bad("approval.wrongAction", "the action doesn't match its hash"));
      else reasons.push(...(await (await engine()).checkChain({ chain: p.chain, presenter: sender, clock: h.clock })));
      if (reasons.length) return void (await reject(APPROVAL_REQUEST.typeUri, sender, reasons));
      await on({ ...p, sender });
    });
  }

  if (h.onApprovalGrant) {
    const on = h.onApprovalGrant;
    ep.handle<ApprovalGrantPayload, void>(APPROVAL_GRANT, async (doc, { sender }) => {
      const p = doc.payload;
      const a = p?.approval;
      const sig = a ? await verifyDocument(a, h.clock).catch(() => ({ valid: false })) : { valid: false };
      let ok = sig.valid && a.issuer === sender;
      try {
        ok = ok && jcsHash(a.action) === a.actionHash;
      } catch {
        ok = false;
      }
      if (!ok) return void (await reject(APPROVAL_GRANT.typeUri, sender, [bad("approval.invalid", "the approval isn't signed by its sender over its action")]));
      await on({ request: p.request, approval: a, sender });
    });
  }

  if (h.onApprovalDeny) {
    const on = h.onApprovalDeny;
    ep.handle<ApprovalDenyPayload, void>(APPROVAL_DENY, async (doc, { sender }) => {
      const p = doc.payload;
      await on({ request: p?.request, ...(p?.reason !== undefined ? { reason: p.reason } : {}), sender });
    });
  }
}

export const sendMandate = (ep: Endpoint, to: string, p: IssuePayload) => ep.notify(to, MANDATE_ISSUE, p);
export const notifyRevoked = (ep: Endpoint, to: string, p: RevokedPayload) => ep.notify(to, MANDATE_REVOKED, p);
export const requestApproval = (ep: Endpoint, to: string, p: ApprovalRequestPayload) => ep.notify(to, APPROVAL_REQUEST, p);
export const grantApproval = (ep: Endpoint, to: string, p: ApprovalGrantPayload) => ep.notify(to, APPROVAL_GRANT, p);
export const denyApproval = (ep: Endpoint, to: string, p: ApprovalDenyPayload) => ep.notify(to, APPROVAL_DENY, p);
