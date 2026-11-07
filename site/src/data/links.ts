// External links, in one place so the link check can list them. Each was fetched and answered on 2026-11-06.
// Where a link comes from the repository's source notes (docs/sources), the note is named.
export const externals = {
  // Trust over IP and the P2P Trust Stack
  toip: "https://trustoverip.org/",
  toipGithub: "https://github.com/trustoverip",
  p2pStack: "https://www.fpndtg.com/index.html", // S01
  p2pLayer1: "https://www.fpndtg.com/stack/layer1-support.html",
  p2pLayer2: "https://www.fpndtg.com/stack/layer2-spanning.html",
  p2pLayer3: "https://www.fpndtg.com/stack/layer3-tasks.html", // S01, S02
  p2pLayer4: "https://www.fpndtg.com/stack/layer4-applications.html", // S02
  p2pGlossary: "https://www.fpndtg.com/developers/glossary.html", // S02
  firstPerson: "https://firstperson.network/", // S01 (named, not read)
  trustStackers: "https://github.com/TrustStackers", // S03
  lfdtWorkingGroups: "https://www.lfdecentralizedtrust.org/blog/toip-and-dif-announce-three-new-working-groups-for-trust-in-the-age-of-ai",
  iiw: "https://internetidentityworkshop.com/",

  // Specifications
  tspSpec: "https://trustoverip.github.io/tswg-tsp-specification/",
  tspRepo: "https://github.com/trustoverip/tswg-tsp-specification",
  trustTasks: "https://trusttasks.org/", // S02
  trustTasksTf: "https://github.com/trustoverip/dtgwg-trust-tasks-tf", // S02
  didCore: "https://www.w3.org/TR/did-1.0/",
  didKey: "https://w3c-ccg.github.io/did-key-spec/",
  vc2: "https://www.w3.org/TR/vc-data-model-2.0/",
  bitstring: "https://www.w3.org/TR/vc-bitstring-status-list/",
  diEddsa: "https://www.w3.org/TR/vc-di-eddsa/",
  hpke: "https://www.rfc-editor.org/rfc/rfc9180",
  keriSpec: "https://trustoverip.github.io/kswg-keri-specification/",
  cesrSpec: "https://trustoverip.github.io/kswg-cesr-specification/",
  keripy: "https://github.com/WebOfTrust/keripy",
  cose: "https://www.rfc-editor.org/rfc/rfc9052",
  cbor: "https://www.rfc-editor.org/rfc/rfc8949",
  webauthn: "https://www.w3.org/TR/webauthn-3/",
  noir: "https://noir-lang.org/",
  barretenberg: "https://github.com/AztecProtocol/aztec-packages",
  semaphore: "https://github.com/semaphore-protocol/semaphore",
  opa: "https://www.openpolicyagent.org/",
  c2pa: "https://spec.c2pa.org/specifications/specifications/2.2/specs/C2PA_Specification.html",

  // Implementations this toolkit uses or sits next to
  openvtc: "https://github.com/OpenVTC", // S02
  openvtcRepo: "https://github.com/OpenVTC/openvtc", // S02
  vti: "https://github.com/OpenVTC/verifiable-trust-infrastructure", // S02
} as const;
