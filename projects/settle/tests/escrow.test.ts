import { beforeEach, describe, expect, it } from "vitest";
import type { Address, KeyPairSigner } from "@solana/kit";
import { ed25519Instruction, escrowAddress, openInstruction, outcomeMessage, reclaimInstruction, resolveInstruction, STATE, vaultAddress } from "../src/chain/escrow";
import { randomPaymentKey, type PaymentKey } from "../src/chain/keys";
import { Simnet } from "../src/chain/simnet";

const USDC = (n: number) => BigInt(Math.round(n * 1_000_000));

interface World {
  net: Simnet;
  processor: KeyPairSigner;
  mint: Address;
  payer: PaymentKey;
  payee: PaymentKey;
  arbiter: PaymentKey;
  outsider: PaymentKey;
  payerToken: Address;
  payeeToken: Address;
  feeToken: Address;
  termsHash: Uint8Array;
  escrow: Address;
}

async function world(): Promise<World> {
  const net = await Simnet.create();
  const processor = await net.funded();
  const mint = await net.createMint(processor);
  const [payer, payee, arbiter, outsider] = await Promise.all([randomPaymentKey(), randomPaymentKey(), randomPaymentKey(), randomPaymentKey()]);
  const payerToken = await net.createTokenAccount(mint, payer.address, processor);
  const payeeToken = await net.createTokenAccount(mint, payee.address, processor);
  const feeToken = await net.createTokenAccount(mint, processor.address, processor);
  await net.mintTo(mint, payerToken, processor, USDC(500));
  const termsHash = crypto.getRandomValues(new Uint8Array(32));
  return { net, processor, mint, payer, payee, arbiter, outsider, payerToken, payeeToken, feeToken, termsHash, escrow: await escrowAddress(net.programId, termsHash) };
}

async function open(w: World, over: Partial<{ amount: bigint; threshold: number; feeBps: number; refundAfter: bigint; payerToken: Address }> = {}) {
  return w.net.send(w.processor, [
    await openInstruction({
      programId: w.net.programId,
      payer: w.payer.signer,
      rentPayer: w.processor,
      payerToken: over.payerToken ?? w.payerToken,
      mint: w.mint,
      feeAccount: w.feeToken,
      termsHash: w.termsHash,
      amount: over.amount ?? USDC(340),
      payee: w.payee.address,
      arbiter: w.arbiter.address,
      threshold: over.threshold ?? 2,
      feeBps: over.feeBps ?? 100,
      refundAfter: over.refundAfter ?? w.net.now() + 30n * 86400n,
    }),
  ]);
}

async function resolve(w: World, payeeAmount: bigint, signers: PaymentKey[], over: Partial<{ payeeToken: Address; message: Uint8Array }> = {}) {
  const evidence = new Uint8Array(32).fill(7);
  const message = over.message ?? outcomeMessage(w.net.programId, w.escrow, payeeAmount, evidence);
  return w.net.send(w.processor, [
    ...signers.map((k) => ed25519Instruction(k.publicKey, k.sign(message), message)),
    await resolveInstruction({
      programId: w.net.programId,
      escrow: w.escrow,
      payeeToken: over.payeeToken ?? w.payeeToken,
      payerToken: w.payerToken,
      feeToken: w.feeToken,
      rentPayer: w.processor.address,
      payeeAmount,
      evidenceHash: evidence,
    }),
  ]);
}

describe("Settle escrow program (design §5)", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });

  it("opens: funds move from the payer into a vault the escrow owns", async () => {
    expect((await open(w)).ok).toBe(true);
    expect(w.net.balance(w.payerToken)).toBe(USDC(160));
    expect(w.net.balance(await vaultAddress(w.net.programId, w.escrow))).toBe(USDC(340));
    const s = w.net.escrow(w.escrow)!;
    expect(s.state).toBe(STATE.funded);
    expect(s.amount).toBe(USDC(340));
    expect(s.payee).toBe(w.payee.address);
    expect(s.threshold).toBe(2);
    expect(s.feeBps).toBe(100);
  });

  it("releases on payer and payee signatures, paying the agreed fee", async () => {
    await open(w);
    const r = await resolve(w, USDC(340), [w.payer, w.payee]);
    expect(r.ok).toBe(true);
    expect(w.net.balance(w.payeeToken)).toBe(USDC(336.6));
    expect(w.net.balance(w.feeToken)).toBe(USDC(3.4));
    expect(w.net.balance(w.payerToken)).toBe(USDC(160));
    expect(w.net.escrow(w.escrow)!.state).toBe(STATE.resolved);
    expect(w.net.exists(await vaultAddress(w.net.programId, w.escrow))).toBe(false);
  });

  it("splits on an arbiter's ruling plus one party: part to the payee, the rest back", async () => {
    await open(w);
    const r = await resolve(w, USDC(200), [w.arbiter, w.payer]);
    expect(r.ok).toBe(true);
    expect(w.net.balance(w.payeeToken)).toBe(USDC(198));
    expect(w.net.balance(w.feeToken)).toBe(USDC(2));
    expect(w.net.balance(w.payerToken)).toBe(USDC(300));
    expect(w.net.escrow(w.escrow)!.payeePaid).toBe(USDC(200));
  });

  it("refunds everything on payee and arbiter signatures for pay:0, with no fee", async () => {
    await open(w);
    expect((await resolve(w, 0n, [w.payee, w.arbiter])).ok).toBe(true);
    expect(w.net.balance(w.payerToken)).toBe(USDC(500));
    expect(w.net.balance(w.feeToken)).toBe(0n);
  });

  it("refuses one signature, the same key twice, or an outsider's key", async () => {
    await open(w);
    expect(await resolve(w, USDC(340), [w.payee])).toMatchObject({ ok: false, name: "NoQuorum" });
    expect(await resolve(w, USDC(340), [w.payee, w.payee])).toMatchObject({ ok: false, name: "NoQuorum" });
    expect(await resolve(w, USDC(340), [w.payee, w.outsider])).toMatchObject({ ok: false, name: "NoQuorum" });
    expect(w.net.escrow(w.escrow)!.state).toBe(STATE.funded);
  });

  it("refuses signatures over a different outcome or a different escrow", async () => {
    await open(w);
    const evidence = new Uint8Array(32).fill(7);
    const otherAmount = outcomeMessage(w.net.programId, w.escrow, USDC(1), evidence);
    expect(await resolve(w, USDC(340), [w.payer, w.payee], { message: otherAmount })).toMatchObject({ ok: false, name: "NoQuorum" });
    const otherEscrow = outcomeMessage(w.net.programId, w.payerToken, USDC(340), evidence);
    expect(await resolve(w, USDC(340), [w.payer, w.payee], { message: otherEscrow })).toMatchObject({ ok: false, name: "NoQuorum" });
  });

  it("can't be resolved twice, and its address can't be funded again", async () => {
    await open(w);
    expect((await resolve(w, USDC(340), [w.payer, w.payee])).ok).toBe(true);
    expect(await resolve(w, USDC(340), [w.payer, w.payee])).toMatchObject({ ok: false });
    expect((await open(w, { amount: USDC(10) })).ok).toBe(false);
  });

  it("refuses to pay into a token account the payee doesn't hold", async () => {
    await open(w);
    const attacker = await w.net.createTokenAccount(w.mint, w.outsider.address, w.processor);
    expect(await resolve(w, USDC(340), [w.payer, w.payee], { payeeToken: attacker })).toMatchObject({ ok: false, name: "WrongTokenAccount" });
  });

  it("lets the payer reclaim alone only after the deadline", async () => {
    const deadline = w.net.now() + 3600n;
    await open(w, { refundAfter: deadline });
    const reclaim = async () =>
      w.net.send(w.processor, [await reclaimInstruction({ programId: w.net.programId, payer: w.payer.signer, escrow: w.escrow, payerToken: w.payerToken, rentPayer: w.processor.address })]);
    expect(await reclaim()).toMatchObject({ ok: false, name: "TooEarly" });
    w.net.setNow(deadline + 1n);
    expect((await reclaim()).ok).toBe(true);
    expect(w.net.balance(w.payerToken)).toBe(USDC(500));
    expect(w.net.escrow(w.escrow)!.state).toBe(STATE.reclaimed);
    expect(await resolve(w, USDC(340), [w.payer, w.payee])).toMatchObject({ ok: false, name: "NotFunded" });
  });

  it("still opens if someone sent lamports to the escrow address first (griefing)", async () => {
    w.net.airdrop(w.escrow, 1n);
    w.net.airdrop(await vaultAddress(w.net.programId, w.escrow), 1n);
    expect((await open(w)).ok).toBe(true);
    expect(w.net.escrow(w.escrow)!.state).toBe(STATE.funded);
  });

  it("refuses to open from a token account the payer doesn't hold", async () => {
    const other = await w.net.createTokenAccount(w.mint, w.outsider.address, w.processor);
    await w.net.mintTo(w.mint, other, w.processor, USDC(400));
    expect(await open(w, { payerToken: other })).toMatchObject({ ok: false, name: "WrongTokenAccount" });
  });
});
