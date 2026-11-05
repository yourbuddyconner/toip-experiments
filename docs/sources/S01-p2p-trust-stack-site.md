# S01: P2P Trust Stack website

URL: https://www.fpndtg.com/index.html, and the Layer 2, 3 and 4 pages under `/stack/`.
Read: 2026-11-05, during IIW, through a fetch tool that summarizes pages. Not read in full, so re-read the pages before relying on a detail. Trust: summary only.
Not read: Layer 1, Developer Docs, Glossary, About, trusttasks.org, firstperson.network.

## What it says, as summarized

- A partner project of the First Person Cooperative. Built on W3C standards, the ToIP model, DIF specifications and the Decentralized Trust Graph working group. A testbed; the stack is "being prepared for open source release", and developer interfaces are "coming soon".
- **Layer 1, trust support:** `did:scid:vh` (self-certifying, hash-chained history, pre-rotation, witness attestation) and `did:peer:4`.
- **Layer 2, trust spanning:** Verified Trust Agents (VTAs) for people, organizations, communities and AI agents, each with Ed25519 signing and X25519 encryption keys. The Trust Spanning Protocol (TSP), not DIDComm, uses CESR, HPKE-Auth and libp2p. Message types: `TSP_RFI` (invitation), `TSP_RFA` (acceptance), `TSP_GEN` (signed), `TSP_GEN_CONFIDENTIAL` (encrypted). Keys and relationship records stay on the device in Direct Mode. Routed Mode is planned.
- **Layer 3, trust tasks:** mostly planned.
  - Verified Relationship Credentials (VRCs) are W3C credentials that both parties sign. Their types include community membership, delegation of authority, endorsement, employment and family. Their fields are not listed.
  - Verified Trust Communities (VTCs) have governance rules saying who can join, what credentials membership needs and what members can do. Today that's an admin list plus a signature threshold, "not a general governance engine". Roles, delegation, voting and admission requests are planned.
  - Trust Tasks are membership, signing-authority and compliance checks that use VRCs as evidence. Integration with trusttasks.org is planned.
  - R-Cards are profile credentials whose claims have four visibility levels. One level is "available only through a zero-knowledge proof", with no protocol given.
- **Layer 4, trust applications:** not started. A Personal Network Manager (an Agent App reference) and a Community Network Manager (a Utility Server reference: name registry, credential registry, witness attestation, community governance). A stated goal is to "delegate authority to AI agents with confidence that they cannot exceed their mandate."
- **Not on the pages read:** policy languages, authorization models, access control, selective disclosure as a term, revocation and reputation.
