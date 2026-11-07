# S04: Ecosystem orientation

Read: 2026-11-06. Trust: primary for the documented scopes and implementation choices below. Official pages were read through the web tool; repository READMEs and the policy implementation through the GitHub connector. Installed package metadata was read locally.

## Sources

- ToIP model: https://trustoverip.org/toip-model/ — distinguishes architecture and governance from independently controlled ecosystem implementations.
- First Person white paper executive summary: https://www.firstperson.network/white-paper — distinguishes project, proposed network, and proposed cooperative governance. This is the white paper's proposal, not verification of a cooperative's current legal status.
- OpenVTC VTI README: https://github.com/OpenVTC/verifiable-trust-infrastructure — documents Rust VTA/VTC services and clients.
- VTI specification: https://trustoverip.github.io/dtgwg-vti-spec/ — introduction, scope, and composition model. Its divergence register explicitly separates specification requirements from implementation behavior.
- Installed `@openvtc/vti-tsp-js` 0.2.0 README and package metadata — identifies the TypeScript library used here and its repository: https://github.com/OpenVTC/vta-browser-plugin/tree/main/packages/tsp-js. Using this library does not imply deployment of OpenVTC's complete services.
- TrustStackers README: https://github.com/TrustStackers/p2p-trust-stack — documents Node-only core/application packages, libp2p, DID methods, and integrated agent domains.
- TrustStackers policy implementation: https://github.com/TrustStackers/p2p-trust-stack/blob/main/packages/core/src/services/local-policy-engine.ts — confirms its structured interpreter and `p2pts` format. A registry's Rego task definitions do not establish that another implementation runs Rego.
- Trust Tasks README: https://github.com/trustoverip/dtgwg-trust-tasks-tf — documents the ToIP working-group context, framework, registry, and transport independence.
- KERI specification and KERIpy README: https://trustoverip.github.io/kswg-keri-specification/ and https://github.com/WebOfTrust/keripy — key histories, pre-rotation, witnessing, and implementation context.
- DIF: https://identity.foundation/ and https://identity.foundation/didcomm-messaging/spec/v2.1/ — organization scope and DIDComm's separate messaging design.
- W3C DID Core and VC data model: https://www.w3.org/TR/did-1.0/ and https://www.w3.org/TR/vc-data-model-2.0/ — shared data models.

## Scope and limits

This reading supports an orientation and a comparison of documented choices. It is not a conformance audit, an interoperability test, or a claim that any project represents all ToIP implementations. The categories used in the guide are this site's editorial organization; the communities overlap.

The P2P Trust Stack website could not be fetched. Its repository documentation supersedes the implementation-status summaries in S01/S02 for this guide. No new legal or organizational-affiliation claims were inferred from those older summaries.
