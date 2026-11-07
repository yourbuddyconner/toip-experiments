/**
 * The three small changes the agents project needs (agents design §11.4): checkout attachments and payee
 * gates (S1), paying from the wallet (S2), and event hooks through SettleApi.party (S3).
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { identityFromSeed, type Traffic } from "@toip-tools/trust-core";
import type { Party } from "../src/agents/party";
import type { AgentEvent } from "../src/agents/base";
import { SettleApi } from "../src/client/client";
import { loadPolicy } from "../src/protocol/policyFile";
import type { SettlePolicy } from "../src/protocol/policy";
import { startPlatform, type Platform } from "../src/platform/platform";

const USDC = (n: number) => BigInt(Math.round(n * 1e6));
let policy: SettlePolicy;
let platform: Platform | undefined;
let parties: Party[] = [];
let ticker: ReturnType<typeof setInterval> | undefined;

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup() {
  platform = await startPlatform({ web: "none" });
  const api = new SettleApi(platform.url);
  const join = async (name: string, hooks: { onEvent?: (e: AgentEvent) => void; onTraffic?: (who: string, t: Traffic) => void } = {}) => {
    const p = await api.party({ identity: identityFromSeed(crypto.getRandomValues(new Uint8Array(32))), name, policy, ...hooks });
    await p.start();
    parties.push(p);
    return p;
  };
  ticker = setInterval(() => parties.forEach((p) => void p.tick().catch(() => {})), 150);
  return { api, join };
}

describe("S1: checkout attachments and payee gates", () => {
  it("attachments reach beforeInvoice; beforeAccept sees the terms; the payment goes through when both allow", async () => {
    const { api, join } = await setup();
    const shop = await join("Shop");
    const buyer = await join("Buyer");
    await api.addFunds(buyer, USDC(100));
    const seen: { attachments?: unknown; sender?: string; checkout?: string; terms?: string; link?: string } = {};
    shop.gates = {
      beforeInvoice: async (c) => {
        Object.assign(seen, { attachments: c.attachments, sender: c.sender, checkout: c.checkout });
        return null;
      },
      beforeAccept: async (c) => {
        seen.terms = c.terms.payment;
        seen.link = c.link;
        return [];
      },
    };
    const link = await shop.createLink({ title: "A job", units: USDC(10), release: "payer-confirms" });
    const c = await buyer.checkout(link, { attachments: { presentation: { hello: "world" } } });
    await until(() => buyer.checkouts.get(c.id)?.status === "opened", "the escrow to open");
    expect(seen.attachments).toEqual({ presentation: { hello: "world" } });
    expect(seen.sender).toBe(buyer.did);
    expect(seen.checkout).toBe(c.id);
    expect(seen.terms).toBe(buyer.checkouts.get(c.id)!.paymentId);
    expect(seen.link).toBe(link.id);
  });

  it("a beforeInvoice refusal means no invoice", async () => {
    const { api, join } = await setup();
    const shop = await join("Shop");
    const buyer = await join("Buyer");
    await api.addFunds(buyer, USDC(100));
    shop.gates = { beforeInvoice: async () => "no presentation" };
    const c = await buyer.checkout(await shop.createLink({ title: "A job", units: USDC(10), release: "payer-confirms" }));
    await until(() => shop.events.some((e) => e.text.includes("didn't invoice") && e.text.includes("no presentation")), "the refusal");
    await sleep(300);
    expect(buyer.checkouts.get(c.id)!.status).toBe("contacting");
    expect(buyer.requests.size).toBe(0);
    expect(shop.payments.size).toBe(0);
  });

  it("beforeAccept problems refuse the terms, so no escrow opens", async () => {
    const { api, join } = await setup();
    const shop = await join("Shop");
    const buyer = await join("Buyer");
    await api.addFunds(buyer, USDC(100));
    shop.gates = { beforeAccept: async () => ["the attester isn't the one presented"] };
    const c = await buyer.checkout(await shop.createLink({ title: "A job", units: USDC(10), release: "payer-confirms" }));
    await until(() => shop.events.some((e) => e.text.includes("refused terms") && e.text.includes("the attester isn't the one presented")), "the refusal");
    await sleep(300);
    expect(buyer.checkouts.get(c.id)!.status).toBe("proposed");
    expect(buyer.payments.get(buyer.checkouts.get(c.id)!.paymentId!)!.escrow).toBeUndefined();
  });

  it("without gates and attachments, checkout behaves as before", async () => {
    const { api, join } = await setup();
    const shop = await join("Shop");
    const buyer = await join("Buyer");
    await api.addFunds(buyer, USDC(100));
    const c = await buyer.checkout(await shop.createLink({ title: "A job", units: USDC(10), release: "payer-confirms" }));
    await until(() => buyer.checkouts.get(c.id)?.status === "opened", "the escrow to open");
  });
});

describe("S2: paying from the wallet", () => {
  it("moves USDC from one party's wallet to another's, and refuses more than the wallet holds", async () => {
    const { api, join } = await setup();
    const principal = await join("Principal");
    const agent = await join("Agent");
    await api.addFunds(principal, USDC(150));
    const to = (await agent.openWallet()).token;
    await principal.sendFromWallet(to, USDC(60));
    expect(await principal.walletBalance()).toBe(USDC(90));
    expect(await agent.walletBalance()).toBe(USDC(60));
    expect(principal.events.some((e) => e.text.includes("sent 60.00 USDC from the wallet"))).toBe(true);
    await expect(principal.sendFromWallet(to, USDC(91))).rejects.toThrow(/not enough/);
    await expect(principal.sendFromWallet(to, 0n)).rejects.toThrow(/more than zero/);
    expect(await agent.walletBalance()).toBe(USDC(60));
  });
});

describe("S3: event hooks through SettleApi.party", () => {
  it("passes onEvent and onTraffic to the party", async () => {
    const { api, join } = await setup();
    const events: AgentEvent[] = [];
    const traffic: Traffic[] = [];
    const shop = await join("Shop", { onEvent: (e) => events.push(e), onTraffic: (_who, t) => traffic.push(t) });
    const buyer = await join("Buyer");
    await api.addFunds(buyer, USDC(100));
    const link = await shop.createLink({ title: "A job", units: USDC(10), release: "payer-confirms" });
    const c = await buyer.checkout(link);
    await until(() => buyer.checkouts.get(c.id)?.status === "opened", "the escrow to open");
    expect(events.some((e) => e.who === "Shop" && e.text.includes("created a payment link"))).toBe(true);
    expect(traffic.some((t) => t.direction === "in" && t.document.type.includes("checkout/start"))).toBe(true);
    expect(traffic.some((t) => t.direction === "out" && t.document.type.includes("payment/request"))).toBe(true);
  });
});
