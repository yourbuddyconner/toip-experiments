/**
 * The full stack without a browser: a platform (local chain, relay, processor, arbiter, verifier, API) and
 * parties connected the way the web app connects them.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { identityFromSeed, type Identity } from "@zk-toip/trust-core";
import { STATE } from "../src/chain/escrow";
import { encodeLink, decodeLink, verifyLink, type Party } from "../src/agents/party";
import { SettleApi } from "../src/client/client";
import { loadPolicy } from "../src/protocol/policyFile";
import type { SettlePolicy } from "../src/protocol/policy";
import { startPlatform, type Platform } from "../src/platform/platform";

const USDC = (n: number) => BigInt(Math.round(n * 1e6));
let policy: SettlePolicy;
let platform: Platform | undefined;
let parties: Party[] = [];
let ticker: ReturnType<typeof setInterval> | undefined;
const operatorId = identityFromSeed(new Uint8Array(32).fill(7));

beforeAll(async () => {
  policy = await loadPolicy();
});
afterEach(async () => {
  clearInterval(ticker);
  parties.forEach((p) => p.stop());
  parties = [];
  await platform?.close();
  platform = undefined;
});

async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 15000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function setup(dataDir?: string) {
  platform = await startPlatform({ web: "none", dataDir });
  const api = new SettleApi(platform.url);
  const join = async (name: string, identity: Identity = identityFromSeed(crypto.getRandomValues(new Uint8Array(32)))) => {
    const p = await api.party({ identity, name, policy });
    await p.start();
    await api.register(p);
    parties.push(p);
    return p;
  };
  ticker = setInterval(() => parties.forEach((p) => void p.tick().catch(() => {})), 150);
  /** Signs `api` in as the platform's operator: the first account to use the setup code. */
  const operator = async () => {
    if (platform!.operators.setupCode) await api.operatorSignIn(operatorId, platform!.operators.setupCode);
    else await api.operatorSignIn(operatorId);
  };
  return { api, join, operator };
}

const paymentOf = (p: Party, checkoutId: string) => p.checkouts.get(checkoutId)?.paymentId;

describe("Settle platform, end to end", () => {
  it("a customer pays through a payment link and releases the money by confirming the work", async () => {
    const { api, join } = await setup();
    const shop = await join("Joe's Plumbing");
    const customer = await join("Dana");
    await api.addFunds(customer, USDC(500));

    const link = await shop.createLink({ title: "Fix the kitchen sink", units: USDC(120), release: "payer-confirms" });
    const parsed = decodeLink(encodeLink(link))!;
    expect(await verifyLink(parsed, customer.clock)).toBe(true);

    const c = await customer.checkout(parsed);
    await until(() => customer.checkouts.get(c.id)?.status === "opened", "the escrow to open");
    const id = paymentOf(customer, c.id)!;
    expect(await customer.walletBalance()).toBe(USDC(500) - USDC(120) - USDC(1.2));
    await until(() => !!shop.payments.get(id)?.escrow, "the shop to check the escrow");

    await customer.attest(id, "complete", "Works, thanks");
    await until(() => !!shop.payments.get(id)?.settled && !!customer.payments.get(id)?.settled, "settlement");
    expect(await platform!.chain.balance(shop.tokenAccount(id)!)).toBe(USDC(120));
    expect(await platform!.chain.balance(platform!.processor.feeAccount)).toBe(USDC(1.2));
    await until(() => customer.receipts.length === 1, "the receipt");

    expect(await shop.collectToWallet()).toBe(USDC(120));
    expect(await shop.walletBalance()).toBe(USDC(120));
  });

  it("a third party confirms, and the payer signs only once the dispute window has passed on the chain's clock", async () => {
    const { api, join } = await setup();
    const shop = await join("Ana's Painting");
    const customer = await join("Building owner");
    const inspector = await join("Building manager");
    await api.addFunds(customer, USDC(1000));

    const link = await shop.createLink({ title: "Paint the lobby", units: USDC(800), release: "attester-confirms", attester: inspector.did, disputeWindowDays: 3 });
    const c = await customer.checkout(link);
    await until(() => customer.checkouts.get(c.id)?.status === "opened", "the escrow to open");
    const id = paymentOf(customer, c.id)!;
    await until(() => inspector.payments.get(id)?.role === "attester", "the inspector to be asked");

    await inspector.attest(id, "complete");
    await until(() => !!customer.payments.get(id)?.pending, "the shop's release request to wait for the window");
    expect(customer.payments.get(id)!.settled).toBeUndefined();

    await api.advance(4 * 86400);
    await until(() => !!shop.payments.get(id)?.settled, "settlement after the window");
    expect(shop.payments.get(id)!.settled!.payeeUnits).toBe(USDC(800).toString());
  });

  it("a dispute goes to the arbiter, which holds the escrow and rules through the operator API", async () => {
    const { api, join, operator } = await setup();
    await operator();
    const shop = await join("Joe's Plumbing");
    const customer = await join("Dana");
    await api.addFunds(customer, USDC(500));
    const c = await customer.checkout(await shop.createLink({ title: "Replace the water heater", units: USDC(400), release: "payer-confirms" }));
    await until(() => customer.checkouts.get(c.id)?.status === "opened", "the escrow to open");
    const id = paymentOf(customer, c.id)!;

    await customer.dispute(id, "It still runs cold");
    const cases = () => api.get<{ cases: { id: string; disputes: unknown[]; refundAfter: number | null }[] }>("/api/arbiter");
    await until(async () => (await cases()).cases.some((k) => k.id === id && k.disputes.length === 1), "the case");
    await until(async () => platform!.processor.events.some((e) => e.text.includes("held")), "the hold");

    await expect(api.post("/api/arbiter/rule", { paymentId: id, payeeUnits: USDC(500).toString(), reasons: "x" })).rejects.toThrow(/between nothing and the full price/);
    await api.post("/api/arbiter/rule", { paymentId: id, payeeUnits: USDC(250).toString(), reasons: "Installed, but the thermostat was left faulty." });
    await until(() => !!shop.payments.get(id)?.settled && !!customer.payments.get(id)?.settled, "the ruling to be carried out");
    expect(await platform!.chain.balance(shop.tokenAccount(id)!)).toBe(USDC(250));
    expect(await platform!.chain.balance(customer.tokenAccount(id)!)).toBe(USDC(150));
  });

  it("the payee can refund the whole payment, and the payer's money goes back to its wallet", async () => {
    const { api, join } = await setup();
    const shop = await join("Joe's Plumbing");
    const customer = await join("Dana");
    await api.addFunds(customer, USDC(200));
    const c = await customer.checkout(await shop.createLink({ title: "Unclog the drain", units: USDC(90), release: "payer-confirms" }));
    await until(() => customer.checkouts.get(c.id)?.status === "opened", "the escrow to open");
    const id = paymentOf(customer, c.id)!;
    await until(() => !!shop.payments.get(id)?.escrow, "the shop to check the escrow");

    await shop.refund(id);
    await until(() => !!customer.payments.get(id)?.settled, "the refund");
    expect(customer.payments.get(id)!.settled!.payeeUnits).toBe("0");
    await customer.collectToWallet();
    // The processor still earns its fee on a refund: it paid the network fees.
    expect(await customer.walletBalance()).toBe(USDC(200) - USDC(0.9));
  });

  it("a party saved mid-payment picks up where it left off", async () => {
    const { api, join } = await setup();
    const shopId = identityFromSeed(crypto.getRandomValues(new Uint8Array(32)));
    const shop = await join("Joe's Plumbing", shopId);
    const customer = await join("Dana");
    await api.addFunds(customer, USDC(300));
    const c = await customer.checkout(await shop.createLink({ title: "Fix the faucet", units: USDC(60), release: "payer-confirms" }));
    await until(() => customer.checkouts.get(c.id)?.status === "opened", "the escrow to open");
    const id = paymentOf(customer, c.id)!;
    await until(() => !!shop.payments.get(id)?.escrow, "the shop to check the escrow");

    const saved = JSON.parse(JSON.stringify(shop.snapshot()));
    shop.stop();
    parties = parties.filter((p) => p !== shop);
    await customer.attest(id, "complete");

    const again = await api.party({ identity: shopId, name: "Joe's Plumbing", policy, snapshot: saved });
    await again.start();
    parties.push(again);
    await until(() => !!again.payments.get(id)?.settled, "the restored shop to be paid");
    expect(await platform!.chain.balance(again.tokenAccount(id)!)).toBe(USDC(60));
    expect((await platform!.chain.escrow(again.payments.get(id)!.escrow!))!.state).toBe(STATE.resolved);
  });

  it("verified businesses carry their credential in their links, and the network refuses bad requests", async () => {
    const { api, join } = await setup();
    const shop = await join("Joe's Plumbing");
    const customer = await join("Dana");
    await api.verify(shop, "Joe's Plumbing LLC", "Plumbing");
    const link = await shop.createLink({ title: "Fix the sink", units: USDC(10), release: "payer-confirms" });
    expect(await customer.verifiedBusiness(link.credentials, shop.did)).toBe("Joe's Plumbing LLC");
    expect(await customer.verifiedBusiness(link.credentials, customer.did)).toBeNull();
    expect((await api.people()).find((p) => p.did === shop.did)?.verified).toBe("Joe's Plumbing LLC");

    const tampered = { ...link, units: USDC(1).toString() };
    expect(await verifyLink(tampered, customer.clock)).toBe(false);
    await expect(customer.checkout(tampered)).rejects.toThrow(/isn't valid/);
    await expect(customer.checkout(link)).rejects.toThrow(/not enough in your wallet/);
    await expect(customer.checkout(await customer.createLink({ title: "Mine", units: 1n, release: "payer-confirms" }))).rejects.toThrow(/your own/);

    await expect(api.post("/api/faucet", { tokenAccount: platform!.processor.feePayer.address, units: "1" })).rejects.toThrow(/not a test-USDC account/);
    await expect(api.post("/api/faucet", { tokenAccount: "x", units: "100000000000000" })).rejects.toThrow(/between 0 and 10,000/);
    await expect(api.post("/api/directory", { profile: { type: "settle/profile", issuer: shop.did, name: "Mallory" } })).rejects.toThrow(/signature/);
    await expect(api.post("/api/dev/advance", { seconds: -1 })).rejects.toThrow();
    expect((await api.people()).find((p) => p.did === shop.did)?.name).toBe("Joe's Plumbing");
  });
  it("a checkout only accepts an invoice from the link's own issuer", async () => {
    const { api, join } = await setup();
    const shop = await join("Joe's Plumbing");
    const customer = await join("Dana");
    const mallory = await join("Mallory");
    await api.addFunds(customer, USDC(500));
    await api.addFunds(mallory, USDC(10));
    const link = await shop.createLink({ title: "Fix the sink", units: USDC(100), release: "payer-confirms" });
    shop.stop(); // the real payee is offline, so only Mallory answers
    const c = await customer.checkout(link);
    // Mallory somehow learns the checkout id and invoices the customer for it, from her own key.
    const { PAYMENT_REQUEST } = await import("../src/protocol/specs");
    const { bindPaymentKey, derivePaymentKey } = await import("../src/protocol/documents");
    const key = await derivePaymentKey(mallory.identity, "pay-mallory");
    await mallory.endpoint.notify(customer.did, PAYMENT_REQUEST, {
      payment: "pay-mallory",
      purpose: link.title,
      units: link.units,
      payee: { did: mallory.did, paymentKey: key.address, tokenAccount: (await mallory.openWallet()).token, binding: bindPaymentKey(mallory.identity, key, "pay-mallory", mallory.clock) },
      credentials: [],
      link: link.id,
      checkout: c.id,
      conditions: { attester: customer.did, disputeWindowDays: 0 },
    });
    await until(() => customer.payments.has("pay-mallory"), "Mallory's invoice to arrive");
    await new Promise((r) => setTimeout(r, 300));
    expect(customer.checkouts.get(c.id)!.status).not.toBe("funding");
    expect(customer.checkouts.get(c.id)!.status).not.toBe("proposed");
    expect(customer.payments.get("pay-mallory")!.terms).toBeUndefined();
    expect(await customer.walletBalance()).toBe(USDC(500));
  });

  it("a platform restarted on the same data keeps its chain, keys, cases and log, and payments in progress finish", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "settle-restart-"));
    const { api, join: joinAs, operator } = await setup(dataDir);
    await operator();
    const shopId = identityFromSeed(crypto.getRandomValues(new Uint8Array(32)));
    const customerId = identityFromSeed(crypto.getRandomValues(new Uint8Array(32)));
    const shop = await joinAs("Joe's Plumbing", shopId);
    const customer = await joinAs("Dana", customerId);
    await api.addFunds(customer, USDC(500));
    const c = await customer.checkout(await shop.createLink({ title: "Fix the faucet", units: USDC(60), release: "payer-confirms" }));
    await until(() => customer.checkouts.get(c.id)?.status === "opened", "the escrow to open");
    const id = paymentOf(customer, c.id)!;
    await until(() => !!shop.payments.get(id)?.escrow, "the shop to check the escrow");
    await until(async () => (await api.get<{ cases: { id: string }[] }>("/api/arbiter")).cases.some((k) => k.id === id), "the arbiter to know the case");
    await api.advance(86400);
    const before = { config: platform!.config, now: await api.now(), log: platform!.processor.log.snapshot().entries.length };

    // Everyone saves and goes away, like browsers closing; then the platform stops and starts again.
    const saved = [shop, customer].map((p) => JSON.parse(JSON.stringify(p.snapshot())));
    clearInterval(ticker);
    parties.forEach((p) => p.stop());
    parties = [];
    await platform!.close();
    platform = undefined;

    const again = await setup(dataDir);
    expect(platform!.operators.setupCode).toBeNull(); // the operator is remembered...
    await again.operator(); // ...though sessions aren't
    const config = platform!.config;
    expect(config.networkId).toBe(before.config.networkId);
    expect([config.programId, config.mint, config.processor, config.arbiter, config.verifier]).toEqual([
      before.config.programId,
      before.config.mint,
      before.config.processor,
      before.config.arbiter,
      before.config.verifier,
    ]);
    // Chain time carries on from where it was, skipped-ahead day included.
    expect(await again.api.now()).toBeGreaterThanOrEqual(before.now);
    expect((await again.api.people()).map((p) => p.name).sort()).toEqual(["Dana", "Joe's Plumbing"]);

    const shop2 = await again.api.party({ identity: shopId, name: "Joe's Plumbing", policy, snapshot: saved[0] });
    const customer2 = await again.api.party({ identity: customerId, name: "Dana", policy, snapshot: saved[1] });
    for (const p of [shop2, customer2]) {
      await p.start();
      parties.push(p);
    }
    await customer2.openWallet();
    expect(await customer2.walletBalance()).toBe(USDC(500) - USDC(60) - USDC(0.6));
    expect((await again.api.get<{ cases: { id: string }[] }>("/api/arbiter")).cases.map((k) => k.id)).toContain(id);

    await customer2.attest(id, "complete");
    await until(() => !!shop2.payments.get(id)?.settled, "the payment to settle after the restart");
    expect(await platform!.chain.balance(shop2.tokenAccount(id)!)).toBe(USDC(60));
    const log = platform!.processor.log.snapshot();
    expect(log.entries.length).toBeGreaterThan(before.log);
    expect(log.entries[0].kind).toBe("opened");
    const proc = await again.api.get<{ check: { ok: boolean } }>("/api/processor");
    expect(proc.check.ok).toBe(true);
  });

  it("only operators see cases, rule, or read the processor's books; they sign in by signing a one-time challenge", async () => {
    const { api } = await setup();
    const url = platform!.url;
    const alice = identityFromSeed(crypto.getRandomValues(new Uint8Array(32)));
    const mallory = identityFromSeed(crypto.getRandomValues(new Uint8Array(32)));
    const status = async (path: string, init?: RequestInit) => (await fetch(url + path, init)).status;

    // Not signed in: the operator endpoints refuse; the transparency log stays public.
    expect(await status("/api/arbiter")).toBe(401);
    expect(await status("/api/processor")).toBe(401);
    expect(await status("/api/arbiter/rule", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).toBe(401);
    expect((await api.get<{ check: { ok: boolean } }>("/api/log")).check.ok).toBe(true);
    expect((await api.get<{ setupNeeded: boolean }>("/api/operator")).setupNeeded).toBe(true);

    // The first operator needs the setup code the platform printed.
    const code = platform!.operators.setupCode!;
    await expect(new SettleApi(url).operatorSignIn(mallory, "wrong")).rejects.toThrow(/wrong setup code/);
    await expect(new SettleApi(url).operatorSignIn(mallory)).rejects.toThrow(/isn't an operator/);
    const op = new SettleApi(url);
    expect((await op.operatorSignIn(alice, code)).operator).toBe(alice.did);
    expect(platform!.operators.setupCode).toBeNull();
    await expect(new SettleApi(url).operatorSignIn(mallory, code)).rejects.toThrow(/already has an operator/);
    expect((await op.get<{ cases: unknown[] }>("/api/arbiter")).cases).toEqual([]);
    expect((await op.get<{ operators: string[] }>("/api/operator")).operators).toEqual([alice.did]);

    // A challenge is good once, for this platform only, signed by the key that claims it.
    const { nonce, audience } = await api.post<{ nonce: string; audience: string }>("/api/operator/challenge", {});
    const { signDocument, SystemClock } = await import("@zk-toip/trust-core");
    const forged = { ...signDocument({ type: "settle/operator-login" as const, issuer: mallory.did, nonce, audience }, mallory, new SystemClock()), issuer: alice.did };
    await expect(api.post("/api/operator/login", { proof: forged })).rejects.toThrow(/signature/);
    const good = signDocument({ type: "settle/operator-login" as const, issuer: alice.did, nonce, audience }, alice, new SystemClock());
    await expect(api.post("/api/operator/login", { proof: good })).rejects.toThrow(/expired/); // the forged attempt used it up
    const other = await api.post<{ nonce: string }>("/api/operator/challenge", {});
    const elsewhere = signDocument({ type: "settle/operator-login" as const, issuer: alice.did, nonce: other.nonce, audience: "another-platform" }, alice, new SystemClock());
    await expect(api.post("/api/operator/login", { proof: elsewhere })).rejects.toThrow(/another platform/);

    // Operators add and remove operators; removal ends the removed operator's sessions.
    await op.post("/api/operator/add", { did: mallory.did });
    const m = new SettleApi(url);
    await m.operatorSignIn(mallory);
    expect((await m.get<{ cases: unknown[] }>("/api/arbiter")).cases).toEqual([]);
    await expect(m.post("/api/operator/remove", { did: mallory.did })).rejects.toThrow(/yourself/);
    await op.post("/api/operator/remove", { did: mallory.did });
    await expect(m.get("/api/arbiter")).rejects.toThrow(/sign in/);
    await op.operatorSignOut();
    await expect(op.get("/api/arbiter")).rejects.toThrow(/sign in/);

    // No cross-site requests, and nothing but JSON.
    expect(await status("/api/operator/challenge", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" })).toBe(403);
    expect(await status("/api/operator/challenge", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).toBe(415);
  });

  it("the gas station gives a little SOL for a party's own accounts, and no more", async () => {
    const { api } = await setup();
    const fresh = (await import("@solana/kit")).generateKeyPairSigner;
    const k = await fresh();
    await api.post("/api/gas", { address: k.address, lamports: "3000000" });
    expect(await platform!.chain.lamports(k.address)).toBe(3_000_000n);
    await expect(api.post("/api/gas", { address: k.address, lamports: "6000000" })).rejects.toThrow(/between 0 and/);
    await api.post("/api/gas", { address: k.address, lamports: "5000000" });
    await api.post("/api/gas", { address: k.address, lamports: "5000000" });
    await expect(api.post("/api/gas", { address: k.address, lamports: "1" })).rejects.toThrow(/enough SOL/);
    await expect(api.post("/api/gas", { address: "not-an-address", lamports: "1" })).rejects.toThrow(/not a Solana address/);
  });

  it("a kept platform whose local chain was deleted starts a new network, so browsers drop payments that no longer exist", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "settle-rechain-"));
    await setup(dataDir);
    const first = platform!.config;
    await platform!.close();
    platform = undefined;
    const { rmSync } = await import("node:fs");
    rmSync(join(dataDir, "chain.bin"));
    await setup(dataDir);
    expect(platform!.config.networkId).not.toBe(first.networkId);
    expect(platform!.config.processor.did).toBe(first.processor.did); // same keys, new chain
    expect(platform!.processor.escrows).toBe(0);
  });

  it("a party that sees the escrow resolve on the chain before the processor's word still records the transaction and sends its receipt", async () => {
    const { api, join, operator } = await setup();
    await operator();
    const shop = await join("Joe's Plumbing");
    const customer = await join("Dana");
    await api.addFunds(customer, USDC(200));
    const c = await customer.checkout(await shop.createLink({ title: "Fix the boiler", units: USDC(100), release: "payer-confirms" }));
    await until(() => customer.checkouts.get(c.id)?.status === "opened", "the escrow to open");
    const id = paymentOf(customer, c.id)!;
    await until(() => !!shop.payments.get(id)?.escrow, "the shop to check the escrow");
    await customer.dispute(id, "Still cold");
    await until(async () => (await api.get<{ cases: { id: string; disputes: unknown[] }[] }>("/api/arbiter")).cases.some((k) => k.id === id && k.disputes.length), "the case");

    // The shop drops off the relay; the arbiter and the customer settle it without the shop.
    shop.transport.stop();
    await api.post("/api/arbiter/rule", { paymentId: id, payeeUnits: USDC(60).toString(), reasons: "Half done." });
    await until(() => !!customer.payments.get(id)?.settled, "settlement");
    await shop.tick(); // the shop reads the chain first
    expect(shop.payments.get(id)!.settled!.transaction).toBe("");

    shop.transport.start();
    await until(() => !!shop.payments.get(id)!.settled!.transaction, "the processor's word to reach the shop");
    await until(() => customer.receipts.length === 1, "the shop's receipt");
  });
});
