/** Agent passports (design §6.2): the operator's signed claim about what an agent is and who answers for it. */
import { canonicalJson, issueCredential, utf8, verifyCredential, type Clock, type Credential, type Identity } from "@toip-tools/trust-core";
import { sha256 } from "@noble/hashes/sha2.js";
import { HARNESS } from "./config";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const sha256Of = (text: string): string => `sha256:${hex(sha256(utf8(text)))}`;
export const jsonHash = (v: unknown): string => sha256Of(canonicalJson(v as object));

export interface PassportClaims {
  agent: string;
  name: string;
  description: string;
  operator: { id: string; name: string };
  accountable: { id: string; name: string; contact?: string };
  runtime: { kind: "llm-agent"; provider: "anthropic" | "scripted"; model: string; toolsHash: string; harnessHash?: string };
  endpoints: { type: "tsp-relay"; url: string }[];
  audit: { aid: string; trail: string; witnesses: string[] };
  oversight?: string;
  status?: Credential["credentialStatus"];
  validDays?: number;
}

export function issuePassport(operator: Identity, clock: Clock, c: PassportClaims): Credential {
  return issueCredential(operator, clock, {
    type: ["VerifiableCredential", "AgentPassport"],
    validUntil: new Date(clock.now() + (c.validDays ?? 30) * 86_400_000).toISOString(),
    credentialSubject: {
      id: c.agent,
      name: c.name,
      description: c.description,
      operator: c.operator,
      accountable: c.accountable,
      runtime: { ...c.runtime, harness: HARNESS },
      endpoints: c.endpoints,
      audit: c.audit,
      oversight: c.oversight ?? "Actions beyond its mandate go to the principal for approval.",
    },
    ...(c.status ? { credentialStatus: c.status } : {}),
  });
}

export interface PassportView {
  ok: boolean;
  problem?: string;
  name?: string;
  operator?: string;
  model?: string;
  provider?: string;
}

/** Checks a passport's signature, validity and subject. What it proves: the operator vouches for these facts. */
export async function verifyPassport(p: Credential | undefined, subject: string, clock: Clock): Promise<PassportView> {
  if (!p || !Array.isArray(p.type) || !p.type.includes("AgentPassport")) return { ok: false, problem: "no passport" };
  if (p.credentialSubject?.id !== subject) return { ok: false, problem: "the passport is for someone else" };
  const v = await verifyCredential(p, clock);
  if (!v.ok) return { ok: false, problem: `the passport doesn't verify (${v.failure})` };
  const s = p.credentialSubject as Record<string, any>;
  return { ok: true, name: String(s.name ?? ""), operator: String(s.operator?.name ?? p.issuer), model: String(s.runtime?.model ?? ""), provider: String(s.runtime?.provider ?? "") };
}
