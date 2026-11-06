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
import { getCreateAccountInstruction, getTransferSolInstruction } from "@solana-program/system";
import { getInitializeAccount3Instruction, getInitializeMint2Instruction, getMintToInstruction, getTransferInstruction } from "@solana-program/token";
import { decodeEscrow, ERRORS, TOKEN_PROGRAM, VERSION, type EscrowState } from "./escrow";

export type ChainResult = { ok: true; signature: string } | { ok: false; error: string; code?: number; name?: string; logs?: string[] };

/** Reads and confirmations use "confirmed": recent enough to act on, and what a transaction we just sent waits for. */
const COMMITMENT = "confirmed" as const;
const CLOCK_SYSVAR = "SysvarC1ock11111111111111111111111111111111" as Address;
/** How long to wait for a sent transaction to be confirmed before giving up on it. */
const CONFIRM_TIMEOUT_MS = 90_000;

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
    return (await this.rpc.getLatestBlockhash({ commitment: COMMITMENT }).send()).value;
  }

  async account(addr: Address): Promise<Uint8Array | null> {
    const r = await this.rpc.getAccountInfo(addr, { encoding: "base64", commitment: COMMITMENT }).send();
    return r.value ? fromB64(r.value.data[0]) : null;
  }

  async exists(addr: Address): Promise<boolean> {
    return (await this.account(addr)) !== null;
  }

  /** A Settle escrow, only if the account really belongs to the Settle program and has the current layout. */
  async escrow(addr: Address): Promise<EscrowState | null> {
    const r = await this.rpc.getAccountInfo(addr, { encoding: "base64", commitment: COMMITMENT }).send();
    if (!r.value || r.value.owner !== this.programId) return null;
    const d = fromB64(r.value.data[0]);
    if (d.length < 320 || d[0] !== VERSION) return null;
    return decodeEscrow(d);
  }

  async balance(tokenAccount: Address): Promise<bigint> {
    const d = await this.account(tokenAccount);
    return d ? tokenAmount(d) : 0n;
  }

  async lamports(addr: Address): Promise<bigint> {
    return BigInt((await this.rpc.getBalance(addr, { commitment: COMMITMENT }).send()).value);
  }

  /**
   * The chain's own clock, in unix seconds: the Clock sysvar, which is what the program itself reads.
   * Policies use it, so every party agrees what time it is.
   */
  async now(): Promise<bigint> {
    const d = await this.account(CLOCK_SYSVAR);
    if (d && d.length >= 40) return new DataView(d.buffer, d.byteOffset, d.byteLength).getBigInt64(32, true);
    const slot = await this.rpc.getSlot({ commitment: COMMITMENT }).send();
    return BigInt((await this.rpc.getBlockTime(slot).send()) ?? 0);
  }

  /** Sends a signed transaction and waits until the cluster confirms it, so what follows reads its effects. */
  async sendWire(wire: string): Promise<ChainResult> {
    let signature: string;
    try {
      signature = await this.rpc.sendTransaction(wire as Base64EncodedWireTransaction, { encoding: "base64", preflightCommitment: COMMITMENT }).send();
    } catch (e) {
      return Chain.failure(e);
    }
    return this.confirm(signature);
  }

  /** Waits for a signature to reach "confirmed". A transaction that never lands within the timeout counts as failed. */
  async confirm(signature: string, timeoutMs = CONFIRM_TIMEOUT_MS): Promise<ChainResult> {
    const end = Date.now() + timeoutMs;
    for (let delay = 0; ; delay = Math.min(1000, delay + 250)) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      const status = await this.status(signature);
      if (status?.err) return Chain.failure({ message: `Transaction failed: ${JSON.stringify(status.err, (_, v) => (typeof v === "bigint" ? Number(v) : v))}` });
      if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) return { ok: true, signature };
      if (Date.now() > end) return { ok: false, error: `transaction ${signature} wasn't confirmed in time` };
    }
  }

  /** A failed send, with the program's error code and name when there is one (from a simulation, a node, or a confirmed failure). */
  private async status(signature: string): Promise<{ err: unknown; confirmationStatus?: string | null } | null> {
    try {
      const r = await this.rpc.getSignatureStatuses([signature as Parameters<typeof this.rpc.getSignatureStatuses>[0][number]]).send();
      return (r.value[0] ?? null) as { err: unknown; confirmationStatus?: string | null } | null;
    } catch {
      return null; // a flaky RPC node: the caller tries again until its timeout
    }
  }

  private static failure(e: unknown): ChainResult & { ok: false } {
    const err = e as { message?: string; context?: { __serverMessage?: string; logs?: string[] }; cause?: unknown };
    const json = (v: unknown) => JSON.stringify(v ?? {}, (_, x) => (typeof x === "bigint" ? Number(x) : x));
    const text = [err.message, err.context?.__serverMessage, json(err.context)].filter(Boolean).join(" ");
    const dec = /Custom\((\d+)\)/.exec(text) ?? /"Custom":\s*(\d+)/.exec(text);
    const hexed = /custom program error: 0x([0-9a-f]+)/i.exec(text);
    const code = dec ? Number(dec[1]) : hexed ? parseInt(hexed[1], 16) : undefined;
    return { ok: false, error: text, code, name: code !== undefined ? ERRORS[code] : undefined, logs: err.context?.logs };
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

  /** Test SOL from the cluster's faucet (simnet and devnet), confirmed. */
  async airdrop(addr: Address, sol = 1n): Promise<void> {
    await this.airdropLamports(addr, sol * 1_000_000_000n);
  }

  async airdropLamports(addr: Address, lamports: bigint): Promise<void> {
    const signature = (await this.raw("requestAirdrop", [addr, Number(lamports), { commitment: COMMITMENT }])) as string;
    const r = await this.confirm(signature);
    if (!r.ok) throw new Error(`airdrop failed: ${r.error}`);
  }

  /** Moves SOL, for rent and network fees. */
  async transferSol(from: TransactionSigner, to: Address, lamports: bigint): Promise<ChainResult> {
    return this.send(from, [getTransferSolInstruction({ source: from, destination: to, amount: lamports })]);
  }

  private rentCache = new Map<number, bigint>();
  async rent(bytes: number): Promise<bigint> {
    let r = this.rentCache.get(bytes);
    if (r === undefined) this.rentCache.set(bytes, (r = BigInt(await this.rpc.getMinimumBalanceForRentExemption(BigInt(bytes)).send())));
    return r;
  }

  private async raw(method: string, params: unknown[] = []): Promise<unknown> {
    const res = await fetch(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const body = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    return body.result;
  }

  async createTokenAccount(mint: Address, owner: Address, payer: TransactionSigner, account: TransactionSigner): Promise<Address> {
    const r = await this.send(payer, [
      getCreateAccountInstruction({ payer, newAccount: account, lamports: await this.rent(165), space: 165, programAddress: TOKEN_PROGRAM }),
      getInitializeAccount3Instruction({ account: account.address, mint, owner }),
    ]);
    if (!r.ok) throw new Error(`couldn't create a token account: ${r.error}`);
    return account.address;
  }

  /** A token mint with 6 decimals, like USDC, whose authority can mint more. */
  async createMint(payer: TransactionSigner, mint: TransactionSigner, authority: Address, decimals = 6): Promise<Address> {
    const r = await this.send(payer, [
      getCreateAccountInstruction({ payer, newAccount: mint, lamports: await this.rent(82), space: 82, programAddress: TOKEN_PROGRAM }),
      getInitializeMint2Instruction({ mint: mint.address, decimals, mintAuthority: authority }),
    ]);
    if (!r.ok) throw new Error(`couldn't create the mint: ${r.error}`);
    return mint.address;
  }

  async mintTo(mint: Address, to: Address, authority: TransactionSigner, amount: bigint): Promise<ChainResult> {
    return this.send(authority, [getMintToInstruction({ mint, token: to, mintAuthority: authority, amount })]);
  }

  async transfer(from: Address, to: Address, owner: TransactionSigner, amount: bigint): Promise<ChainResult> {
    return this.send(owner, [getTransferInstruction({ source: from, destination: to, authority: owner, amount })]);
  }

  /** Development only: moves the simnet's clock forward. */
  async advanceClock(seconds: number): Promise<void> {
    await this.raw("settle_advanceClock", [seconds]);
  }
}
