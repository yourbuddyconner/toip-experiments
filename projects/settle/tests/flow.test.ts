import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startRelay, type Relay } from "@zk-toip/relay";
import { outcomeMessage, STATE } from "../src/chain/escrow";
import { randomPaymentKey } from "../src/chain/keys";
import { evidenceHash } from "../src/protocol/documents";
import { ESCROW_SIGN } from "../src/protocol/specs";
import { toB64u } from "@zk-toip/trust-core";
import { hex } from "../src/agents/base";
import { verifyLog } from "../src/protocol/log";
import { PROCESSOR_LOG } from "../src/protocol/specs";
import { createWorld, USDC, type World } from "../src/world";

let relay: Relay | undefined;
let w: World | undefined;
afterEach(async () => {
  w?.stop();
  await relay?.close();
});

const until = async (cond: () => boolean, what: string, ms = 8000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
};

async function setup(): Promise<{ w: World; id: string }> {
  relay = await startRelay({ port: 0, dbPath: join(mkdtempSync(join(tmpdir(), "settle-")), "r.db") });
  w = await createWorld({ relayUrl: relay.url });
  const id = await w.joe.request(w.landlord.did, "Fix kitchen sink leak, Unit 4B", USDC(340));
  await until(() => w!.landlord.requests.has(id), "the invoice");
  await w.landlord.proposeTerms(id, { attester: w.alice.did, disputeWindowDays: 7, feeBps: 100, feeAccount: w.processor.feeAccount, refundAfterDays: 30 });
  await w.landlord.fund(id, w.wallet);
  await until(() => !!w!.joe.payments.get(id)?.escrow && !!w!.alice.payments.get(id), "the escrow to open");
  return { w, id };
}

const escrowOf = (w: World, id: string) => w.net.escrow(w.landlord.payments.get(id)!.escrow!)!;
const joeToken = (w: World, id: string) => w.joe.payments.get(id)!.terms!.payee.tokenAccount;

describe("Settle end to end: a repair job (design §10)", () => {
  it("pays the contractor after attested completion and a quiet dispute window", async () => {
    const { w, id } = await setup();
    expect(escrowOf(w, id).state).toBe(STATE.funded);
    expect(w.net.balance(w.landlord.tokenAccount(id)!)).toBe(0n);
    await w.alice.attest(id, "complete", "Fixed. No leak after a day.");
    await until(() => w.landlord.payments.get(id)!.attestations.length === 1, "the attestation");

    await w.joe.requestRelease(id);
    await until(() => w.landlord.events.some((e) => e.text.includes("not signing")), "the landlord to refuse early");
    expect(escrowOf(w, id).state).toBe(STATE.funded);

    w.advance(8 * 86400);
    w.joe.payments.get(id)!.signed = [];
    await w.joe.requestRelease(id);
    await until(() => escrowOf(w, id).state === STATE.resolved, "settlement");
    expect(w.net.balance(joeToken(w, id))).toBe(USDC(336.6));
    expect(w.net.balance(w.processor.feeAccount)).toBe(USDC(3.4));
    await until(() => w.landlord.receipts.length === 1, "the receipt");
    expect(w.landlord.receipts[0].credentialSubject.paidUnits).toBe(USDC(340).toString());
  });

  it("splits the money when the arbiter rules on a dispute, with only the arbiter and one party signing", async () => {
    const { w, id } = await setup();
    await w.alice.attest(id, "not-complete", "Still dripping under the sink.");
    await w.landlord.dispute(id, "Tenant reports the leak isn't fixed");
    await until(() => w.arbiter.payments.get(id)!.disputes.length === 1, "the arbiter to get the dispute");
    await w.arbiter.rule(id, USDC(200), "Pipe replaced, but the seal was left loose: 200 for the work done.");
    await until(() => escrowOf(w, id).state === STATE.resolved, "settlement");
    const s = escrowOf(w, id);
    expect(s.payeePaid).toBe(USDC(200));
    expect(w.net.balance(joeToken(w, id))).toBe(USDC(198));
    expect(w.net.balance(w.landlord.tokenAccount(id)!)).toBe(USDC(140));
    expect(w.net.balance(w.processor.feeAccount)).toBe(USDC(2));
  });

  it("lets the payer reclaim alone only after the deadline", async () => {
    const { w, id } = await setup();
    expect(await w.landlord.reclaim(id)).toBe(false);
    w.advance(31 * 86400);
    expect(await w.landlord.reclaim(id)).toBe(true);
    expect(w.net.balance(w.landlord.tokenAccount(id)!)).toBe(USDC(340));
    expect(escrowOf(w, id).state).toBe(STATE.reclaimed);
  });

  it("publishes a transparency log anyone can verify", async () => {
    const { w, id } = await setup();
    await w.alice.attest(id, "complete");
    w.advance(8 * 86400);
    await w.joe.requestRelease(id);
    await until(() => escrowOf(w, id).state === STATE.resolved, "settlement");
    const res = await w.alice.endpoint.request<Record<string, never>, { entries: import("../src/protocol/log").LogEntry[]; head: import("../src/protocol/log").LogHead }>(w.processor.did, PROCESSOR_LOG, {});
    const { entries, head } = res.payload;
    expect(entries.map((e) => e.kind)).toEqual(["opened", "signature", "signature", "settled"]);
    expect(await verifyLog(entries, head, w.processor.did, w.clock)).toEqual({ ok: true });
    const tampered = entries.map((e, i) => (i === 3 ? { ...e, detail: { ...e.detail, payeeUnits: "1" } } : e));
    expect((await verifyLog(tampered, head, w.processor.did, w.clock)).ok).toBe(false);
  });

  it("won't accept terms that swap the arbiter, and the processor won't count a stranger's signature", async () => {
    const { w, id } = await setup();
    void id;
    // A second invoice whose terms name a different arbiter key.
    const id2 = await w.joe.request(w.landlord.did, "Second job", USDC(50));
    await until(() => w.landlord.requests.has(id2), "the second invoice");
    const realArbiter = w.landlord["directory"].arbiter;
    w.landlord["directory"].arbiter = { did: realArbiter.did, key: w.processor.feePayer.address };
    await w.landlord.proposeTerms(id2, { attester: w.alice.did, disputeWindowDays: 7, feeBps: 100, feeAccount: w.processor.feeAccount, refundAfterDays: 30 });
    await until(() => w.joe.events.some((e) => e.text.includes("refused terms")), "joe to refuse");
    expect(w.joe.events.at(-1)!.text).toContain("an arbiter I didn't agree to");
    w.landlord["directory"].arbiter = realArbiter;

    // A stranger signs a full release for the first escrow and sends it to the processor.
    const escrow = w.landlord.payments.get(id)!.escrow!;
    const mallory = await randomPaymentKey();
    const evidence = { type: "settle/evidence" as const, termsHash: hex(escrowOf(w, id).termsHash), payeeUnits: USDC(340).toString(), attestations: [], disputes: [] };
    const message = outcomeMessage(w.net.programId, escrow, USDC(340), evidenceHash(evidence));
    await w.alice.endpoint.notify(w.processor.did, ESCROW_SIGN, { termsHash: evidence.termsHash, escrow, payeeUnits: evidence.payeeUnits, evidence, signer: mallory.address, signature: toB64u(mallory.sign(message)) });
    await new Promise((r) => setTimeout(r, 300));
    expect(w.processor.log.snapshot().entries.filter((e) => e.kind === "signature")).toHaveLength(0);
    expect(escrowOf(w, id).state).toBe(STATE.funded);
  });
});
