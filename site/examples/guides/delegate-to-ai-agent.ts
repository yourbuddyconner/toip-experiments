// Delegate bounded authority to an AI agent with a mandate: which actions, which merchants, how much per
// purchase and per week. Every action gets a decision (allow, escalate or deny) with reasons in plain words.
import {
  MandateEngine, SpendLedger, StatusRegistry, approve, explain, issueMandate, registerProfile, staticStatusResolver, type Action,
} from "@toip-tools/mandates";
import { SystemClock, identityFromSeed } from "@toip-tools/trust-core";

const clock = new SystemClock();
const random = () => crypto.getRandomValues(new Uint8Array(32));
const owner = identityFromSeed(random());
const agent = identityFromSeed(random());

// A profile is the action vocabulary: what an action of each type must say. Roots must constrain type and spend.
registerProfile({ id: "shopping/1", actions: { "shopping/buy": { required: ["merchant", "item"] } }, rootRequires: ["type", "spend:budget"] });

// The owner signs a mandate for the agent. Amounts are integer units: here, cents.
const status = new StatusRegistry(owner, clock); // the owner's revocation list
const mandate = issueMandate(owner, clock, {
  subject: agent.did,
  validUntil: new Date(clock.now() + 30 * 86_400_000).toISOString(),
  status: status.allocate(),
  profile: "shopping/1",
  constraints: {
    actions: { attr: "type", anyOf: ["shopping/buy"] },
    merchants: { attr: "merchant", anyOf: ["grocer.example", "pharmacy.example"] },
    perPurchase: { attr: "spend", max: "5000" },
    perWeek: { attr: "spend", budget: "15000", period: "P7D" },
  },
  delegation: { maxDepth: 0 }, // the agent may not delegate further
  escalation: { approvable: ["perPurchase"], approvalTtlSeconds: 600 }, // the owner may approve a bigger purchase
  revocation: { maxAgeSeconds: 3600 }, // verifiers need a status list less than an hour old
});

const engine = await MandateEngine.load();
const ledger = new SpendLedger(); // what the agent has spent, per mandate
const words = {
  name: (did: string) => (did === owner.did ? "Sam" : "the shopping agent"),
  units: (cents: string, attr: string) => (attr === "spend" ? `$${(Number(cents) / 100).toFixed(2)}` : cents),
  label: (dimension: string) => ({ perPurchase: "per purchase", perWeek: "per week" })[dimension],
  noun: "this purchase",
};

async function attempt(merchant: string, item: string, cents: number, approvals = [] as ReturnType<typeof approve>[]) {
  const action: Action = {
    type: "shopping/buy", profile: "shopping/1", id: crypto.randomUUID(), actor: agent.did, at: clock.iso(),
    attrs: { merchant, item, spend: String(cents) },
  };
  const decision = await engine.decide({
    chain: [mandate], presenter: agent.did, action, approvals,
    state: { mandate: mandate.id, spent: ledger.spent(mandate.id, clock.now()) },
    status: staticStatusResolver([status.sign()]), clock,
  });
  console.log(`${item} at ${merchant}, $${(cents / 100).toFixed(2)}: ${decision.outcome}`);
  console.log(`  ${explain(decision, words).join(" ")}`);
  // Allowed: reserve the spend before paying, so two purchases can't both take the last of the budget.
  if (decision.outcome === "allow") ledger.tryReserve(mandate, action.id, action.attrs.spend, clock.now(), action.type);
  return { action, decision };
}

await attempt("grocer.example", "groceries", 4200);
await attempt("casino.example", "chips", 2000);
const { action } = await attempt("pharmacy.example", "allergy medicine", 6500);

// The owner approves that one purchase, and only that one.
const approval = approve(owner, clock, { chain: [mandate], action, ttlSeconds: 600 });
const retry = await engine.decide({
  chain: [mandate], presenter: agent.did, action, approvals: [approval], usedApprovals: (id) => ledger.approvalUsed(id),
  state: { mandate: mandate.id, spent: ledger.spent(mandate.id, clock.now()) },
  status: staticStatusResolver([status.sign()]), clock,
});
console.log(`With Sam's approval: ${retry.outcome}`);
ledger.tryReserve(mandate, action.id, action.attrs.spend, clock.now(), action.type);
ledger.markApprovalUsed(approval.id);

await attempt("grocer.example", "more groceries", 4900); // the weekly budget has $43.00 left

// Revoke the mandate: the agent is stopped as soon as verifiers see the new list.
status.revoke(mandate.credentialStatus);
await attempt("grocer.example", "milk", 300);
