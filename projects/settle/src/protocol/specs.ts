import { ourSpec } from "@zk-toip/trust-core";

/**
 * Settle's Trust Task types (design §7), proposed for the registry. Until then they live in our namespace:
 * https://zk-toip.example/spec/settle/<name>/0.1
 */
export const PAYMENT_REQUEST = ourSpec("settle/payment/request");
export const TERMS_PROPOSE = ourSpec("settle/payment/terms/propose");
export const TERMS_ACCEPT = ourSpec("settle/payment/terms/accept");
export const ESCROW_OPENED = ourSpec("settle/escrow/opened");
export const ESCROW_ATTEST = ourSpec("settle/escrow/attest");
export const ESCROW_SIGN = ourSpec("settle/escrow/sign");
export const ESCROW_DISPUTE = ourSpec("settle/escrow/dispute");
export const ARBITER_RULING = ourSpec("settle/arbiter/ruling");
export const ESCROW_SETTLED = ourSpec("settle/escrow/settled");
/** The arbiter's signed hold, so a disputed escrow can't be reclaimed before a ruling (sent to the processor to submit). */
export const ESCROW_HOLD = ourSpec("settle/escrow/hold");
export const PAYMENT_RECEIPT = ourSpec("settle/payment/receipt");
/** Request/response: a partially signed transaction the processor co-signs as fee payer and submits. */
export const PROCESSOR_SUBMIT = ourSpec("settle/processor/submit");
/** Request/response: the processor's transparency log. */
export const PROCESSOR_LOG = ourSpec("settle/processor/log");
/** A payer opening a payment link asks the payee for an invoice under the link's conditions. */
export const CHECKOUT_START = ourSpec("settle/checkout/start");
