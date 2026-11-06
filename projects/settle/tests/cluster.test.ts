/**
 * The platform on a real Solana cluster: a solana-test-validator, devnet, or any RPC URL. Off by default;
 *
 *   SETTLE_CLUSTER=localnet npm run test:cluster --workspace @zk-toip/settle   # solana-test-validator on :8899
 *   SETTLE_CLUSTER=devnet SETTLE_DATA=.data/devnet npm run test:cluster ...    # devnet, with a funded treasury
 *
 * The program must be deployed first (npm run deploy -- --cluster <same>), and the treasury in the data
 * directory must hold SOL (a test validator's faucet gives it freely). Real clusters keep real time, so
 * these flows don't skip ahead: a release by the payer, a ruling, and a refund.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { identityFromSeed } from "@zk-toip/trust-core";
import { STATE } from "../src/chain/escrow";
import type { Party } from "../src/agents/party";
import { SettleApi } from "../src/client/client";
import { loadPolicy } from "../src/protocol/policyFile";
import type { SettlePolicy } from "../src/protocol/policy";
import { startPlatform, type Platform } from "../src/platform/platform";

const CLUSTER = process.env.SETTLE_CLUSTER;
const USDC = (n: number) => BigInt(Math.round(n * 1e6));

async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 120_000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe.skipIf(!CLUSTER)(`Settle on ${CLUSTER ?? "a real cluster"}`, { timeout: 300_000 }, () => {
  let platform: Platform;
  let api: SettleApi;
  let policy: SettlePolicy;
  const parties: Party[] = [];
  let ticker: ReturnType<typeof setInterval>;
  const join_ = async (name: string) => {
    const p = await api.party({ identity: identityFromSeed(crypto.getRandomValues(new Uint8Array(32))), name, policy });
    await p.start();
    await api.register(p);
    parties.push(p);
    return p;
  };

  beforeAll(async () => {
    policy = await loadPolicy();
    platform = await startPlatform({ web: "none", cluster: CLUSTER, dataDir: process.env.SETTLE_DATA ?? mkdtempSync(join(tmpdir(), "settle-cluster-")) });
    api = new SettleApi(platform.url);
    ticker = setInterval(() => parties.forEach((p) => void p.tick().catch(() => {})), 1000);
    await api.operatorSignIn(identityFromSeed(new Uint8Array(32).fill(9)), platform.operators.setupCode ?? undefined).catch(async () => {
      // A kept data directory already has an operator: add this test's identity directly.
      platform.operators.add(identityFromSeed(new Uint8Array(32).fill(9)).did);
      await api.operatorSignIn(identityFromSeed(new Uint8Array(32).fill(9)));
    });
  }, 300_000);
  afterAll(async () => {
    clearInterval(ticker);
    parties.forEach((p) => p.stop());
    await platform?.close();
  });

  it("knows it's on a real cluster: no time travel", async () => {
    expect(platform.config.devClock).toBe(false);
    await expect(api.advance(60)).rejects.toThrow(/keeps real time/);
    const now = await api.now();
    expect(Math.abs(now - Date.now() / 1000)).toBeLessThan(120);
  });

  it("a payment link, paid and released, with every account's SOL from the gas station", async () => {
    const shop = await join_("Joe's Plumbing");
    const customer = await join_("Dana");
    await api.addFunds(customer, USDC(50));
    const c = await customer.checkout(await shop.createLink({ title: "Fix the sink", units: USDC(20), release: "payer-confirms" }));
    await until(() => customer.checkouts.get(c.id)?.status === "opened", "the escrow to open");
    const id = customer.checkouts.get(c.id)!.paymentId!;
    await until(() => !!shop.payments.get(id)?.escrow, "the shop to check the escrow");
    await customer.attest(id, "complete");
    await until(() => !!shop.payments.get(id)?.settled && !!customer.payments.get(id)?.settled, "settlement");
    expect(await platform.chain.balance(shop.tokenAccount(id)!)).toBe(USDC(20));
    expect((await platform.chain.escrow(shop.payments.get(id)!.escrow!))!.state).toBe(STATE.resolved);
    expect(await shop.collectToWallet()).toBe(USDC(20));
  });

  it("a dispute held and ruled by the arbiter, and a refund", async () => {
    const shop = await join_("Ana's Painting");
    const customer = await join_("Building owner");
    await api.addFunds(customer, USDC(100));
    const disputed = await customer.checkout(await shop.createLink({ title: "Paint the door", units: USDC(40), release: "payer-confirms" }));
    const refunded = await customer.checkout(await shop.createLink({ title: "Paint the fence", units: USDC(10), release: "payer-confirms" }));
    await until(() => [disputed, refunded].every((c) => customer.checkouts.get(c.id)?.status === "opened"), "both escrows to open");
    const [d, r] = [disputed, refunded].map((c) => customer.checkouts.get(c.id)!.paymentId!);
    await until(() => !!shop.payments.get(d)?.escrow && !!shop.payments.get(r)?.escrow, "the shop to check both");

    await customer.dispute(d, "The door is the wrong colour");
    await until(async () => (await api.get<{ cases: { id: string; disputes: unknown[] }[] }>("/api/arbiter")).cases.some((k) => k.id === d && k.disputes.length === 1), "the case");
    await until(() => platform.processor.events.some((e) => e.text.includes("held the disputed escrow")), "the hold");
    await api.post("/api/arbiter/rule", { paymentId: d, payeeUnits: USDC(25).toString(), reasons: "Painted, in the wrong colour." });
    await shop.refund(r);
    await until(() => !!customer.payments.get(d)?.settled && !!customer.payments.get(r)?.settled, "the ruling and the refund");
    expect(await platform.chain.balance(shop.tokenAccount(d)!)).toBe(USDC(25));
    expect(customer.payments.get(r)!.settled!.payeeUnits).toBe("0");
  });
});
