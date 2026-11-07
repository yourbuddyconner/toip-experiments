/**
 * The member's wallet (design §5.1): any employee's own wallet, not Tipline's. It makes the member
 * secret from its own seed, enrolls the commitment with the organization over TSP, checks the leaf
 * is in a published root, and shows the membership code the source app takes.
 *
 * The organization never holds the secret: only the commitment leaves the wallet.
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import {
  checkRootLog,
  commitmentOf,
  encodeMembershipCode,
  enroll,
  fieldToHex,
  groupFieldOf,
  leafHash,
  memberSecret,
  plainLeaf,
  treeFromRoot,
  type Enrollment,
  type Field,
} from "@zk-toip/anon-membership";
import type { Clock, Endpoint } from "@zk-toip/trust-core";
import type { Fetcher } from "./logs";

/** The wallet's group secrets come from its seed, never from the organization. */
export function walletSecret(walletSeed: Uint8Array, groupId: string): Field {
  return memberSecret(hmac(sha256, walletSeed, utf8ToBytes("wallet/v1/groups")), groupId);
}

export function membershipCode(walletSeed: Uint8Array, groupId: string): string {
  return encodeMembershipCode(walletSecret(walletSeed, groupId), groupId);
}

export function walletCommitment(walletSeed: Uint8Array, groupId: string): string {
  return fieldToHex(commitmentOf(walletSecret(walletSeed, groupId), groupFieldOf(groupId)));
}

export function enrollWallet(endpoint: Endpoint, issuerDid: string, groupId: string, walletSeed: Uint8Array): Promise<Enrollment> {
  return enroll(endpoint, issuerDid, groupId, walletSecret(walletSeed, groupId));
}

export type MembershipCheck =
  | { state: "in"; epoch: string; size: number; index: number }
  | { state: "pending"; latest?: string; size?: number }
  | { state: "removed"; epoch: string; lastSeen?: string }
  | { state: "error"; why: string };

/**
 * Looks for the wallet's leaf in the newest published root. "pending" means no root holds it yet;
 * "removed" means an earlier root held it and the newest doesn't.
 */
export async function checkMembership(o: {
  walletSeed: Uint8Array;
  groupId: string;
  issuer: string;
  logUrl: string;
  snapshotUrl: (epoch: string) => string;
  fetcher: Fetcher;
  clock: Clock;
}): Promise<MembershipCheck> {
  try {
    const log = (await o.fetcher.json(o.logUrl)) as Parameters<typeof checkRootLog>[0];
    if (!Array.isArray(log) || log.length === 0) return { state: "pending" };
    const c = await checkRootLog(log, o.issuer, o.clock);
    if (!c.ok) return { state: "error", why: `the organization's root log doesn't check out (${c.reason})` };
    const leaf = leafHash(plainLeaf(commitmentOf(walletSecret(o.walletSeed, o.groupId), groupFieldOf(o.groupId))));
    const tree = treeFromRoot(c.head, await o.fetcher.bytes(o.snapshotUrl(c.head.epoch)));
    const index = tree.indexOf(leaf);
    if (index >= 0) return { state: "in", epoch: c.head.epoch, size: c.head.size, index };
    for (const doc of log.slice(0, -1).reverse().slice(0, 8)) {
      try {
        const t = treeFromRoot(doc, await o.fetcher.bytes(o.snapshotUrl(doc.epoch)));
        if (t.indexOf(leaf) >= 0) return { state: "removed", epoch: c.head.epoch, lastSeen: doc.epoch };
      } catch {
        // older snapshots may be gone
      }
    }
    return { state: "pending", latest: c.head.epoch, size: c.head.size };
  } catch (e) {
    return { state: "error", why: e instanceof Error ? e.message : String(e) };
  }
}
