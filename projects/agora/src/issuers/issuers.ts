/**
 * The demo issuers (design §12.1 item 3): two nursing boards and a city. Each is a did:key with a
 * status list. It issues credentials over agora/demo/issue, and, as an issuer-run group, runs its own
 * registrar. A real board would check something before issuing; these issue what they're asked.
 */
import { StatusList, Refusal, issueCredential, type Clock, type Credential, type Endpoint, type Identity, type StatusListDoc } from "@toip-tools/trust-core";
import type { SlotSpec } from "../protocol/documents";
import { DEMO_ISSUE, type DemoIssueRequest } from "../protocol/specs";
import { Registrar, type RegistrarState } from "../registrar/registrar";

export interface ClaimSpec {
  name: string;
  label: string;
  /** Allowed values, or a pattern. */
  options?: string[];
  pattern?: RegExp;
  example: string;
}

export interface IssuerKind {
  key: "cascade" | "pine" | "riverton";
  title: string;
  credentialType: string;
  credentialLabel: string;
  groupName: string;
  schemaId: string;
  claims: ClaimSpec[];
  slots: (SlotSpec | null)[];
  /** Days a credential is valid. */
  validDays: number;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const NURSING_SLOTS: (SlotSpec | null)[] = [
  { name: "licenseType", label: "license type", from: "credentialSubject.licenseType", encoding: "hash", publishCounts: true },
  { name: "state", label: "state", from: "credentialSubject.state", encoding: "hash", publishCounts: true },
  { name: "licensedSince", label: "licensed since", from: "credentialSubject.licensedSince", encoding: "day" },
  null,
];

const NURSING_CLAIMS = (state: string): ClaimSpec[] => [
  { name: "licenseType", label: "License type", options: ["RN", "LPN"], example: "RN" },
  { name: "state", label: "State", options: [state], example: state },
  { name: "licensedSince", label: "Licensed since", pattern: DATE, example: "2019-05-01" },
];

export const ISSUER_KINDS: IssuerKind[] = [
  {
    key: "cascade",
    title: "Cascade Board of Nursing",
    credentialType: "NursingLicense",
    credentialLabel: "nursing license",
    groupName: "cascade-nursing-v1",
    schemaId: "agora/schema/nursing-license/1",
    claims: NURSING_CLAIMS("WA"),
    slots: NURSING_SLOTS,
    validDays: 730,
  },
  {
    key: "pine",
    title: "Pine Valley Board of Nursing",
    credentialType: "NursingLicense",
    credentialLabel: "nursing license",
    groupName: "pine-nursing-v1",
    schemaId: "agora/schema/nursing-license/1",
    claims: NURSING_CLAIMS("OR"),
    slots: NURSING_SLOTS,
    validDays: 730,
  },
  {
    key: "riverton",
    title: "City of Riverton",
    credentialType: "ResidencyCredential",
    credentialLabel: "proof of residency",
    groupName: "riverton-residents-v1",
    schemaId: "agora/schema/residency/1",
    claims: [
      { name: "district", label: "District", options: ["1", "2", "3", "4", "5", "6", "7", "8"], example: "7" },
      { name: "residentSince", label: "Resident since", pattern: DATE, example: "2021-03-15" },
    ],
    slots: [
      { name: "district", label: "district", from: "credentialSubject.district", encoding: "hash", publishCounts: true },
      { name: "residentSince", label: "resident since", from: "credentialSubject.residentSince", encoding: "day" },
      null,
      null,
    ],
    validDays: 365,
  },
];

export interface IssuerState {
  statusBits: number[];
  issued: { id: string; subject: string; index: number }[];
  registrar?: RegistrarState;
}

/** The public view of an issuer, for the web app's wallet. */
export interface IssuerInfo {
  did: string;
  key: string;
  title: string;
  credentialType: string;
  credentialLabel: string;
  group: string;
  claims: { name: string; label: string; options?: string[]; example: string }[];
}

export class DemoIssuer {
  readonly status: StatusList;
  readonly registrar: Registrar;
  private readonly issued: IssuerState["issued"];
  onChange?: () => void;
  log?: (line: string) => void;

  constructor(
    readonly kind: IssuerKind,
    readonly identity: Identity,
    private readonly clock: Clock,
    opts: { statusUrl: string; rootCadenceSeconds?: number; state?: IssuerState },
  ) {
    this.status = new StatusList(4096);
    this.issued = opts.state?.issued ?? [];
    for (let i = 0; i < this.issued.length; i++) this.status.allocate();
    for (const i of opts.state?.statusBits ?? []) this.status.revoke(i);
    this.registrar = new Registrar({
      identity,
      clock,
      config: {
        name: kind.groupName,
        title: kind.title,
        credentialLabel: kind.credentialLabel,
        credentialType: kind.credentialType,
        sourceIssuer: identity.did,
        statusList: opts.statusUrl,
        schemaId: kind.schemaId,
        slots: kind.slots,
        rootCadenceSeconds: opts.rootCadenceSeconds,
      },
      // Issuer-run: the registrar reads its own status list.
      statusOf: async ({ index }) => this.status.isRevoked(index),
      state: opts.state?.registrar,
    });
    this.registrar.onChange = () => this.onChange?.();
  }

  get did(): string {
    return this.identity.did;
  }

  info(): IssuerInfo {
    return {
      did: this.did,
      key: this.kind.key,
      title: this.kind.title,
      credentialType: this.kind.credentialType,
      credentialLabel: this.kind.credentialLabel,
      group: this.registrar.groupId,
      claims: this.kind.claims.map(({ pattern: _p, ...c }) => c),
    };
  }

  /** Checks the claims and issues a credential to `subject`. */
  issue(subject: string, claims: Record<string, string>): Credential {
    const subjectClaims: Record<string, string> = {};
    for (const c of this.kind.claims) {
      const v = String(claims[c.name] ?? "").trim();
      if (c.options && !c.options.includes(v)) throw new Refusal("badClaim", `${c.label} must be one of ${c.options.join(", ")}`);
      if (c.pattern && !c.pattern.test(v)) throw new Refusal("badClaim", `${c.label} must look like ${c.example}`);
      subjectClaims[c.name] = v;
    }
    const index = this.status.allocate();
    const vc = issueCredential(this.identity, this.clock, {
      type: ["VerifiableCredential", this.kind.credentialType],
      credentialSubject: { id: subject, ...subjectClaims },
      validUntil: new Date(this.clock.now() + this.kind.validDays * 86_400_000).toISOString(),
      credentialStatus: { type: "BitstringStatusListEntry", statusListIndex: index, statusListCredential: this.registrar.descriptor.source.statusList },
    });
    this.issued.push({ id: vc.id, subject, index });
    this.log?.(`${this.kind.title}: issued ${this.kind.credentialType} to ${subject.slice(0, 24)}…`);
    this.onChange?.();
    return vc;
  }

  /** Revokes every credential issued to `subject`. */
  revokeSubject(subject: string): number {
    const mine = this.issued.filter((i) => i.subject === subject);
    for (const i of mine) this.status.revoke(i.index);
    if (mine.length) this.onChange?.();
    return mine.length;
  }

  statusList(): StatusListDoc {
    return this.status.sign(this.identity, this.clock);
  }

  /** Answers agora/demo/issue, and the registrar's tasks, on the issuer's endpoint. */
  serve(endpoint: Endpoint): void {
    endpoint.handle<DemoIssueRequest, { credential: Credential }>(DEMO_ISSUE, (doc, { sender }) => {
      const req = doc.payload;
      if (req?.credentialType !== this.kind.credentialType) return new Refusal("wrongType", `${this.kind.title} issues ${this.kind.credentialType}`);
      try {
        return { credential: this.issue(sender, req.claims ?? {}) };
      } catch (e) {
        if (e instanceof Refusal) return e;
        throw e;
      }
    });
    this.registrar.serve(endpoint);
  }

  state(): IssuerState {
    const bits: number[] = [];
    for (let i = 0; i < this.issued.length; i++) if (this.status.isRevoked(i)) bits.push(i);
    return { statusBits: bits, issued: this.issued, registrar: this.registrar.state() };
  }
}
