/**
 * The chain as every Settle party sees it: a Solana JSON-RPC endpoint. Works in browsers and Node,
 * against the local simnet (rpcServer.ts), devnet or mainnet.
 */
import {
  appendTransactionMessageInstructions,
  createDefaultRpcTransport,
  createSolanaRpc,
  createSolanaRpcFromTransport,
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
/** How often an unconfirmed transaction is sent again: a busy cluster drops some, and nothing resends them for us. */
const RESEND_MS = 2_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * An RPC transport that waits and tries again when the node is rate-limiting (HTTP 429) or briefly unreachable,
 * as public endpoints such as api.devnet.solana.com often are. Every call is safe to repeat: reads, and sends of
 * a signed transaction (the cluster drops duplicates).
 */
/** How many RPC requests this process made, and how many it had to repeat because the node was busy. */
export const rpcStats = { requests: 0, retries: 0 };

function patientTransport(url: string) {
  const inner = createDefaultRpcTransport({ url });
  const transport = (async (req: Parameters<typeof inner>[0]) => {
    for (let attempt = 0; ; attempt++) {
      try {
        rpcStats.requests++;
        if (attempt) rpcStats.retries++;
        return await inner(req);
      } catch (e) {
        const status = (e as { context?: { statusCode?: number } }).context?.statusCode;
        const transient = status === 429 || (status !== undefined && status >= 500) || (status === undefined && e instanceof TypeError);
        // About a minute in all: public endpoints sometimes refuse a burst for that long.
        if (!transient || attempt >= 10) throw e;
        await sleep(Math.min(8000, 400 * 2 ** attempt) + Math.random() * 250);
      }
    }
  }) as typeof inner;
  return transport;
}

export interface ChainOptions {
  /**
   * How long a reading of the chain's clock is reused, counting on from it by the wall clock. Saves an RPC call
   * per question on a real cluster, where time only moves forward with the wall clock. Zero on a local cluster
   * whose clock can be skipped ahead.
   */
  clockCacheMs?: number;
}

const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const tokenAmount = (data: Uint8Array): bigint => new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true);

export class Chain {
  readonly rpc: ReturnType<typeof createSolanaRpc>;

  private clock?: { now: bigint; at: number };

  private constructor(
    readonly url: string,
    readonly programId: Address,
    private readonly opts: ChainOptions = {},
  ) {
    this.rpc = createSolanaRpcFromTransport(patientTransport(url)) as ReturnType<typeof createSolanaRpc>;
  }

  /** Connects to an RPC endpoint. On the local simnet the program id comes from the node; elsewhere pass it. */
  static async connect(url: string, programId?: Address, opts?: ChainOptions): Promise<Chain> {
    if (programId) return new Chain(url, programId, opts);
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "settle_info" }) });
    const { result } = (await res.json()) as { result: { programId: Address } };
    return new Chain(url, result.programId, opts);
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

  /** Many accounts in one call per hundred (getMultipleAccounts): each one's owner and data, or null if it doesn't exist. */
  async accounts(addrs: Address[]): Promise<({ owner: Address; data: Uint8Array } | null)[]> {
    const out: ({ owner: Address; data: Uint8Array } | null)[] = [];
    for (let i = 0; i < addrs.length; i += 100) {
      const r = await this.rpc.getMultipleAccounts(addrs.slice(i, i + 100), { encoding: "base64", commitment: COMMITMENT }).send();
      for (const v of r.value) out.push(v ? { owner: v.owner, data: fromB64(v.data[0]) } : null);
    }
    return out;
  }

  /** Decodes an account as a Settle escrow, only if it belongs to the Settle program and has the current layout. */
  asEscrow(a: { owner: Address; data: Uint8Array } | null): EscrowState | null {
    return a && a.owner === this.programId && a.data.length >= 320 && a.data[0] === VERSION ? decodeEscrow(a.data) : null;
  }

  /** Many escrows at once, for views that list them. Null where there's no Settle escrow. */
  async escrows(addrs: Address[]): Promise<(EscrowState | null)[]> {
    return (await this.accounts(addrs)).map((a) => this.asEscrow(a));
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
    const cache = this.opts.clockCacheMs ?? 0;
    if (cache > 0 && this.clock && Date.now() - this.clock.at < cache) return this.clock.now + BigInt(Math.floor((Date.now() - this.clock.at) / 1000));
    const now = await this.readClock();
    this.clock = { now, at: Date.now() };
    return now;
  }

  private async readClock(): Promise<bigint> {
    const d = await this.account(CLOCK_SYSVAR);
    if (d && d.length >= 40) return new DataView(d.buffer, d.byteOffset, d.byteLength).getBigInt64(32, true);
    const slot = await this.rpc.getSlot({ commitment: COMMITMENT }).send();
    return BigInt((await this.rpc.getBlockTime(slot).send()) ?? 0);
  }

  /**
   * Sends a signed transaction and waits until the cluster confirms it, so what follows reads its effects.
   * Until then it sends the same transaction again every few seconds: a busy cluster drops some.
   */
  async sendWire(wire: string): Promise<ChainResult> {
    let signature: string;
    try {
      signature = await this.rpc.sendTransaction(wire as Base64EncodedWireTransaction, { encoding: "base64", preflightCommitment: COMMITMENT }).send();
    } catch (e) {
      return Chain.failure(e);
    }
    return this.confirm(signature, CONFIRM_TIMEOUT_MS, wire);
  }

  /** Waits for a signature to reach "confirmed". A transaction that never lands within the timeout counts as failed. */
  async confirm(signature: string, timeoutMs = CONFIRM_TIMEOUT_MS, resend?: string): Promise<ChainResult> {
    const start = Date.now();
    let lastSent = start;
    for (let delay = 0; ; delay = Math.min(1000, delay + 250)) {
      if (delay) await sleep(delay);
      // Past the recent-status cache, only the transaction history knows about it.
      const status = await this.status(signature, Date.now() - start > 20_000);
      if (status?.err) return Chain.failure({ message: `Transaction failed: ${JSON.stringify(status.err, (_, v) => (typeof v === "bigint" ? Number(v) : v))}` });
      if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) return { ok: true, signature };
      if (Date.now() - start > timeoutMs) return { ok: false, error: `transaction ${signature} wasn't confirmed in time` };
      if (resend && !status && Date.now() - lastSent > RESEND_MS) {
        lastSent = Date.now();
        await this.rpc
          .sendTransaction(resend as Base64EncodedWireTransaction, { encoding: "base64", skipPreflight: true, maxRetries: 0n })
          .send()
          .catch(() => {}); // its status says what happened
      }
    }
  }

  private async status(signature: string, searchTransactionHistory = false): Promise<{ err: unknown; confirmationStatus?: string | null } | null> {
    try {
      const r = await this.rpc.getSignatureStatuses([signature as Parameters<typeof this.rpc.getSignatureStatuses>[0][number]], { searchTransactionHistory }).send();
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
    this.clock = undefined;
    await this.raw("settle_advanceClock", [seconds]);
  }
}
