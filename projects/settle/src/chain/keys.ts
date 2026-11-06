import { ed25519 } from "@noble/curves/ed25519.js";
import { createKeyPairSignerFromPrivateKeyBytes, type Address, type KeyPairSigner } from "@solana/kit";
import { bytesAddress } from "./escrow";

/** An Ed25519 key used for one payment: a Solana signer, and the signer of outcome messages. */
export interface PaymentKey {
  address: Address;
  publicKey: Uint8Array;
  signer: KeyPairSigner;
  sign(message: Uint8Array): Uint8Array;
}

export async function paymentKeyFromSeed(seed: Uint8Array): Promise<PaymentKey> {
  const secret = seed.slice(0, 32);
  const publicKey = ed25519.getPublicKey(secret);
  return {
    address: bytesAddress(publicKey),
    publicKey,
    signer: await createKeyPairSignerFromPrivateKeyBytes(secret),
    sign: (m) => ed25519.sign(m, secret),
  };
}

export const randomPaymentKey = () => paymentKeyFromSeed(crypto.getRandomValues(new Uint8Array(32)));
