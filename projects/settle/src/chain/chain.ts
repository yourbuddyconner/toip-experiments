/**
 * The chain as every Settle party sees it: a Solana JSON-RPC endpoint. Works in browsers and Node,
 * against the local simnet (rpcServer.ts), devnet or mainnet.
 */
import {
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Base64EncodedWireTransaction,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import { getInitializeAccount3Instruction, getTransferInstruction } from "@solana-program/token";
import { decodeEscrow, ERRORS, TOKEN_PROGRAM, type EscrowState } from "./escrow";

export type ChainResult = { ok: true; signature: string } | { ok: false; error: string; code?: number; name?: string; logs?: string[] };

const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const tokenAmount = (data: Uint8Array): bigint => new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true);

export class Chain {
  readonly rpc: ReturnType<typeof createSolanaRpc>;

  private constructor(
    readonly url: string,
    readonly programId: Address,
  ) {
    this.rpc = createSolanaRpc(url);
  }

  /** Connects to an RPC endpoint. On the local simnet the program id comes from the node; elsewhere pass it. */
  static async connect(url: string, programId?: Address): Promise<Chain> {
    if (programId) return new Chain(url, programId);
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "settle_info" }) });
    const { result } = (await res.json()) as { result: { programId: Address } };
    return new Chain(url, result.programId);
  }

  async latestBlockhash() {
    return (await this.rpc.getLatestBlockhash().send()).value;
  }

  async account(addr: Address): Promise<Uint8Array | null> {
    const r = await this.rpc.getAccountInfo(addr, { encoding: "base64" }).send();
    return r.value ? fromB64(r.value.data[0]) : null;
  }

  async exists(addr: Address): Promise<boolean> {
    return (await this.account(addr)) !== null;
  }

  async escrow(addr: Address): Promise<EscrowState | null> {
    const d = await this.account(addr);
    return d ? decodeEscrow(d) : null;
  }

  async balance(tokenAccount: Address): Promise<bigint> {
    const d = await this.account(tokenAccount);
    return d ? tokenAmount(d) : 0n;
  }

  async lamports(addr: Address): Promise<bigint> {
    return BigInt((await this.rpc.getBalance(addr).send()).value);
  }

  /** The chain's own clock, in unix seconds. Policies use it, so every party agrees what time it is. */
  async now(): Promise<bigint> {
    const slot = await this.rpc.getSlot().send();
    return BigInt((await this.rpc.getBlockTime(slot).send()) ?? 0);
  }

  async sendWire(wire: string): Promise<ChainResult> {
    try {
      const signature = await this.rpc.sendTransaction(wire as Base64EncodedWireTransaction, { encoding: "base64" }).send();
      return { ok: true, signature };
    } catch (e) {
      const err = e as { message?: string; context?: { __serverMessage?: string; logs?: string[] }; cause?: unknown };
      const text = [err.message, err.context?.__serverMessage, JSON.stringify(err.context ?? {})].filter(Boolean).join(" ");
      const dec = /Custom\((\d+)\)/.exec(text);
      const hexed = /custom program error: 0x([0-9a-f]+)/i.exec(text);
      const code = dec ? Number(dec[1]) : hexed ? parseInt(hexed[1], 16) : undefined;
      return { ok: false, error: text, code, name: code !== undefined ? ERRORS[code] : undefined, logs: err.context?.logs };
    }
  }

  /** Builds, signs with every signer the instructions name, and sends. */
  async send(feePayer: TransactionSigner, instructions: Instruction[]): Promise<ChainResult> {
    const bh = await this.latestBlockhash();
    const tx = await pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
      (m) => signTransactionMessageWithSigners(m),
    );
    return this.sendWire(getBase64EncodedWireTransaction(tx));
  }

  /** Test SOL from the cluster's faucet (simnet and devnet). */
  async airdrop(addr: Address, sol = 1n): Promise<void> {
    await this.raw("requestAirdrop", [addr, Number(sol * 1_000_000_000n)]);
  }

  private async raw(method: string, params: unknown[] = []): Promise<unknown> {
    const res = await fetch(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const body = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    return body.result;
  }

  async createTokenAccount(mint: Address, owner: Address, payer: TransactionSigner, account: TransactionSigner): Promise<Address> {
    const rent = await this.rpc.getMinimumBalanceForRentExemption(165n).send();
    const r = await this.send(payer, [
      getCreateAccountInstruction({ payer, newAccount: account, lamports: rent, space: 165, programAddress: TOKEN_PROGRAM }),
      getInitializeAccount3Instruction({ account: account.address, mint, owner }),
    ]);
    if (!r.ok) throw new Error(`couldn't create a token account: ${r.error}`);
    return account.address;
  }

  async transfer(from: Address, to: Address, owner: TransactionSigner, amount: bigint): Promise<ChainResult> {
    return this.send(owner, [getTransferInstruction({ source: from, destination: to, authority: owner, amount })]);
  }

  /** Development only: moves the simnet's clock forward. */
  async advanceClock(seconds: number): Promise<void> {
    await this.raw("settle_advanceClock", [seconds]);
  }
}
