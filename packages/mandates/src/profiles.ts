import { canonicalJson } from "@zk-toip/trust-core";
import type { Profile } from "./types";

/** The Settle action vocabulary (agents design §7.4). Every action also has `spend`. */
export const SETTLE_1: Profile = {
  id: "settle/1",
  actions: {
    "settle/pay": {
      required: ["asset", "price", "counterparty", "counterpartyCredentials", "category", "attester", "arbiter", "disputeWindowSeconds", "link", "job", "purpose", "task"],
    },
    "settle/get-paid": { required: ["price", "counterparty", "category", "attester", "task"] },
    "settle/attest": { required: ["payment", "claim", "counterparty", "task"] },
    "settle/dispute": { required: ["payment", "counterparty", "task"] },
    "settle/refund": { required: ["payment", "counterparty", "task"] },
    "agents/job/offer": { required: ["counterparty", "category", "price", "task"] },
    "agents/job/deliver": { required: ["counterparty", "job", "task"] },
    "mandates/delegate": { required: ["counterparty", "child", "asset", "task"] },
  },
  // No spend limit means no spending: a root must name the asset and set a budget.
  rootRequires: ["type", "asset", "spend:budget"],
};

/**
 * Owner-to-device delegation for projects/capture (agents design §16.3). A device signs media or
 * sensor readings for its owner. `media` is the hash of what is signed; `spend` is "0".
 * Location is the owner's claim, not something the device proves (capture decisions).
 */
export const CAPTURE_1: Profile = {
  id: "capture/1",
  actions: {
    "capture/sign-media": { required: ["device", "media", "mediaType"] },
    "capture/sign-reading": { required: ["device", "media", "quantity"] },
  },
  rootRequires: ["type"],
};

const registry = new Map<string, Profile>([
  [SETTLE_1.id, SETTLE_1],
  [CAPTURE_1.id, CAPTURE_1],
]);

/** Adds an action vocabulary. Registering the same definition twice is fine; a different one under a known id is refused. */
export function registerProfile(p: Profile): void {
  const known = registry.get(p.id);
  if (known) {
    if (canonicalJson(known) === canonicalJson(p)) return;
    throw new Error(`profile ${p.id} is already registered with a different definition`);
  }
  registry.set(p.id, p);
}

export function getProfile(id: string): Profile | undefined {
  return registry.get(id);
}
