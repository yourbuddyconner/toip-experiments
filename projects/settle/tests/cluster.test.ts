/**
 * The platform on a real Solana cluster: a solana-test-validator, devnet, or any RPC URL. Off by default;
 *
 *   SETTLE_CLUSTER=localnet npm run test:cluster --workspace @toip-tools/settle   # solana-test-validator on :8899
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
import { identityFromSeed } from "@toip-tools/trust-core";
import { STATE } from "../src/chain/escrow";
import { rpcStats } from "../src/chain/chain";
import type { Party } from "../src/agents/party";
import { SettleApi } from "../src/client/client";
import { loadPolicy } from "../src/protocol/policyFile";
import type { SettlePolicy } from "../src/protocol/policy";
import { startPlatform, type Platform } from "../src/platform/platform";

const CLUSTER = process.env.SETTLE_CLUSTER;
const USDC = (n: number) => BigInt(Math.round(n * 1e6));

/** Whose recent events to show when a wait times out. */
const watched: { name: string; events: { at: string; text: string }[] }[] = [];

async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 120_000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) {
      // On a real cluster, what each party last did is the only clue to where it stalled.
      const trail = watched.map((p) => `${p.name}:\n${p.events.slice(-12).map((e) => `  ${e.at.slice(11, 19)} ${e.text}`).join("\n")}`);
      throw new Error(`timed out waiting for ${what}\n${trail.join("\n")}`);
    }
    await new Promise((r) => setTimeout(r, 1000)); // a public RPC endpoint rate-limits
  }
}

/** Progress on a slow cluster: elapsed time, and RPC requests and busy-node retries so far. */
const t0 = Date.now();
const mark = (what: string) => console.log(`  ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s  rpc ${rpcStats.requests} (retried ${rpcStats.retries})  ${what}`);

describe.skipIf(!CLUSTER)(`Settle on ${CLUSTER ?? "a real cluster"}`, { timeout: 600_000 }, () => {
  let platform: Platform;
  let api: SettleApi;
  let policy: SettlePolicy;
  const parties: Party[] = [];
  let ticker: ReturnType<typeof setInterval>;
  const operator = identityFromSeed(crypto.getRandomValues(new Uint8Array(32)));
  const join_ = async (name: string) => {
    const p = await api.party({ identity: identityFromSeed(crypto.getRandomValues(new Uint8Array(32))), name, policy });
    await p.start();
    await api.register(p);
    parties.push(p);
    watched.push(p);
    return p;
  };

  beforeAll(async () => {
    policy = await loadPolicy();
    platform = await startPlatform({ web: "none", cluster: CLUSTER, dataDir: process.env.SETTLE_DATA ?? mkdtempSync(join(tmpdir(), "settle-cluster-")) });
    api = new SettleApi(platform.url);
    watched.push(platform.processor);
    ticker = setInterval(() => parties.forEach((p) => void p.tick().catch(() => {})), 2000);
    // A throwaway operator for this run, removed afterwards, so a kept data directory never keeps a test's key on its list.
    if (platform.operators.setupCode) await api.operatorSignIn(operator, platform.operators.setupCode);
    else {
      platform.operators.add(operator.did);
      await api.operatorSignIn(operator);
    }
  }, 600_000);
  afterAll(async () => {
    if (platform?.operators.dids.includes(operator.did)) platform.operators.remove(operator.did, "the test");
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
    mark("funded");
    const disputed = await customer.checkout(await shop.createLink({ title: "Paint the door", units: USDC(40), release: "payer-confirms" }));
    const refunded = await customer.checkout(await shop.createLink({ title: "Paint the fence", units: USDC(10), release: "payer-confirms" }));
    await until(() => [disputed, refunded].every((c) => customer.checkouts.get(c.id)?.status === "opened"), "both escrows to open");
    mark("both escrows open");
    const [d, r] = [disputed, refunded].map((c) => customer.checkouts.get(c.id)!.paymentId!);
    await until(() => !!shop.payments.get(d)?.escrow && !!shop.payments.get(r)?.escrow, "the shop to check both");

    mark("the shop checked both");
    await customer.dispute(d, "The door is the wrong colour");
    await until(async () => (await api.get<{ cases: { id: string; disputes: unknown[] }[] }>("/api/arbiter")).cases.some((k) => k.id === d && k.disputes.length === 1), "the case");
    mark("the arbiter has the case");
    await until(() => platform.processor.events.some((e) => e.text.includes("held the disputed escrow")), "the hold");
    mark("held");
    await api.post("/api/arbiter/rule", { paymentId: d, payeeUnits: USDC(25).toString(), reasons: "Painted, in the wrong colour." });
    await shop.refund(r);
    await until(() => !!customer.payments.get(d)?.settled && !!customer.payments.get(r)?.settled, "the ruling and the refund");
    mark("ruled and refunded");
    expect(await platform.chain.balance(shop.tokenAccount(d)!)).toBe(USDC(25));
    expect(customer.payments.get(r)!.settled!.payeeUnits).toBe("0");
  });
});
