import type { Proof } from "@openvtc/trust-tasks/runtime";
import type { Clock } from "./clock";
import { signDocument, verifyDocument } from "./credentials";
import { fromB64u, toB64u } from "./encoding";
import type { Identity } from "./identity";

/** A signed revocation list: one bit per credential index. Our own format, after the W3C Bitstring Status List. */
export interface StatusListDoc {
  id: string;
  type: "status-list";
  issuer: string;
  issuedAt: string;
  length: number;
  bits: string;
  proof?: Proof;
}

export class StatusList {
  private readonly bits: Uint8Array;
  private next = 0;

  constructor(readonly length = 1024) {
    this.bits = new Uint8Array(Math.ceil(length / 8));
  }

  allocate(): number {
    if (this.next >= this.length) throw new Error("status list full");
    return this.next++;
  }

  revoke(index: number): void {
    this.bits[index >> 3] |= 1 << (index & 7);
  }

  isRevoked(index: number): boolean {
    return (this.bits[index >> 3] & (1 << (index & 7))) !== 0;
  }

  sign(issuer: Identity, clock: Clock): StatusListDoc {
    const doc: StatusListDoc = {
      id: `${issuer.did}#status`,
      type: "status-list",
      issuer: issuer.did,
      issuedAt: clock.iso(),
      length: this.length,
      bits: toB64u(this.bits),
    };
    return signDocument(doc, issuer, clock);
  }
}

export function isRevokedIn(doc: StatusListDoc, index: number): boolean {
  const bits = fromB64u(doc.bits);
  return (bits[index >> 3] & (1 << (index & 7))) !== 0;
}

export async function checkStatus(
  doc: StatusListDoc,
  index: number,
  expectedIssuer: string,
  clock: Clock,
): Promise<{ signatureValid: boolean; revoked: boolean; ageSeconds: number }> {
  const sig = await verifyDocument(doc, clock);
  return {
    signatureValid: sig.valid && doc.issuer === expectedIssuer,
    revoked: isRevokedIn(doc, index),
    ageSeconds: Math.round((clock.now() - Date.parse(doc.issuedAt)) / 1000),
  };
}
