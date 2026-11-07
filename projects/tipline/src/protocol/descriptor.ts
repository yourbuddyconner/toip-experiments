/**
 * The drop box descriptor (design §8.1): signed by the drop box DID, served by the outlet. It names
 * the stories that are open, which groups each accepts, and the policy for each group.
 */
import { signDocument, verifyDocument, type Clock, type Identity } from "@toip-tools/trust-core";

export interface StoryGroup {
  /** "<issuer DID>#<name>". */
  group: string;
  /** Pinned by the journalist out of band, e.g. from the organization's own website. */
  issuer: string;
  /** A name for people: "Acme Chemicals employees". */
  label: string;
  /** The issuer's own root log URL. */
  log: string;
  /** The outlet's mirror of the log and snapshots, relative to the outlet site: "/dropbox/<id>/mirror/<slug>/". */
  mirror: string;
  minSize: number;
  maxEpochAge: number;
}

export interface Story {
  id: string;
  title: string;
  opens: string;
  closes?: string;
  groups: StoryGroup[];
}

export interface Descriptor {
  id: string;
  type: "tipline/dropbox";
  v: 1;
  issuer: string;
  /** The outlet's short id for this drop box, as in /tip/<slug>. */
  slug: string;
  outlet: string;
  journalist: { name: string };
  relay: string;
  appBundle?: { url: string; sha256: string };
  circuits: { id: string; vkHash: string }[];
  stories: Story[];
  limits: { maxAttachments: number; maxAttachmentBytes: number };
  issuedAt: string;
  proof?: Record<string, unknown>;
}

export const DEFAULT_LIMITS = { maxAttachments: 8, maxAttachmentBytes: 16 * 1024 * 1024 };

export function signDescriptor(d: Omit<Descriptor, "id" | "type" | "v" | "issuer" | "issuedAt" | "proof">, identity: Identity, clock: Clock): Descriptor {
  const { proof: _p, ...rest } = d as Partial<Descriptor>;
  const doc: Descriptor = { ...(rest as Descriptor), id: `urn:uuid:${crypto.randomUUID()}`, type: "tipline/dropbox", v: 1, issuer: identity.did, issuedAt: clock.iso() };
  return signDocument(doc, identity, clock);
}

/** Checks the descriptor's shape and signature. With `expectedIssuer`, it must also be that drop box's. */
export async function verifyDescriptor(d: unknown, clock: Clock, expectedIssuer?: string): Promise<{ ok: true; descriptor: Descriptor } | { ok: false; why: string }> {
  const doc = d as Descriptor;
  if (!doc || typeof doc !== "object" || doc.type !== "tipline/dropbox" || doc.v !== 1) return { ok: false, why: "not a drop box descriptor" };
  if (typeof doc.issuer !== "string" || !doc.issuer.startsWith("did:key:")) return { ok: false, why: "no drop box DID" };
  if (expectedIssuer && doc.issuer !== expectedIssuer) return { ok: false, why: "signed by another drop box" };
  if (typeof doc.slug !== "string" || !/^[a-z0-9-]{3,40}$/.test(doc.slug)) return { ok: false, why: "bad slug" };
  if (!Array.isArray(doc.stories) || !Array.isArray(doc.circuits)) return { ok: false, why: "malformed" };
  for (const s of doc.stories) {
    if (!s || typeof s.id !== "string" || !Array.isArray(s.groups) || s.groups.length < 1 || s.groups.length > 4) return { ok: false, why: "malformed story" };
    for (const g of s.groups) {
      if (!g || typeof g.group !== "string" || !g.group.startsWith(`${g.issuer}#`)) return { ok: false, why: "a story's group is not its issuer's" };
      if (!Number.isInteger(g.minSize) || !Number.isInteger(g.maxEpochAge) || g.minSize < 1 || g.maxEpochAge < 0) return { ok: false, why: "bad group policy" };
    }
  }
  const sig = await verifyDocument(doc, clock);
  if (!sig.valid) return { ok: false, why: "the signature doesn't verify" };
  return { ok: true, descriptor: doc };
}

export function storyOf(d: Descriptor, id: string): Story | undefined {
  return d.stories.find((s) => s.id === id);
}

/** Is the story open on this day ("2026-11-06")? */
export function storyOpen(s: Story, day: string): boolean {
  return s.opens <= day && (!s.closes || day <= s.closes);
}
