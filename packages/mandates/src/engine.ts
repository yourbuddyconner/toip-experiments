/**
 * Verifying a chain and deciding an action (agents design §8). TypeScript checks what is cryptographic
 * and structural (steps 1 to 8, approvals' signatures) and turns it into facts; the Rego policy
 * mandates/check/1 decides narrowing, the action against every link, approvals, requirements and the outcome.
 */
import { Policies, isRevokedIn, verifyDocument, type Clock, type Credential, type StatusListDoc } from "@zk-toip/trust-core";
import { verifyApproval } from "./approval";
import { actionHash, mandateHash, sha256Tag } from "./hash";
import { checkAction, checkMandate, checkRoot, MAX_LINKS } from "./shape";
import { getProfile } from "./profiles";
import type { Action, Approval, Constraint, Decision, Mandate, Outcome, Period, Presentation, Reason, Requirements, SpendStatement, StatusResolver, Units } from "./types";

export const POLICY_ID = "mandates/check/1";
const DECISION = "mandates/check/decision";
const NARROWING = "mandates/check/narrowing";
/** Validity is checked on each verifier's clock, with five minutes' skew (§4.6). */
export const SKEW_MS = 5 * 60_000;

export const DEFAULT_REQUIREMENTS = { maxLinks: 3, maxStatusAgeSeconds: 3600, passport: "optional", rootMustHold: [] as string[] } as const;

/** One link as the policy sees it: verified facts, no signatures. Times in seconds. */
export interface LinkFacts {
  id: string;
  issuer: string;
  subject: string;
  profile: string;
  validFromS: number;
  validUntilS: number;
  constraints: Record<string, Constraint>;
  delegation: { maxDepth: number };
  escalation?: { approvable: string[]; approvalTtlSeconds: number };
  revocation: { maxAgeSeconds: number };
}

/** The policy's input (§8.5). Logged with a decision, it lets anyone re-run it with `evaluate`. */
export interface PolicyInput {
  nowS: number;
  action: Pick<Action, "type" | "attrs"> & Partial<Action>;
  actionHash: string;
  chain: LinkFacts[];
  /** Reasons from steps 1 to 8, and presentation problems. */
  structural: Reason[];
  /** Problems with approvals; those approvals are left out of `approvals`. */
  approvalProblems: Reason[];
  state: { spent: Record<string, Partial<Record<Period, Units>>> };
  /** Approvals whose signatures and bindings TypeScript checked. */
  approvals: { id: string; approverLink: number; actionHash: string; validUntilS: number; used: boolean }[];
  requirements: Omit<Requirements, "maxStatusAgeSeconds">;
  facts: { rootCredentials: string[]; passport?: { issuer: string; subject: string } | null };
  options?: { skipNarrowing?: boolean };
}

export interface PolicyOutput {
  outcome: Outcome;
  reasons: Reason[];
  approver: string | null;
}

const toS = (iso: string) => Math.floor(Date.parse(iso) / 1000);

export function linkFacts(m: Mandate): LinkFacts {
  const s = m.credentialSubject;
  return {
    id: m.id,
    issuer: m.issuer,
    subject: s.id,
    profile: s.profile,
    validFromS: toS(m.validFrom),
    validUntilS: toS(m.validUntil),
    constraints: s.constraints,
    delegation: s.delegation,
    ...(s.escalation ? { escalation: s.escalation } : {}),
    revocation: s.revocation,
  };
}

const STEP: Record<string, number> = {};
[
  "presentation.invalid",
  "presentation.wrongAudience",
  "chain.malformed",
  "constraint.unknownOp",
  "action.malformed",
  "chain.signatureInvalid",
  "chain.brokenLink",
  "chain.notPresenter",
  "chain.cycle",
  "chain.notYetValid",
  "chain.expired",
  "status.revoked",
  "status.stale",
  "status.unavailable",
  "status.wrongIssuer",
  "chain.profileMismatch",
].forEach((c, i) => (STEP[c] = i));

/** Stable order: by link (none first), then code, then dimension. */
function sortReasons(rs: Reason[]): Reason[] {
  const key = (r: Reason) => [r.link ?? -1, STEP[r.code] ?? 100, r.code, r.dimension ?? "", r.requirement ?? ""] as const;
  return [...rs].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return 0;
  });
}

const r = (code: string, extra: Partial<Reason> = {}): Reason => ({ code, ...extra, approvable: false });

function bytesOf(b: BufferSource): Uint8Array {
  return ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b);
}

async function bundledWasm(): Promise<Uint8Array> {
  const url = new URL("../policy/policy.wasm", import.meta.url);
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  if (proc?.versions?.node) {
    const fsName = "node:fs/promises";
    const fs = (await import(/* @vite-ignore */ fsName)) as { readFile(u: URL): Promise<Uint8Array> };
    return new Uint8Array(await fs.readFile(url));
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`can't fetch ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

export interface DecideInput {
  chain: Mandate[];
  /** The DID that is acting. For a counterparty, the TSP sender of the presentation. */
  presenter: string;
  action: Action;
  /** What the leaf has spent per period. Required when the leaf has a budget that applies. */
  state?: SpendStatement;
  approvals?: Approval[];
  usedApprovals?: (id: string) => boolean;
  status: StatusResolver;
  requirements?: Requirements;
  facts?: { rootCredentials?: Credential[]; passport?: Credential };
  clock: Clock;
}

export class MandateEngine {
  private constructor(
    private readonly policies: Policies,
    readonly policyHash: string,
  ) {}

  /** Loads the policy. Without `wasm`, the bundled policy/policy.wasm (read from disk in Node, fetched in a browser). */
  static async load(wasm?: BufferSource): Promise<MandateEngine> {
    const bytes = wasm ? bytesOf(wasm) : await bundledWasm();
    const policies = await Policies.load(bytes as Uint8Array<ArrayBuffer>);
    for (const e of [DECISION, NARROWING]) if (!policies.entrypoints().includes(e)) throw new Error(`policy has no entrypoint ${e}`);
    return new MandateEngine(policies, sha256Tag(bytes));
  }

  /** Runs the policy on facts. Deterministic: the same input gives the same output. */
  evaluate(input: PolicyInput): PolicyOutput {
    const out = this.policies.evaluate<PolicyOutput>(DECISION, input);
    return { outcome: out.outcome, reasons: sortReasons(out.reasons ?? []), approver: out.approver ?? null };
  }

  /** The narrowing step for one parent and child, on facts. Empty means the child narrows. */
  narrowing(parent: LinkFacts, child: LinkFacts): Reason[] {
    return sortReasons(this.policies.evaluate<{ reasons: Reason[] }>(NARROWING, { chain: [parent, child] }).reasons ?? []);
  }

  /** Whether `child` narrows `parent` (§7.2, §7.3). Empty means it does. Signatures and links aren't checked here. */
  async narrows(parent: Mandate, child: Mandate): Promise<Reason[]> {
    const shape = [...checkMandate(parent, 0), ...checkMandate(child, 1)];
    if (shape.length) return sortReasons(shape);
    const out: Reason[] = [];
    if (parent.credentialSubject.profile !== child.credentialSubject.profile) out.push(r("chain.profileMismatch", { link: 1 }));
    return sortReasons([...out, ...this.narrowing(linkFacts(parent), linkFacts(child))]);
  }

  /**
   * Checks a chain without an action: steps 1 to 9. Status lists are checked only with a resolver.
   * A delegate uses it on a mandate it receives.
   */
  async checkChain(i: { chain: Mandate[]; presenter: string; clock: Clock; status?: StatusResolver; requirements?: Requirements }): Promise<Reason[]> {
    const s = await structural(i.chain, i.presenter, i.clock, i.status, i.requirements?.maxStatusAgeSeconds ?? DEFAULT_REQUIREMENTS.maxStatusAgeSeconds);
    if (!s.wellFormed) return sortReasons(s.reasons);
    const facts = i.chain.map(linkFacts);
    const narrowing = facts.slice(1).flatMap((c, k) => this.narrowing(facts[k], c).map((x) => ({ ...x, link: k + 1 })));
    return sortReasons([...s.reasons, ...narrowing]);
  }

  /** Decides an action against a chain (§8.2). */
  async decide(i: DecideInput): Promise<Decision> {
    return this.decideWith(i, []);
  }

  /**
   * What a counterparty runs on a presentation (§8.7). `sender` is the TSP sender; `me` is this verifier's DID.
   * The presentation's spend statement is the budget state, and its status lists are hints: the newest valid list wins.
   */
  async verifyPresentation(p: Presentation, o: { sender: string; me: string; status: StatusResolver; requirements?: Requirements; clock: Clock }): Promise<Decision> {
    const extra: Reason[] = [];
    const sig = await verifyDocument(p, o.clock).catch(() => ({ valid: false }));
    if (p?.type !== "mandates/presentation" || !sig.valid) extra.push(r("presentation.invalid", { detail: "its signature doesn't verify" }));
    if (p?.issuer !== o.sender) extra.push(r("chain.notPresenter", { detail: "the presentation wasn't sent by its issuer" }));
    if (p?.audience !== o.me) extra.push(r("presentation.wrongAudience"));
    if (p?.action && p.actionHash !== actionHash(p.action)) extra.push(r("presentation.invalid", { detail: "its actionHash doesn't match its action" }));
    const status = withHints(o.status, Array.isArray(p?.statusLists) ? p.statusLists : [], o.clock);
    return this.decideWith(
      {
        chain: Array.isArray(p?.chain) ? p.chain : [],
        presenter: o.sender,
        action: p?.action,
        ...(p?.spend ? { state: p.spend } : {}),
        approvals: Array.isArray(p?.approvals) ? p.approvals : [],
        status,
        ...(o.requirements ? { requirements: o.requirements } : {}),
        facts: { ...(p?.rootCredentials ? { rootCredentials: p.rootCredentials } : {}), ...(p?.passport ? { passport: p.passport } : {}) },
        clock: o.clock,
      },
      extra,
    );
  }

  private async decideWith(i: DecideInput, extra: Reason[]): Promise<Decision> {
    const req = { ...DEFAULT_REQUIREMENTS, ...(i.requirements ?? {}) };
    const now = i.clock.now();
    const chain = Array.isArray(i.chain) ? i.chain : [];
    const s = await structural(chain, i.presenter, i.clock, i.status, req.maxStatusAgeSeconds, i.action);
    let hash = "";
    try {
      hash = actionHash(i.action);
    } catch {
      hash = "";
    }
    const wellFormed = s.wellFormed;
    const facts = wellFormed ? chain.map(linkFacts) : [];

    // Approvals (step 11): signatures and bindings here; which failures they clear in the policy.
    const approvals: PolicyInput["approvals"] = [];
    const approvalProblems: Reason[] = [];
    if (wellFormed) {
      for (const a of i.approvals ?? []) {
        const problems = await verifyApproval(a, { chain, action: i.action, clock: i.clock });
        if (problems.length === 0 && i.usedApprovals?.(a.id)) problems.push(r("approval.used", { detail: a.id }));
        if (problems.length) approvalProblems.push(...problems);
        else approvals.push({ id: a.id, approverLink: chain.findIndex((m) => m.issuer === a.issuer), actionHash: a.actionHash, validUntilS: Date.parse(a.validUntil) / 1000, used: false });
      }
    }

    const leaf = chain[chain.length - 1];
    const spent: PolicyInput["state"]["spent"] = {};
    if (wellFormed && i.state && i.state.mandate === leaf.id && i.state.spent && typeof i.state.spent === "object") spent[leaf.id] = i.state.spent;

    const input: PolicyInput = {
      nowS: now / 1000,
      action: wellFormed ? { type: i.action.type, attrs: i.action.attrs } : { type: "", attrs: { spend: "0" } },
      actionHash: hash,
      chain: facts,
      structural: [...extra, ...s.reasons],
      approvalProblems,
      state: { spent },
      approvals,
      requirements: { maxLinks: req.maxLinks, rootMustHold: req.rootMustHold, passport: req.passport, ...(req.passportIssuerMustBeRoot ? { passportIssuerMustBeRoot: true } : {}) },
      facts: wellFormed ? await verifiedFacts(chain, i.presenter, i.facts, i.clock) : { rootCredentials: [] },
    };
    const out = this.evaluate(input);
    return {
      outcome: out.outcome,
      reasons: out.reasons,
      approver: out.approver,
      actionHash: hash,
      chain: chain.map((m) => m?.id),
      parties: chain.map((m) => ({ issuer: m?.issuer, subject: m?.credentialSubject?.id })),
      policy: { id: POLICY_ID, hash: this.policyHash },
      at: i.clock.iso(),
    };
  }
}

/** Steps 1 to 8 of §8.2. `wellFormed` is false when the shape is wrong, and then only shape reasons are given. */
async function structural(
  chain: Mandate[],
  presenter: string,
  clock: Clock,
  status: StatusResolver | undefined,
  verifierMaxAge: number,
  action?: Action,
): Promise<{ reasons: Reason[]; wellFormed: boolean }> {
  // 1. Shape.
  const shape: Reason[] = [];
  if (chain.length < 1 || chain.length > MAX_LINKS) shape.push(r("chain.malformed", { detail: `a chain has 1 to ${MAX_LINKS} links, not ${chain.length}` }));
  else {
    chain.forEach((m, k) => shape.push(...checkMandate(m, k)));
    if (shape.length === 0) shape.push(...checkRoot(chain[0], getProfile(chain[0].credentialSubject.profile)!));
  }
  if (shape.length) return { reasons: shape, wellFormed: false };

  // A malformed action is denied, but the chain is still checked so the decision says everything wrong.
  const out: Reason[] = action !== undefined ? checkAction(action, presenter) : [];
  const now = clock.now();
  const n = chain.length;
  // 2. Signatures.
  for (let k = 0; k < n; k++) {
    const v = await verifyDocument(chain[k], clock).catch(() => ({ valid: false }));
    if (!v.valid) out.push(r("chain.signatureInvalid", { link: k }));
  }
  // 3. Links.
  if (chain[0].credentialSubject.parent !== null) out.push(r("chain.brokenLink", { link: 0, detail: "the root names a parent" }));
  for (let k = 1; k < n; k++) {
    const prev = chain[k - 1];
    const parent = chain[k].credentialSubject.parent;
    if (chain[k].issuer !== prev.credentialSubject.id) out.push(r("chain.brokenLink", { link: k, detail: "its issuer isn't the subject of the link above" }));
    else if (!parent || parent.id !== prev.id || parent.hash !== mandateHash(prev)) out.push(r("chain.brokenLink", { link: k, detail: "its parent doesn't match the link above" }));
  }
  // 4. The leaf is the presenter.
  if (chain[n - 1].credentialSubject.id !== presenter) out.push(r("chain.notPresenter", { link: n - 1 }));
  // 5. No loops.
  const seen = new Set<string>([chain[0].issuer]);
  for (let k = 0; k < n; k++) {
    const subj = chain[k].credentialSubject.id;
    if (chain[k].issuer === subj || seen.has(subj)) out.push(r("chain.cycle", { link: k }));
    seen.add(subj);
  }
  // 6. Time.
  for (let k = 0; k < n; k++) {
    if (Date.parse(chain[k].validFrom) > now + SKEW_MS) out.push(r("chain.notYetValid", { link: k }));
    if (now >= Date.parse(chain[k].validUntil)) out.push(r("chain.expired", { link: k }));
  }
  // 7. Status.
  if (status) {
    const lists = new Map<string, Promise<StatusListDoc | null>>();
    const fetchList = (id: string) => {
      if (!lists.has(id)) lists.set(id, status.get(id).catch(() => null));
      return lists.get(id)!;
    };
    for (let k = 0; k < n; k++) {
      const entry = chain[k].credentialStatus;
      const list = await fetchList(entry.statusListCredential);
      if (!list || typeof list !== "object") {
        out.push(r("status.unavailable", { link: k }));
        continue;
      }
      const sig = await verifyDocument(list, clock).catch(() => ({ valid: false }));
      if (!sig.valid || list.issuer !== chain[k].issuer || list.id !== entry.statusListCredential) {
        out.push(r("status.wrongIssuer", { link: k }));
        continue;
      }
      if (!(entry.statusListIndex < list.length)) {
        out.push(r("status.unavailable", { link: k, detail: "the index is outside the list" }));
        continue;
      }
      const maxAge = Math.min(verifierMaxAge, ...chain.slice(k).map((m) => m.credentialSubject.revocation.maxAgeSeconds));
      const issued = Date.parse(list.issuedAt);
      if (Number.isNaN(issued) || (now - issued) / 1000 > maxAge || issued > now + SKEW_MS) out.push(r("status.stale", { link: k, limit: maxAge }));
      if (isRevokedIn(list, entry.statusListIndex)) out.push(r("status.revoked", { link: k }));
    }
  }
  // 8. Profile.
  const profile = chain[0].credentialSubject.profile;
  for (let k = 1; k < n; k++) if (chain[k].credentialSubject.profile !== profile) out.push(r("chain.profileMismatch", { link: k }));
  if (action && action.profile !== profile) out.push(r("chain.profileMismatch", { detail: `the action is ${action.profile}, the chain ${profile}` }));
  return { reasons: out, wellFormed: !out.some((x) => x.code === "action.malformed") };
}

/** Root credentials and the passport, verified: signature, subject, validity. Unverified ones are left out. */
async function verifiedFacts(chain: Mandate[], presenter: string, given: DecideInput["facts"], clock: Clock): Promise<PolicyInput["facts"]> {
  const ok = async (c: Credential, subject: string) => {
    if (!c || typeof c !== "object" || c.credentialSubject?.id !== subject || !Array.isArray(c.type)) return false;
    const v = await verifyDocument(c, clock).catch(() => ({ valid: false }));
    const now = clock.now();
    return v.valid && !(Date.parse(c.validFrom) > now + SKEW_MS) && !(c.validUntil && now >= Date.parse(c.validUntil));
  };
  const rootCredentials: string[] = [];
  for (const c of given?.rootCredentials ?? []) {
    if (await ok(c, chain[0].issuer)) for (const t of c.type) if (t !== "VerifiableCredential") rootCredentials.push(`${t}@${c.issuer}`);
  }
  const p = given?.passport;
  return { rootCredentials, ...(p && (await ok(p, presenter)) ? { passport: { issuer: p.issuer, subject: presenter } } : {}) };
}

/** A resolver that also considers lists the presenter brought; the newest one that verifies wins. */
function withHints(resolver: StatusResolver, hints: StatusListDoc[], clock: Clock): StatusResolver {
  return {
    async get(id) {
      const fetched = await resolver.get(id).catch(() => null);
      const candidates = [fetched, ...hints.filter((h) => h && h.id === id)].filter((x): x is StatusListDoc => !!x);
      let best: StatusListDoc | null = null;
      for (const c of candidates) {
        const v = await verifyDocument(c, clock).catch(() => ({ valid: false }));
        if (v.valid && c.id === id && (!best || Date.parse(c.issuedAt) > Date.parse(best.issuedAt))) best = c;
      }
      return best ?? fetched ?? candidates[0] ?? null;
    },
  };
}

let shared: Promise<MandateEngine> | null = null;

/** The engine with the bundled policy, loaded once. */
export function defaultEngine(): Promise<MandateEngine> {
  return (shared ??= MandateEngine.load());
}

/** Whether `child` narrows `parent`, with the bundled policy. Empty means it does. */
export async function narrows(parent: Mandate, child: Mandate): Promise<Reason[]> {
  return (await defaultEngine()).narrows(parent, child);
}
