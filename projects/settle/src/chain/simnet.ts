/**
 * A local Solana chain in-process, using LiteSVM, with the Settle escrow program loaded.
 * Real SBF bytecode, real SPL Token, real Ed25519 precompile, a clock we can move.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  generateKeyPairSigner,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type TransactionSigner,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import { getInitializeAccount3Instruction, getInitializeMint2Instruction, getMintToInstruction } from "@solana-program/token";
import { Clock, FailedTransactionMetadata, LiteSVM } from "litesvm";
import { decodeEscrow, ERRORS, TOKEN_PROGRAM, type EscrowState } from "./escrow";

export const PROGRAM_DIR = join(import.meta.dirname, "..", "..", "program");
/** The compiled program, committed so the TypeScript side runs without the Solana toolchain (`npm run build:program` rebuilds it). */
export const PROGRAM_SO = join(PROGRAM_DIR, "dist", "settle_escrow.so");
/** A development deploy keypair, so the program has the same address everywhere. Local and devnet use only. */
export const PROGRAM_KEYPAIR = join(PROGRAM_DIR, "keys", "settle_escrow-keypair.json");

export type SendResult = { ok: true; logs: string[] } | { ok: false; error: string; code?: number; name?: string; logs: string[] };

/** Reads an SPL token account's balance from its raw data. */
export const tokenAmount = (data: Uint8Array): bigint => new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true);

export class Simnet {
  private constructor(
    readonly svm: LiteSVM,
    readonly programId: Address,
  ) {}

  static async create(opts: { svm?: LiteSVM } = {}): Promise<Simnet> {
    const svm = (opts.svm ?? new LiteSVM()).withPrecompiles();
    const programKey = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(PROGRAM_KEYPAIR, "utf8"))));
    svm.addProgramFromFile(programKey.address, PROGRAM_SO);
    return new Simnet(svm, programKey.address);
  }

  /** A new key with SOL for fees. */
  async funded(sol = 10n): Promise<KeyPairSigner> {
    const k = await generateKeyPairSigner();
    this.airdrop(k.address, sol);
    return k;
  }

  airdrop(to: Address, sol = 10n): void {
    this.svm.airdrop(to, lamports(sol * 1_000_000_000n));
  }

  async send(feePayer: TransactionSigner, instructions: Instruction[]): Promise<SendResult> {
    const tx = await pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(feePayer, m),
      (m) => this.svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
      (m) => appendTransactionMessageInstructions(instructions, m),
      (m) => signTransactionMessageWithSigners(m),
    );
    const r = this.svm.sendTransaction(tx);
    this.svm.expireBlockhash(); // so an identical transaction later isn't refused as a duplicate
    if (r instanceof FailedTransactionMetadata) {
      const logs = r.meta().logs();
      const text = r.toString();
      const custom = /Custom\((\d+)\)/.exec(text) ?? /custom program error: 0x([0-9a-f]+)/i.exec(logs.join("\n"));
      const code = custom ? (custom[0].startsWith("Custom") ? Number(custom[1]) : parseInt(custom[1], 16)) : undefined;
      return { ok: false, error: text, code, name: code !== undefined ? ERRORS[code] : undefined, logs };
    }
    return { ok: true, logs: r.logs() };
  }

  private async mustSend(feePayer: TransactionSigner, ixs: Instruction[]): Promise<void> {
    const r = await this.send(feePayer, ixs);
    if (!r.ok) throw new Error(`${r.error}\n${r.logs.join("\n")}`);
  }

  /** A token mint, like devnet USDC: 6 decimals. */
  async createMint(authority: TransactionSigner, decimals = 6): Promise<Address> {
    const mint = await generateKeyPairSigner();
    await this.mustSend(authority, [
      getCreateAccountInstruction({ payer: authority, newAccount: mint, lamports: lamports(this.svm.minimumBalanceForRentExemption(82n)), space: 82, programAddress: TOKEN_PROGRAM }),
      getInitializeMint2Instruction({ mint: mint.address, decimals, mintAuthority: authority.address }),
    ]);
    return mint.address;
  }

  /** A token account for `owner`, paid for by `payer`. */
  async createTokenAccount(mint: Address, owner: Address, payer: TransactionSigner): Promise<Address> {
    const acct = await generateKeyPairSigner();
    await this.mustSend(payer, [
      getCreateAccountInstruction({ payer, newAccount: acct, lamports: lamports(this.svm.minimumBalanceForRentExemption(165n)), space: 165, programAddress: TOKEN_PROGRAM }),
      getInitializeAccount3Instruction({ account: acct.address, mint, owner }),
    ]);
    return acct.address;
  }

  async mintTo(mint: Address, to: Address, authority: TransactionSigner, amount: bigint): Promise<void> {
    await this.mustSend(authority, [getMintToInstruction({ mint, token: to, mintAuthority: authority, amount })]);
  }

  balance(tokenAccount: Address): bigint {
    const a = this.svm.getAccount(tokenAccount);
    return a.exists ? tokenAmount(a.data) : 0n;
  }

  exists(addr: Address): boolean {
    return this.svm.getAccount(addr).exists;
  }

  escrow(addr: Address): EscrowState | null {
    const a = this.svm.getAccount(addr);
    return a.exists ? decodeEscrow(a.data) : null;
  }

  now(): bigint {
    return this.svm.getClock().unixTimestamp;
  }

  setNow(unixSeconds: bigint): void {
    const c = this.svm.getClock();
    this.svm.setClock(new Clock(c.slot + 1n, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, unixSeconds));
  }
}
