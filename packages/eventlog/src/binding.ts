/** DID bindings: a did:key and an AID, each committing to the other (trail design §5.5, §7.6). */
import { canonicalJson, signDocument, verifyDocument, type Clock, type Identity } from "@toip-tools/trust-core";
import { digest } from "./cesr.js";
import { isDigestSeal, sealsOf, type KelResult } from "./kel.js";
import type { Problem, Qb64, Seal } from "./types.js";
import { problem } from "./types.js";

export interface DidBinding {
  type: "trail/did-binding";
  issuer: string;
  aid: Qb64;
  issuedAt: string;
  replaces?: Qb64;
  proof?: unknown;
}

export function makeBinding(identity: Identity, aid: Qb64, clock: Clock, replaces?: Qb64): DidBinding {
  const doc: DidBinding = { type: "trail/did-binding", issuer: identity.did, aid, issuedAt: clock.iso(), ...(replaces ? { replaces } : {}) };
  return signDocument(doc, identity, clock);
}

/** The binding's digest: Blake3-256 of JCS of the document with its proof. */
export function bindingDigest(b: DidBinding): Qb64 {
  return digest(canonicalJson(b));
}

export function bindingSeal(b: DidBinding): Seal {
  return { d: bindingDigest(b) };
}

export async function verifyBinding(
  b: DidBinding,
  kel: KelResult,
  clock: Clock,
  others: DidBinding[] = [],
): Promise<{ ok: boolean; sealedAt?: number; replacedAt?: number; problems: Problem[] }> {
  const problems: Problem[] = [];
  if (b.type !== "trail/did-binding") problems.push(problem("bindingInvalid", "not a DID binding"));
  if (b.aid !== kel.aid) problems.push(problem("bindingInvalid", "binding names another AID"));
  let proofOk = false;
  try {
    const r = await verifyDocument(b, clock);
    proofOk = (r as { valid?: boolean; ok?: boolean }).valid === true || (r as { ok?: boolean }).ok === true;
  } catch {
    proofOk = false;
  }
  if (!proofOk) problems.push(problem("bindingInvalid", "the binding's proof does not verify"));
  const d = bindingDigest(b);
  const sealedAt = kel.messages.find((m) => sealsOf(m).some((a) => isDigestSeal(a) && a.d === d))?.s;
  if (sealedAt === undefined) problems.push(problem("bindingInvalid", "the binding is not sealed in the KEL", kel.aid));
  let replacedAt: number | undefined;
  for (const o of others) {
    if (o.replaces !== d) continue;
    const od = bindingDigest(o);
    const at = kel.messages.find((m) => sealsOf(m).some((a) => isDigestSeal(a) && a.d === od))?.s;
    if (at !== undefined && (replacedAt === undefined || at < replacedAt)) replacedAt = at;
  }
  return { ok: problems.length === 0, ...(sealedAt !== undefined ? { sealedAt } : {}), ...(replacedAt !== undefined ? { replacedAt } : {}), problems };
}
