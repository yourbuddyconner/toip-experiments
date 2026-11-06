/**
 * Client for the Settle escrow program (program/src/lib.rs): addresses, instruction encoding,
 * the Ed25519 precompile instructions that carry signers' approvals, and decoding escrow state.
 */
import {
  AccountRole,
  address,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import { utf8 } from "@zk-toip/trust-core";

export const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
export const ED25519_PROGRAM = address("Ed25519SigVerify111111111111111111111111111");
export const INSTRUCTIONS_SYSVAR = address("Sysvar1nstructions1111111111111111111111111");

export const STATE = { funded: 1, resolved: 2, reclaimed: 3 } as const;
export const ERRORS: Record<number, string> = {
  1: "BadInstruction",
  2: "BadAccount",
  3: "NotFunded",
  4: "NoQuorum",
  5: "TooEarly",
  6: "BadAmount",
  7: "WrongTokenAccount",
};

const enc = getAddressEncoder();
const dec = getAddressDecoder();
export const addressBytes = (a: Address): Uint8Array => new Uint8Array(enc.encode(a));
export const bytesAddress = (b: Uint8Array): Address => dec.decode(b);

const u64 = (n: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
};
const i64 = (n: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, n, true);
  return b;
};
const u16 = (n: number) => new Uint8Array([n & 0xff, (n >> 8) & 0xff]);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export async function escrowAddress(programId: Address, termsHash: Uint8Array): Promise<Address> {
  const [a] = await getProgramDerivedAddress({ programAddress: programId, seeds: [utf8("escrow"), termsHash] });
  return a;
}

export async function vaultAddress(programId: Address, escrow: Address): Promise<Address> {
  const [a] = await getProgramDerivedAddress({ programAddress: programId, seeds: [utf8("vault"), addressBytes(escrow)] });
  return a;
}

/** The exact text a signer signs to approve paying `payeeAmount` to the payee and the rest back to the payer. */
export function outcomeMessage(programId: Address, escrow: Address, payeeAmount: bigint, evidenceHash: Uint8Array): Uint8Array {
  return utf8(`settle/v1|${programId}|${escrow}|pay:${payeeAmount}|evidence:${hex(evidenceHash)}`);
}

export interface OpenParams {
  programId: Address;
  payer: TransactionSigner;
  rentPayer: TransactionSigner;
  payerToken: Address;
  mint: Address;
  feeAccount: Address;
  termsHash: Uint8Array;
  amount: bigint;
  payee: Address;
  arbiter: Address;
  threshold: number;
  feeBps: number;
  refundAfter: bigint;
}

export async function openInstruction(p: OpenParams): Promise<Instruction> {
  const escrow = await escrowAddress(p.programId, p.termsHash);
  const vault = await vaultAddress(p.programId, escrow);
  return {
    programAddress: p.programId,
    accounts: [
      { address: p.payer.address, role: AccountRole.READONLY_SIGNER, signer: p.payer },
      { address: p.rentPayer.address, role: AccountRole.WRITABLE_SIGNER, signer: p.rentPayer },
      { address: escrow, role: AccountRole.WRITABLE },
      { address: vault, role: AccountRole.WRITABLE },
      { address: p.payerToken, role: AccountRole.WRITABLE },
      { address: p.mint, role: AccountRole.READONLY },
      { address: p.feeAccount, role: AccountRole.READONLY },
      { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    ],
    data: concat(
      new Uint8Array([0]),
      p.termsHash,
      u64(p.amount),
      addressBytes(p.payee),
      addressBytes(p.arbiter),
      new Uint8Array([p.threshold]),
      u16(p.feeBps),
      i64(p.refundAfter),
    ),
  } as Instruction;
}

export interface ResolveParams {
  programId: Address;
  escrow: Address;
  payeeToken: Address;
  payerToken: Address;
  feeToken: Address;
  rentPayer: Address;
  payeeAmount: bigint;
  evidenceHash: Uint8Array;
}

export async function resolveInstruction(p: ResolveParams): Promise<Instruction> {
  const vault = await vaultAddress(p.programId, p.escrow);
  return {
    programAddress: p.programId,
    accounts: [
      { address: p.escrow, role: AccountRole.WRITABLE },
      { address: vault, role: AccountRole.WRITABLE },
      { address: p.payeeToken, role: AccountRole.WRITABLE },
      { address: p.payerToken, role: AccountRole.WRITABLE },
      { address: p.feeToken, role: AccountRole.WRITABLE },
      { address: p.rentPayer, role: AccountRole.WRITABLE },
      { address: INSTRUCTIONS_SYSVAR, role: AccountRole.READONLY },
      { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
    ],
    data: concat(new Uint8Array([1]), u64(p.payeeAmount), p.evidenceHash),
  } as Instruction;
}

export async function reclaimInstruction(p: { programId: Address; payer: TransactionSigner; escrow: Address; payerToken: Address; rentPayer: Address }): Promise<Instruction> {
  const vault = await vaultAddress(p.programId, p.escrow);
  return {
    programAddress: p.programId,
    accounts: [
      { address: p.payer.address, role: AccountRole.READONLY_SIGNER, signer: p.payer },
      { address: p.escrow, role: AccountRole.WRITABLE },
      { address: vault, role: AccountRole.WRITABLE },
      { address: p.payerToken, role: AccountRole.WRITABLE },
      { address: p.rentPayer, role: AccountRole.WRITABLE },
      { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
    ],
    data: new Uint8Array([2]),
  } as Instruction;
}

/**
 * An Ed25519 precompile instruction carrying one signature over `message`. The precompile fails the
 * whole transaction if the signature is bad; the escrow program then reads which keys signed what.
 */
export function ed25519Instruction(publicKey: Uint8Array, signature: Uint8Array, message: Uint8Array): Instruction {
  const HEADER = 2 + 14;
  const pkOff = HEADER;
  const sigOff = pkOff + 32;
  const msgOff = sigOff + 64;
  const SAME = 0xffff;
  const data = concat(
    new Uint8Array([1, 0]),
    u16(sigOff),
    u16(SAME),
    u16(pkOff),
    u16(SAME),
    u16(msgOff),
    u16(message.length),
    u16(SAME),
    publicKey,
    signature,
    message,
  );
  return { programAddress: ED25519_PROGRAM, accounts: [], data } as Instruction;
}

export interface EscrowState {
  state: number;
  threshold: number;
  feeBps: number;
  termsHash: Uint8Array;
  mint: Address;
  amount: bigint;
  payer: Address;
  payee: Address;
  arbiter: Address;
  feeAccount: Address;
  rentPayer: Address;
  refundAfter: bigint;
  payeePaid: bigint;
  evidenceHash: Uint8Array;
}

export function decodeEscrow(d: Uint8Array): EscrowState {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const a = (o: number) => bytesAddress(d.slice(o, o + 32));
  return {
    state: d[0],
    threshold: d[3],
    feeBps: v.getUint16(4, true),
    termsHash: d.slice(6, 38),
    mint: a(38),
    amount: v.getBigUint64(70, true),
    payer: a(78),
    payee: a(110),
    arbiter: a(142),
    feeAccount: a(174),
    rentPayer: a(206),
    refundAfter: v.getBigInt64(238, true),
    payeePaid: v.getBigUint64(246, true),
    evidenceHash: d.slice(254, 286),
  };
}
