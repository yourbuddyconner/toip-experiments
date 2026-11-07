import { Bus, Endpoint, type Identity } from "@toip-tools/trust-core";
import { describe, expect, it } from "vitest";
import {
  APPROVAL_DENY,
  APPROVAL_GRANT,
  APPROVAL_REQUEST,
  MANDATE_ISSUE,
  MANDATE_REVOKED,
  actionHash,
  approve,
  denyApproval,
  grantApproval,
  isRevoked,
  notifyRevoked,
  requestApproval,
  sendMandate,
  serveMandateTasks,
  type Reason,
} from "../src/index";
import { codes, engine, inDays, payAction, people, resign, rootMandate, twoLinks, usdc, world, zeroSpent } from "./helpers";

function net() {
  const w = world();
  const bus = new Bus(w.clock);
  const ep = (who: Identity) => new Endpoint({ identity: who, transport: bus, clock: w.clock });
  return { w, bus, conner: ep(people.conner), ops: ep(people.ops), errands: ep(people.errands), mallory: ep(people.mallory) };
}

describe("mandates/* Trust Tasks (§10.1)", () => {
  it("names the types in our namespace", () => {
    expect(MANDATE_ISSUE.typeUri).toBe("https://toip.tools/spec/mandates/issue/0.1");
    expect(MANDATE_REVOKED.typeUri).toBe("https://toip.tools/spec/mandates/revoked/0.1");
    expect(APPROVAL_REQUEST.typeUri).toBe("https://toip.tools/spec/mandates/approval/request/0.1");
    expect(APPROVAL_GRANT.typeUri).toBe("https://toip.tools/spec/mandates/approval/grant/0.1");
    expect(APPROVAL_DENY.typeUri).toBe("https://toip.tools/spec/mandates/approval/deny/0.1");
  });

  it("mandates/issue: the delegate receives a mandate whose chain verifies, and refuses a widened one", async () => {
    const { w, bus, conner, ops, errands, mallory } = net();
    const got: { to: string; id: string; sender: string }[] = [];
    const rejected: { to: string; reasons: Reason[] }[] = [];
    for (const [who, ep] of [
      ["ops", ops],
      ["errands", errands],
    ] as const) {
      serveMandateTasks(ep, {
        clock: w.clock,
        status: { get: async (id) => [w.connerStatus.sign(), w.opsStatus.sign()].find((l) => l.id === id) ?? null },
        onIssue: ({ mandate, sender }) => void got.push({ to: who, id: mandate.id, sender }),
        onRejected: ({ reasons }) => void rejected.push({ to: who, reasons }),
      });
    }
    const [root, child] = await twoLinks(w);
    await sendMandate(conner, ops.vid, { mandate: root, chain: [] });
    await sendMandate(ops, errands.vid, { mandate: child, chain: [root] });
    await bus.settle();
    expect(got).toEqual([
      { to: "ops", id: root.id, sender: people.conner.did },
      { to: "errands", id: child.id, sender: people.ops.did },
    ]);

    // Mallory forwards Ops' mandate as if it were hers to give, and Ops re-signs a widened child.
    await sendMandate(mallory, errands.vid, { mandate: child, chain: [root] });
    const wide = resign(child, people.ops, w.clock, (m) => (m.credentialSubject.constraints.spendPerTx = { attr: "spend", max: usdc(99), when: ["settle/pay"] }));
    await sendMandate(ops, errands.vid, { mandate: wide, chain: [root] });
    // A mandate addressed to someone else.
    await sendMandate(conner, errands.vid, { mandate: root, chain: [] });
    await bus.settle();
    expect(got).toHaveLength(2);
    expect(rejected.map((r) => codes(r).join()).sort()).toEqual(["chain.brokenLink", "chain.notPresenter", "narrowing.widened"]);
  });

  it("mandates/revoked: the delegate gets the signed list and can see its mandate is revoked", async () => {
    const { w, bus, conner, ops, mallory } = net();
    const notices: { mandate: string; revoked: boolean }[] = [];
    const rejected: Reason[][] = [];
    const root = rootMandate(w);
    serveMandateTasks(ops, {
      clock: w.clock,
      onRevoked: ({ mandate, statusList }) => void notices.push({ mandate, revoked: isRevoked(root, statusList) }),
      onRejected: ({ reasons }) => void rejected.push(reasons),
    });
    w.connerStatus.revoke(root.credentialStatus);
    await notifyRevoked(conner, ops.vid, { mandate: root.id, statusList: w.connerStatus.sign() });
    // Mallory can't send a list on Conner's behalf.
    await notifyRevoked(mallory, ops.vid, { mandate: root.id, statusList: w.connerStatus.sign() });
    await bus.settle();
    expect(notices).toEqual([{ mandate: root.id, revoked: true }]);
    expect(rejected.map((r) => codes({ reasons: r }))).toEqual([["status.wrongIssuer"]]);
  });

  it("mandates/approval/*: request, grant and deny, end to end", async () => {
    const { w, bus, conner, errands, mallory } = net();
    const chain = await twoLinks(w);
    const action = payAction(w, people.errands.did, { spend: usdc(45.5) });
    const decision = await (await engine()).decide({ chain, presenter: people.errands.did, action, state: zeroSpent(chain[1]), status: w.status(), clock: w.clock });
    expect(decision.outcome).toBe("escalate");

    const inbox: string[] = [];
    const rejected: Reason[][] = [];
    serveMandateTasks(conner, {
      clock: w.clock,
      onApprovalRequest: (r) => void inbox.push(`${r.request} from ${r.sender}: ${r.justification}`),
      onRejected: ({ reasons }) => void rejected.push(reasons),
    });
    const grants: string[] = [];
    const denials: string[] = [];
    serveMandateTasks(errands, {
      clock: w.clock,
      onApprovalGrant: ({ request, approval }) => void grants.push(`${request}:${approval.id}`),
      onApprovalDeny: ({ request, reason }) => void denials.push(`${request}:${reason}`),
      onRejected: ({ reasons }) => void rejected.push(reasons),
    });

    const request = { request: "req-1", action, actionHash: actionHash(action), chain, decision, justification: "Dana is the only courier free today.", expiresAt: inDays(w.clock, 1 / 48) };
    await requestApproval(errands, conner.vid, request);
    // A request whose hash doesn't match its action, and one from someone who isn't the leaf.
    await requestApproval(errands, conner.vid, { ...request, request: "req-2", actionHash: "sha256:" + "0".repeat(64) });
    await requestApproval(mallory, conner.vid, { ...request, request: "req-3" });
    await bus.settle();
    expect(inbox).toEqual([`req-1 from ${people.errands.did}: Dana is the only courier free today.`]);

    const approval = approve(people.conner, w.clock, { chain, action, ttlSeconds: 600 });
    await grantApproval(conner, errands.vid, { request: "req-1", approval });
    // Mallory forwards Conner's approval: the grant must come from the approval's issuer.
    await grantApproval(mallory, errands.vid, { request: "req-1", approval });
    await denyApproval(conner, errands.vid, { request: "req-9", reason: "Not today." });
    await bus.settle();
    expect(grants).toEqual([`req-1:${approval.id}`]);
    expect(denials).toEqual(["req-9:Not today."]);
    expect(rejected.map((r) => codes({ reasons: r }).join()).sort()).toEqual(["approval.invalid", "approval.wrongAction", "chain.notPresenter"]);

    const after = await (await engine()).decide({ chain, presenter: people.errands.did, action, approvals: [approval], state: zeroSpent(chain[1]), status: w.status(), clock: w.clock });
    expect(after.outcome).toBe("allow");
  });
});
