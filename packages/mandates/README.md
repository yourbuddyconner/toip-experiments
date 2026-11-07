# @toip-tools/mandates

Delegation credentials. A principal (a person, an organization, a device owner) gives a delegate (an agent, a sub-agent, a device) a bounded authority. The delegate may pass on a narrower one. Anyone can check an action against the whole chain, on their own, and get a decision with reasons and plain sentences.

The design is `projects/agents/docs/design.md`, §7 to §10 and §16. The library knows nothing about Settle or cameras. Their action vocabularies are data: the `settle/1` and `capture/1` profiles.

## The pieces

- A **mandate** is a W3C VC-shaped credential (type `Mandate`), signed by its issuer with trust-core's `eddsa-jcs-2022` proof. It names its delegate, a profile, its parent (`{ id, hash }`, or `null` at the root), constraints, how many more links may follow, what may be approved, and how fresh a revocation list must be. `validUntil` and `credentialStatus` are required.
- An **action** is what the delegate is about to do, written down first: a type, a profile, an actor and attributes. Every action has `spend` (units that leave the delegate's wallet; `"0"` when nothing does).
- A **decision** is `allow`, `escalate` or `deny`, with reasons, the approver for an escalation, the action's hash, the chain, and the policy's hash.
- An **approval** is a chain issuer's signature over one action's hash. It clears the failures it may clear, once.
- A **presentation** is what a delegate sends a counterparty: the action, the chain, approvals, a spend statement and optional status lists, signed and bound to one audience.

## The constraint language

`constraints` maps a dimension name (`spendPerTx`) to one constraint: `attr` (the attribute; `type` reads the action's type, anything else reads `attrs`), exactly one operator, and an optional `when` (the action types it applies to; none means all).

| Operator | Value | An action satisfies it when | A child narrows the parent when |
|---|---|---|---|
| `anyOf` | strings | the attribute is in the set; for an array, at least one element is | child set ⊆ parent set |
| `noneOf` | strings | the attribute isn't in the set; for an array, no element is | child set ⊇ parent set |
| `within` | patterns | the attribute matches a pattern; for an array, every element does (and there is one) | every child pattern is covered by a parent pattern |
| `is` | string, number or boolean | the attribute equals it | equal |
| `max` | integer (a units string or a number) | attribute ≤ value | child ≤ parent |
| `min` | integer | attribute ≥ value | child ≥ parent |
| `budget` | units, with `period` | spent in the period + `spend` ≤ value | same period, child ≤ parent |

Other rules:

- **Patterns** are exact (`physical.errand`) or end in `.*` or `/*` (`software.*`). `software.ci` and `software.tests.*` are covered by `software.*`. `software.*` is not covered by `software.ci`.
- **`when`**: a child's must be the same or wider. No `when` narrows any `when`.
- **Dropping a dimension is widening** (`narrowing.dropped`). A child may add dimensions. A changed `attr`, operator or budget period is `narrowing.changedMeaning`.
- **Other fields**: `delegation.maxDepth` child ≤ parent − 1; `escalation.approvable` child ⊆ parent; `approvalTtlSeconds` and `revocation.maxAgeSeconds` child ≤ parent; the child's validity window lies inside the parent's; the profile is the same.
- **Periods** are rolling: `P1D`, `P7D`, `P30D` are 1, 7 and 30 days ending now. `total` is everything.
- **Numbers** are integers up to 2^53 − 1. Bigger ones are malformed.
- **Size**: at most 5 links, 32 dimensions and 256 set entries.
- **Fail closed**: an unknown operator is `constraint.unknownOp`; a missing attribute is `attr.missing`; a value of the wrong kind (a string where a number is needed) fails the constraint.
- **Roots** must constrain `type`, and what their profile requires. `settle/1` needs `asset` and a budget on `spend`.

## The decision flow

1. TypeScript checks the shape of every link and of the action.
2. Each link's signature (`chain.signatureInvalid`).
3. Each link's issuer is the parent's subject, and `parent` is the parent's id and hash (`chain.brokenLink`).
4. The leaf's subject is the presenter (`chain.notPresenter`). For a counterparty, that is the TSP sender.
5. No DID appears twice (`chain.cycle`).
6. Each link is valid now, with five minutes' skew (`chain.notYetValid`, `chain.expired`).
7. Each link's status list: signed by the link's issuer (`status.wrongIssuer`), present (`status.unavailable`), fresh enough for every link from there down and for the verifier (`status.stale`), and the bit clear (`status.revoked`).
8. One profile across the chain and the action (`chain.profileMismatch`).
9. The Rego policy `mandates/check/1` checks that each link narrows its parent (`narrowing.*`).
10. It checks the action against **every** link. Budgets are checked on the leaf only: a delegator's own budgets are spent when it funds the delegate.
11. Valid approvals clear the approvable failures at their issuer's link and below.
12. It applies the verifier's requirements (`requirement.failed`).
13. **allow** if nothing is left. **escalate** if only approvable constraint or budget failures are left; the approver is the issuer of the highest link with a failure. **deny** otherwise.

Steps 1 to 9 can't be approved away. Chains only narrow twice over: a widened link is denied in step 9, and step 10 would refuse what its parent refuses anyway. A property test checks the second half with step 9 switched off.

The compiled policy is `policy/policy.wasm`, with its hash in `policy/policy.sha256`. Every decision carries that hash. `engine.evaluate(input)` re-runs a decision from its facts.

## The API, with short examples

```ts
import {
  MandateEngine, StatusRegistry, SpendLedger, issueMandate, delegate, narrows, approve, verifyApproval,
  present, explain, actionHash, staticStatusResolver, httpStatusResolver,
} from "@toip-tools/mandates";

// The principal keeps a status list and issues a root mandate.
const status = new StatusRegistry(principal, clock);
const root = issueMandate(principal, clock, {
  subject: agent.did, validUntil, status: status.allocate(), profile: "settle/1",
  constraints: {
    actions: { attr: "type", anyOf: ["settle/pay", "mandates/delegate"] },
    asset: { attr: "asset", anyOf: [mint], when: ["settle/pay", "mandates/delegate"] },
    spendPerTx: { attr: "spend", max: "30000000", when: ["settle/pay"] },
    spendPerDay: { attr: "spend", budget: "100000000", period: "P1D" },
  },
  delegation: { maxDepth: 1 },
  escalation: { approvable: ["spendPerTx"], approvalTtlSeconds: 3600 },
  revocation: { maxAgeSeconds: 3600 },
});

// The agent delegates a narrower mandate. A widening returns problems and signs nothing.
const r = await delegate([root], agent, clock, {
  subject: subAgent.did, validUntil: sooner, status: agentStatus.allocate(),
  tighten: { spendPerTx: { attr: "spend", max: "20000000", when: ["settle/pay"] } },
});
if ("problems" in r) throw new Error(explain({ ...someDecision, reasons: r.problems }).join(" "));
await narrows(root, r.mandate); // [] means it narrows

// Decide. The ledger holds the delegate's spend and used approvals.
const engine = await MandateEngine.load();
const ledger = new SpendLedger();
const d = await engine.decide({
  chain: [root, r.mandate], presenter: subAgent.did, action,
  state: { mandate: r.mandate.id, spent: ledger.spent(r.mandate.id, clock.now()) },
  status: httpStatusResolver("https://hub.example/api/status"), clock,
});
explain(d, { name: (did) => names[did], units: usdc, label: (dim) => labels[dim], noun: "this payment" });

// Escalate: the principal approves the exact action.
const approval = approve(principal, clock, { chain, action, ttlSeconds: 600 });
await verifyApproval(approval, { chain, action, clock }); // [] means valid
await engine.decide({ ...input, approvals: [approval], usedApprovals: (id) => ledger.approvalUsed(id) });
ledger.markApprovalUsed(approval.id);
ledger.tryReserve(r.mandate, action.id, action.attrs.spend, clock.now(), action.type); // [] means reserved

// A counterparty checks a presentation, using the TSP sender.
const p = present(subAgent, clock, { audience: worker.did, action, actionHash: actionHash(action), chain, approvals: [approval], spend });
await engine.verifyPresentation(p, { sender, me: worker.did, status, clock, requirements: { rootMustHold: ["VerifiedBusiness@did:key:…"], passport: "required" } });

// Revocation.
status.revoke(root.credentialStatus);
const list = status.sign(); // publish it, and send mandates/revoked
```

Names, by area:

- Issuing: `issueMandate`, `delegate`, `narrows`, `mandateHash`.
- Deciding: `MandateEngine` (`load`, `policyHash`, `decide`, `verifyPresentation`, `checkChain`, `narrows`, `narrowing`, `evaluate`), `defaultEngine`, `actionHash`, `linkFacts`, `POLICY_ID`, `DEFAULT_REQUIREMENTS`.
- Explaining: `explain`, `REASON_CODES`, `hasSentence`.
- Approvals: `approve`, `verifyApproval`.
- Presentations: `present`.
- Revocation: `StatusRegistry`, `staticStatusResolver`, `httpStatusResolver`, `isRevoked`.
- Spend state: `SpendLedger` (`spent`, `reserve`, `tryReserve`, `release`, `refund`, `markApprovalUsed`, `approvalUsed`, `save`).
- Profiles: `SETTLE_1`, `CAPTURE_1`, `registerProfile`, `getProfile`.
- Trust Tasks: `MANDATE_ISSUE`, `MANDATE_REVOKED`, `APPROVAL_REQUEST`, `APPROVAL_GRANT`, `APPROVAL_DENY`, `serveMandateTasks`, `sendMandate`, `notifyRevoked`, `requestApproval`, `grantApproval`, `denyApproval`.

### Trust Tasks

All five are one-way, in our namespace (`https://toip.tools/spec/mandates/…/0.1`). Mount the handlers a role needs:

```ts
serveMandateTasks(endpoint, {
  clock, status,
  onIssue: ({ mandate, chain, sender }) => keep(mandate),          // the chain verified and narrows, and names this endpoint
  onRevoked: ({ statusList }) => isRevoked(mine, statusList) && stop(),
  onApprovalGrant: ({ approval }) => redecide(approval),            // signed by the sender; decide checks the rest
  onApprovalDeny: ({ request, reason }) => tell(request, reason),
  onRejected: ({ type, sender, reasons }) => log(type, sender, reasons),
});
// The approver's side:
serveMandateTasks(console, { clock, onApprovalRequest: (r) => inbox.push(r) });
```

### Owner-to-device delegation

`capture/1` defines `capture/sign-media` (`device`, `media`, `mediaType`) and `capture/sign-reading` (`device`, `media`, `quantity`). An owner limits a camera with `when`-scoped constraints, for example `{ attr: "location", within: ["geo:us/ca/*"], when: ["capture/sign-media"] }`. An agency can delegate to a freelancer, who delegates to her camera. `registerProfile` adds other vocabularies.

## Commands

- `npm test`: the tests, with 10,000 cases per property (set `PROPERTY_CASES` for fewer).
- `npm run typecheck`.
- `npm run policy`: rebuild `policy/policy.wasm` and its hash with `opa`.
- `npm run policy:test`: the policy's own `opa test` cases.

## Differences from the design

- **More reason codes.** `action.malformed` (a malformed action, an unknown action type, a missing required attribute, an actor who isn't the presenter), `presentation.invalid` and `presentation.wrongAudience`. Reasons may carry `detail`, `spent`, `period` and `requirement`.
- **Decisions carry `parties`** (issuer and subject per link), so `explain` can name people without the chain.
- **`explain` takes `label` and `noun`** as well as `name` and `units`, to say "30.00 USDC per payment" and "this payment".
- **The passport defaults to optional.** The library serves devices as well as agents. Agents' counterparties set `passport: "required"`.
- **A missing spend statement denies** (`attr.missing` on `spent.<period>`) when a leaf budget applies. A counterparty can't assume zero.
- **Invalid approvals deny.** An approval that fails its checks adds its reason, and the outcome is `deny` even if the approval wasn't needed.
- **`within` on an empty array fails.** "Every element matches" would pass vacuously otherwise.
- **Refunds give budget back** (agents decision 4): `SpendLedger.refund`. `tryReserve` checks the leaf's budgets and reserves in one step, so two actions can't both take the last of a budget.
- **`checkChain`** checks a chain without an action, for a delegate receiving a mandate. `evaluate` and `narrowing` run the policy on facts, for re-running logged decisions and for the property tests.
- **`httpStatusResolver`** fetches `${base}/${did}` for list `did#status`, as the hub's `GET /api/status/:did` does. Pass `path` to change that.
- **Root credentials and passports** are checked for signature, subject and validity, not for revocation.
