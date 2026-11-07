/**
 * The demo's cast (design §17). Every key comes from a fixed seed, so the door and the guest agree on
 * who is who across processes and machines without exchanging files. This is a demo, not key management:
 * anyone who reads this file has every key.
 */
import { identityFromSeed, seedFrom, type Identity } from "@zk-toip/trust-core";

export const CAST = {
  building: "the Building",
  rosa: "Rosa",
  door: "Front Door",
  eve: "a listener",
  alice: "Alice",
  ridge: "the Ridge",
  lodge: "the Lodge",
  landlord: "the landlord's agent",
  joe: "Joe's agent",
  arbiter: "Settle Arbitration",
  neighbor: "the neighbor",
  relay: "TSP relay",
} as const;

export type CastName = keyof typeof CAST;

const cache = new Map<string, Identity>();

/** A cast member's identity. Rosa's is the pass key made for her pass, not a personal identity. */
export function member(name: CastName | string): Identity {
  let id = cache.get(name);
  if (!id) {
    id = identityFromSeed(seedFrom(`zk-toip/mesh-demo/${name}/v1`));
    cache.set(name, id);
  }
  return id;
}

export const nameOf = (did: string): string => {
  for (const k of Object.keys(CAST) as CastName[]) if (member(k).did === did) return CAST[k];
  return `${did.slice(0, 14)}…${did.slice(-4)}`;
};
