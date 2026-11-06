/**
 * Fee sponsorship (design §3): a party builds a transaction with the processor as fee payer, signs its
 * own part, and hands the bytes to the processor, which checks what it would be paying for, co-signs
 * and submits. The processor never signs anything that moves a party's funds by itself.
 */
import {
  appendTransactionMessageInstructions,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayerSigner,
  signTransaction,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Transaction,
} from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { ED25519_PROGRAM } from "./escrow";
import type { Simnet } from "./simnet";

/** Builds a transaction paid for by `feePayer` and signs every part the caller holds keys for. */
export async function buildForSponsor(net: Simnet, feePayer: Address, instructions: Instruction[]): Promise<string> {
  const tx = await pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(createNoopSigner(feePayer), m),
    (m) => net.svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
    (m) => appendTransactionMessageInstructions(instructions, m),
    (m) => partiallySignTransactionMessageWithSigners(m),
  );
  return getBase64EncodedWireTransaction(tx);
}

export type Sponsored = { ok: true; signature: string } | { ok: false; error: string };

/**
 * The processor's side: decode, check it pays only for the Settle program (and signature checks),
 * co-sign as fee payer, submit.
 */
export async function cosignAndSubmit(net: Simnet, processor: KeyPairSigner, wire: string): Promise<Sponsored> {
  let tx: Transaction;
  try {
    tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire)) as Transaction;
  } catch {
    return { ok: false, error: "not a transaction" };
  }
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if (msg.staticAccounts[0] !== processor.address) return { ok: false, error: "the processor isn't the fee payer" };
  const allowed = new Set<string>([net.programId, ED25519_PROGRAM]);
  const instructions = (msg as { instructions?: { programAddressIndex: number }[] }).instructions;
  if (!Array.isArray(instructions)) return { ok: false, error: "unsupported transaction version" };
  for (const ix of instructions) {
    const program = msg.staticAccounts[ix.programAddressIndex];
    if (!allowed.has(program)) return { ok: false, error: `won't pay for program ${program}` };
  }
  const signed = await signTransaction([processor.keyPair], tx);
  const r = net.svm.sendTransaction(signed as Parameters<typeof net.svm.sendTransaction>[0]);
  net.svm.expireBlockhash();
  if (r instanceof FailedTransactionMetadata) return { ok: false, error: `${r.toString()}\n${r.meta().logs().join("\n")}` };
  return { ok: true, signature: getSignatureFromTransaction(signed) };
}
