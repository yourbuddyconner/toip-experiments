/**
 * Device credentials (design §7.5) on trust-core: W3C VC-shaped JSON with an eddsa-jcs-2022 proof by a
 * did:key issuer, revocable through trust-core status lists.
 */
import { issueCredential, type Clock, type Credential, type Identity } from "@toip-tools/trust-core";

export type KeyClass = "S" | "B" | "P" | "E";

export interface TrustEntry {
  did: string;
  name: string;
  trustedFor: ("owner" | "maker" | "installer" | "editor")[];
}

export interface Channel {
  kind: number;
  quantity: string;
  unit: string;
  scale: number;
  model?: string;
  calibration?: { at: string; offset: number; by: string };
}

export interface Installation {
  station: string;
  location: { lat: number; lon: number; elevationM?: number; accuracyM?: number; method: string };
  installedAt: string;
  channels: Channel[];
}

type Status = Credential["credentialStatus"];

export function deviceModelCredential(maker: Identity, clock: Clock, s: { id: string; maker: string; model: string; keyClass: KeyClass; keyClassEvidence: string; serial?: string }): Credential {
  return issueCredential(maker, clock, { type: ["VerifiableCredential", "DeviceModelCredential"], credentialSubject: { ...s } });
}

export function deviceOwnerCredential(
  owner: Identity,
  clock: Clock,
  s: { id: string; ownerName: string; label: string; scope: string[]; validUntil: string; webauthnOrigins?: string[] },
  status?: Status,
): Credential {
  return issueCredential(owner, clock, {
    type: ["VerifiableCredential", "DeviceOwnerCredential"],
    credentialSubject: { id: s.id, owner: owner.did, ownerName: s.ownerName, label: s.label, scope: s.scope, validUntil: s.validUntil, ...(s.webauthnOrigins ? { webauthnOrigins: s.webauthnOrigins } : {}) },
    validUntil: s.validUntil,
    ...(status ? { credentialStatus: status } : {}),
  });
}

export function sensorInstallationCredential(installer: Identity, clock: Clock, id: string, inst: Installation, status?: Status): Credential {
  return issueCredential(installer, clock, {
    type: ["VerifiableCredential", "SensorInstallationCredential"],
    credentialSubject: { id, ...inst },
    ...(status ? { credentialStatus: status } : {}),
  });
}

/** Not in the design: an owner vouches for a person who edits for them ("M. Chen, photo editor"). */
export function editorCredential(owner: Identity, clock: Clock, s: { id: string; name: string; role: string; ownerName: string }, status?: Status): Credential {
  return issueCredential(owner, clock, {
    type: ["VerifiableCredential", "EditorCredential"],
    credentialSubject: { id: s.id, name: s.name, role: s.role, owner: owner.did, ownerName: s.ownerName },
    ...(status ? { credentialStatus: status } : {}),
  });
}

export const credentialKind = (vc: Credential) =>
  vc.type.includes("DeviceOwnerCredential")
    ? "owner"
    : vc.type.includes("DeviceModelCredential")
      ? "maker"
      : vc.type.includes("SensorInstallationCredential")
        ? "installer"
        : vc.type.includes("EditorCredential")
          ? "editor"
          : "other";

export const KEY_CLASS_WORDS: Record<string, string> = {
  S: "Software key: a key file on the device. Anyone who copies the file can sign as this device.",
  B: "Browser key: this browser holds the key and won't give it up, but anyone who controls this browser can sign as this camera.",
  P: "Passkey: each signature needed the owner's fingerprint, face or PIN.",
  E: "Secure element: a chip on the board holds the key.",
};
