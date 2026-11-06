import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSigner } from "@solana/kit";
import { Chain } from "../src/chain/chain";
import { ed25519Instruction, escrowAddress, openInstruction, outcomeMessage, resolveInstruction } from "../src/chain/escrow";
import { randomPaymentKey } from "../src/chain/keys";
import { startChainServer, type ChainServer } from "../src/chain/rpcServer";

let server: ChainServer | undefined;
afterEach(async () => {
  await server?.close();
});
const USDC = (n: number) => BigInt(Math.round(n * 1e6));

describe("the local cluster over Solana JSON-RPC", () => {
  it("serves the program id, the chain clock, and a dev clock advance", async () => {
    server = await startChainServer({ port: 0, startTime: Date.parse("2026-11-06T09:00:00Z") });
    const chain = await Chain.connect(server.url);
    expect(chain.programId).toBe(server.net.programId);
    expect(await chain.now()).toBe(BigInt(Date.parse("2026-11-06T09:00:00Z") / 1000));
    await chain.advanceClock(3600);
    expect(await chain.now()).toBe(BigInt(Date.parse("2026-11-06T10:00:00Z") / 1000));
  });

  it("runs a whole escrow through RPC: faucet, token accounts, open, resolve, and named errors", async () => {
    server = await startChainServer({ port: 0 });
    const chain = await Chain.connect(server.url);
    const issuer = await server.net.funded();
    const mint = await server.net.createMint(issuer);
    const [payer, payee, arbiter] = await Promise.all([randomPaymentKey(), randomPaymentKey(), randomPaymentKey()]);
    const sponsor = await generateKeyPairSigner();
    for (const k of [payer.address, payee.address, sponsor.address]) await chain.airdrop(k, 1n);
    const payerToken = await chain.createTokenAccount(mint, payer.address, payer.signer, await generateKeyPairSigner());
    const payeeToken = await chain.createTokenAccount(mint, payee.address, payee.signer, await generateKeyPairSigner());
    const feeToken = await chain.createTokenAccount(mint, sponsor.address, sponsor, await generateKeyPairSigner());
    await server.net.mintTo(mint, payerToken, issuer, USDC(343.4));
    expect(await chain.balance(payerToken)).toBe(USDC(343.4));

    const termsHash = crypto.getRandomValues(new Uint8Array(32));
    const opened = await chain.send(sponsor, [
      await openInstruction({ programId: chain.programId, payer: payer.signer, rentPayer: sponsor, payerToken, mint, feeAccount: feeToken, termsHash, amount: USDC(340), fee: USDC(3.4), payee: payee.address, arbiter: arbiter.address, threshold: 2, feeBps: 100, refundAfter: (await chain.now()) + 86400n }),
    ]);
    expect(opened.ok).toBe(true);
    const escrow = await escrowAddress(chain.programId, termsHash);
    expect((await chain.escrow(escrow))!.amount).toBe(USDC(340));

    const evidence = new Uint8Array(32).fill(1);
    const msg = outcomeMessage(chain.programId, escrow, USDC(340), evidence);
    const resolve = await resolveInstruction({ programId: chain.programId, escrow, payeeToken, payerToken, feeToken, rentPayer: sponsor.address, payeeAmount: USDC(340), evidenceHash: evidence });
    const lonely = await chain.send(sponsor, [ed25519Instruction(payee.publicKey, payee.sign(msg), msg), resolve]);
    expect(lonely).toMatchObject({ ok: false, name: "NoQuorum" });
    const both = await chain.send(sponsor, [ed25519Instruction(payee.publicKey, payee.sign(msg), msg), ed25519Instruction(payer.publicKey, payer.sign(msg), msg), resolve]);
    expect(both.ok).toBe(true);
    expect(await chain.balance(payeeToken)).toBe(USDC(340));
    expect(await chain.balance(feeToken)).toBe(USDC(3.4));
  });
});
