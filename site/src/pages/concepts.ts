import { gh, u } from "../../build/config";
import { html, md, type Raw } from "../../build/html";
import { externals as X } from "../data/links";
import { credentialDiagram, didDiagram, governanceDiagram, keriDiagram, taskDiagram, tspDiagram, zkDiagram } from "../diagrams";
import type { Page } from "../layout";
import { libLinks, pageHead } from "../parts";

interface Concept {
  id: string;
  title: string;
  short: string;
  body: Raw;
  diagram: Raw;
  caption: string;
  here: Raw;
  sources: { href: string; label: string }[];
}

const S = (n: string) => html`<a href="${gh(`docs/sources/${n}`)}">source note</a>`;

const concepts: Concept[] = [
  {
    id: "dids",
    title: "Decentralized identifiers",
    short: "An identifier you control, with keys others can verify.",
    body: md`
      A decentralized identifier (DID) identifies a person, organization, or device without requiring an account at a central provider. It resolves to a document containing verification keys and, depending on the method, other information. Those keys let others check signatures and establish encrypted communication.

      The toolkit starts with \`did:key\`, which encodes the public key in the identifier itself. Resolution needs no network or registry. The tradeoff is a fixed key: if it is lost or compromised, you need a new identifier. This makes \`did:key\` useful for tutorials and short-lived identities.

      Other methods support longer-lived relationships. The P2P Trust Stack uses \`did:peer:4\` and \`did:scid:vh\`; the latter maintains a history with pre-rotation and witnesses. KERI, described below, also lets an identifier keep its identity as its keys change.
    `,
    diagram: didDiagram(),
    caption: "A did:key is its public key, written out. A KERI identifier (AID) is a digest of its first event, which already commits to the next key.",
    here: html`${libLinks(["trust-core"])} makes Ed25519 <code>did:key</code> identities (<code>identityFromSeed</code>) and resolves them offline (<code>resolveDidKey</code>). ${libLinks(["eventlog"])} makes KERI identifiers and writes them as <code>did:keri:&lt;AID&gt;</code>, resolved from the key event log alone. Nothing here resolves other DID methods.`,
    sources: [
      { href: X.didCore, label: "W3C Decentralized Identifiers (DIDs) v1.0" },
      { href: X.didKey, label: "The did:key method (W3C CCG draft)" },
      { href: X.p2pLayer1, label: "P2P Trust Stack, Layer 1: trust support" },
    ],
  },
  {
    id: "credentials",
    title: "Verifiable credentials and status lists",
    short: "A claim you can carry, verify, and revoke.",
    body: md`
      A verifiable credential is a signed statement from an *issuer* about a *subject*: "Bob is a member of the Riverside Community Garden." The *holder* keeps it and presents it when needed. A *verifier* checks the signature and decides whether the issuer is an authority it accepts for that claim.

      The issuer can revoke a credential by updating a signed status list. Each credential points to a bit in that list. A verifier retrieves a current copy, checks its signature, and reads the bit. One list covers many credentials, so the request does not identify which credential is being checked. Verification can happen without asking the issuer about the holder's visit.
    `,
    diagram: credentialDiagram(),
    caption: "The issuer makes the claim, the holder presents it, and the verifier checks it against an issuer it trusts.",
    here: html`${libLinks(["trust-core"])} provides <code>issueCredential</code> and <code>verifyCredential</code> for credentials in the W3C Verifiable Credentials 2.0 shape, signed with Data Integrity <code>eddsa-jcs-2022</code> proofs. Its signed <code>StatusList</code> format is inspired by the W3C Bitstring Status List but is not format-compatible. ${libLinks(["mandates"])} uses these credentials for delegation.`,
    sources: [
      { href: X.vc2, label: "W3C Verifiable Credentials Data Model v2.0" },
      { href: X.bitstring, label: "W3C Bitstring Status List" },
      { href: X.diEddsa, label: "W3C Data Integrity EdDSA Cryptosuites" },
    ],
  },
  {
    id: "tsp",
    title: "The Trust Spanning Protocol",
    short: "Private, authenticated messages that can travel over different transports.",
    body: md`
      The Trust Spanning Protocol (TSP) provides ToIP's messaging layer. In the Direct mode used here, a message names its sender and recipient with verifiable identifiers (VIDs), encrypts its payload with authenticated HPKE, and carries the sender's signature. The recipient checks that signature before processing the contents.

      This separates message security from delivery. A relay, radio link, or portable file can carry the same protected message. The carrier can delay or drop it, but cannot read its encrypted payload or alter it without detection.

      In *Direct* mode, which this toolkit uses, both VIDs travel in the clear, so a carrier learns who is talking to whom. The specification also defines *Routed* and *Nested* modes, in which intermediaries forward messages without learning both ends. The P2P Trust Stack runs TSP with CESR encoding over libp2p, and starts each relationship with an invitation and an acceptance (\`TSP_RFI\`, \`TSP_RFA\`).
    `,
    diagram: tspDiagram(),
    caption: "What each part of a Direct-mode TSP message reveals. The landing page shows a real one, byte for byte.",
    here: html`${libLinks(["trust-core"])} uses <code>@openvtc/vti-tsp-js</code> for TSP Direct messaging over the in-memory <code>Bus</code> or ${libLinks(["relay"])}. Communication starts with a Direct message; the invitation handshake and Routed mode are not implemented here. ${libLinks(["mesh-transport"])} carries the same messages over radio, replacing visible identifiers with short address tags on the air.`,
    sources: [
      { href: X.tspSpec, label: "ToIP Trust Spanning Protocol specification" },
      { href: X.hpke, label: "RFC 9180: Hybrid Public Key Encryption" },
      { href: X.p2pLayer2, label: "P2P Trust Stack, Layer 2: trust spanning" },
      { href: X.openvtc, label: "OpenVTC, whose TypeScript TSP library this toolkit uses" },
    ],
  },
  {
    id: "trust-tasks",
    title: "Trust Tasks",
    short: "A shared message format for the work parties do together.",
    body: md`
      A Trust Task describes one interaction: issuing an endorsement, requesting community membership, or approving a payment. Each uses the same document envelope: an \`id\`, a specification URI as its \`type\`, an \`issuer\`, a \`recipient\`, timing fields, a payload, and a proof when required. A response uses the same type with \`#response\` appended.

      Before dispatching a document to a handler, the receiver checks freshness, replay history, required proofs, and payload validity. The public registry at trusttasks.org catalogs specifications for many interactions, from community membership to voting. A specification defines an interaction; check separately whether an implementation exists.
    `,
    diagram: taskDiagram(),
    caption: "Every Trust Task in this toolkit is signed by its issuer, and every response by its responder, refusals included.",
    here: html`${libLinks(["trust-core"])}'s <code>Endpoint</code> builds, signs, seals and checks Trust Task documents with the OpenVTC libraries, and runs your handler for each type you register. This repository's own types live under <code>https://toip.tools/spec/</code>; <a href="${u("/spec/")}">the Spec pages</a> describe every one of them.`,
    sources: [
      { href: X.trustTasks, label: "Trust Tasks registry" },
      { href: X.trustTasksTf, label: "ToIP Trust Tasks task force" },
      { href: X.p2pLayer3, label: "P2P Trust Stack, Layer 3: trust tasks" },
    ],
  },
  {
    id: "governance",
    title: "Trust registries and governance",
    short: "Decide whose claims you accept, and under what rules.",
    body: md`
      A valid signature tells you which key signed a claim. You still need to decide whether to accept that signer as an authority. For a garden membership credential, that means knowing the garden's DID and trusting it to vouch for members.

      A governance framework records those decisions: who may issue which credentials, how members join and leave, and how disputes are resolved. A trust registry makes a key question answerable by software: *is this DID authorized to issue this kind of credential?*

      In the P2P Trust Stack, a Verified Trust Community has governance rules for who can join, which credentials membership needs and what members can do. Today those rules are an admin list and a signature threshold; roles, delegation, voting and admission requests are planned.
    `,
    diagram: governanceDiagram(),
    caption: "Governance turns 'this key signed it' into 'this is an authority for this claim'.",
    here: html`There is no trust registry library here yet. The projects decide trust in simpler ways you can read: a verifier pins the issuers it accepts (${libLinks(["anon-membership"])}'s <code>AcceptPolicy</code>), a list's own key signs its roster (<a href="${u("/examples/#shared-todo")}">Shared To-Do</a>), authority flows down a chain from a principal (${libLinks(["mandates"])}), and each party decides with a Rego policy it runs itself (<code>Policies</code> in trust-core).`,
    sources: [
      { href: X.toip, label: "Trust over IP Foundation" },
      { href: X.p2pLayer3, label: "P2P Trust Stack, Layer 3: communities and governance" },
    ],
  },
  {
    id: "keri",
    title: "KERI key event logs and witnesses",
    short: "Rotate keys while keeping a verifiable identity history.",
    body: md`
      KERI (Key Event Receipt Infrastructure) records how an identifier's keys change. For the identifiers used here, the AID is a digest of an *inception* event that lists the initial keys and commits to the next ones. Rotation reveals those pre-committed keys. Someone who steals only the current key cannot substitute their own next keys. Signed events form the key event log (KEL).

      *Witnesses* sign receipts for the first version of each event they accept. If a controller presents conflicting histories, *watchers* can compare witness records and produce evidence of *duplicity*. The log also lets a verifier check an older signature against the keys that were valid when it was made.
    `,
    diagram: keriDiagram(),
    caption: "Each event commits to the next key before it is needed. Witnesses make a forked history detectable.",
    here: html`${libLinks(["eventlog"])} writes KERI 1.0 key event logs that KERIpy 1.3.6 verifies, with Ed25519 and P-256 keys, witnesses and watchers. On top of a KEL it keeps <em>trails</em>, this repository's own signed audit logs, which a rotation seals. Delegated identifiers, weighted thresholds and KERI 2.0 are refused as unsupported.`,
    sources: [
      { href: X.keriSpec, label: "KERI specification (ToIP)" },
      { href: X.cesrSpec, label: "CESR specification (ToIP)" },
      { href: X.keripy, label: "KERIpy, the reference implementation" },
    ],
  },
  {
    id: "zk",
    title: "Selective disclosure and zero-knowledge membership",
    short: "Prove a required fact while keeping the underlying record private.",
    body: md`
      Presenting a full credential reveals all its claims, and repeated presentations can link a holder's activity. *Selective disclosure* lets a holder reveal chosen claims. *Zero-knowledge proofs* can establish a statement, such as "I am a current employee" or "I am over 18", without disclosing the underlying credential or record.

      The P2P Trust Stack plans profile credentials with a visibility level "available only through a zero-knowledge proof", without a protocol for it yet, and the Trust Tasks registry already has a task in which a member's agent proves that enough distinct vetters attested for it.
    `,
    diagram: zkDiagram(),
    caption: "Group membership in zero knowledge: the verifier checks a signed root and a nullifier, and never sees the leaf.",
    here: html`${libLinks(["anon-membership"])} proves membership in one of up to four groups and checks attribute requirements. A scope-specific nullifier lets a verifier recognize repeat participation without learning which membership produced it. The library uses Noir and Barretenberg's UltraHonk in a mode <strong>designed to be zero-knowledge</strong>; its authors found no published proof of that property, and Noir is not yet intended for production use. Field-level credential disclosure with BBS or SD-JWT is not implemented here.`,
    sources: [
      { href: X.noir, label: "Noir" },
      { href: X.barretenberg, label: "Barretenberg (in Aztec's repository)" },
      { href: X.semaphore, label: "Semaphore, an earlier design for anonymous group signalling" },
      { href: X.p2pLayer3, label: "P2P Trust Stack, Layer 3: R-Cards" },
    ],
  },
];

export const conceptIds = concepts.map((c) => c.id);

export function conceptsPage(): Page {
  const body = html`
<div class="wrap docs">
  <nav class="docs__side" aria-label="Concepts">
    <p class="side-h">On this page</p>
    <ul>${concepts.map((c) => html`<li><a href="#${c.id}">${c.title}</a></li>`)}</ul>
  </nav>
  <div>
    ${pageHead("The ideas behind the code", "Start with identity, follow a message, and see how credentials, governance, and proofs let people work together. Each concept includes a diagram and the toolkit's implementation.")}
    <div class="prose">
      <p>Links at the end of each section lead to the specifications. Comparisons with the P2P Trust Stack draw on the repository's ${S("S01-p2p-trust-stack-site.md")} and ${html`<a href="${gh("docs/sources/S02-trust-tasks-registry-and-openvtc.md")}">follow-up</a>`}. Those notes used summaries of the stack's pages; consult the original sources for implementation decisions.</p>
    </div>
    ${concepts.map(
      (c) => html`<section class="concept" id="${c.id}" aria-labelledby="${c.id}-h">
      <h2 id="${c.id}-h">${c.title}</h2>
      <p class="lede prose">${c.short}</p>
      <div class="prose">${c.body}</div>
      <figure class="diagram"><div class="diagram__scroll" tabindex="0">${c.diagram}</div><figcaption>${c.caption}</figcaption></figure>
      <div class="prose"><h3>In this toolkit</h3><p>${c.here}</p></div>
      <div class="sources"><strong>Read the source</strong><ul>${c.sources.map((s) => html`<li><a href="${s.href}">${s.label}</a></li>`)}</ul></div>
    </section>`,
    )}
  </div>
</div>`;
  return {
    path: "/concepts/",
    title: "Concepts",
    description: "Decentralized identifiers, verifiable credentials, the Trust Spanning Protocol, Trust Tasks, governance, KERI and zero-knowledge membership, in plain words.",
    section: "concepts",
    body,
  };
}
