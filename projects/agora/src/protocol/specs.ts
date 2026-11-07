/**
 * Agora's Trust Tasks over TSP (design §7.6). Joining and rotating use anon-membership's own
 * `anon-membership/enroll` task (ENROLL), with the credential in the request and `replace` for a rotation.
 */
import { ourSpec } from "@zk-toip/trust-core";

/** member DID → demo issuer: { credentialType, claims } → { credential }. Dev only. */
export const DEMO_ISSUE = ourSpec("agora/demo/issue");
/** member DID → registrar: { group } → a signed agora/group-receipt for the sender, if they're a member. */
export const GROUP_RECEIPT = ourSpec("agora/group/receipt");
/** member DID → registrar: { group } → { removed: true }. */
export const GROUP_LEAVE = ourSpec("agora/group/leave");

export interface DemoIssueRequest {
  credentialType: string;
  claims: Record<string, string>;
}
