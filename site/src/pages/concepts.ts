import { u } from "../../build/config";
import { html, md, type Raw } from "../../build/html";
import { externals as X } from "../data/links";
import { credentialDiagram, didDiagram, governanceDiagram, keriDiagram, taskDiagram, tspDiagram, zkDiagram } from "../diagrams";
import type { Page } from "../layout";
import { libLink, pageHead } from "../parts";

interface Concept {
  id: string;
  title: string;
  short: string;
  body: Raw;
  diagram: Raw;
  caption: string;
  here: {
    libraries: string[];
    points: Raw[];
    note?: Raw;
    noteLabel?: string;
  };
  sources: { href: string; label: string }[];
}

const concepts: Concept[] = [
  {
    id: "dids",
    title: "Decentralized identifiers",
    short: "An identifier you control, with keys others can verify.",
    body: md`
      A decentralized identifier (DID) identifies a person, organization, or device without requiring an account at a central provider. It resolves to a document containing verification keys and, depending on the method, other information. Those keys let others check signatures and establish encrypted communication.

      The toolkit starts with \`did:key\`, which encodes the public key in the identifier itself. Resolution needs no network or registry. The tradeoff is a fixed key: if it is lost or compromised, you need a new identifier. This makes \`did:key\` useful for tutorials and short-lived identities.

      Other approaches support key rotation. KERI, described below, records changes in a key-event history so an identifier can keep its identity as its keys change.
    `,
    diagram: didDiagram(),
    caption: "A did:key is its public key, written out. A KERI identifier (AID) is a digest of its first event, which already commits to the next key.",
    here: {
      libraries: ["trust-core", "eventlog"],
      points: [
        html`<strong>Fixed-key identities.</strong> Create Ed25519 <code>did:key</code> identities with <code>identityFromSeed</code> and resolve them offline with <code>resolveDidKey</code>.`,
        html`<strong>Key histories.</strong> Eventlog creates KERI identifiers as <code>did:keri:&lt;AID&gt;</code> and resolves them from their key-event logs.`,
      ],
      note: html`Other DID methods are not supported by these resolvers.`,
    },
    sources: [
      { href: X.didCore, label: "W3C Decentralized Identifiers (DIDs) v1.0" },
      { href: X.didKey, label: "The did:key method (W3C CCG draft)" },
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
    here: {
      libraries: ["trust-core", "mandates"],
      points: [
        html`<strong>Issue and verify.</strong> <code>issueCredential</code> and <code>verifyCredential</code> use the W3C Verifiable Credentials 2.0 shape with <code>eddsa-jcs-2022</code> Data Integrity proofs.`,
        html`<strong>Delegate authority.</strong> Mandates builds delegation chains from these credentials.`,
      ],
      note: html`The signed <code>StatusList</code> format is inspired by the W3C Bitstring Status List but is not format-compatible.`,
    },
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

      In *Direct* mode, which this toolkit uses, both VIDs travel in the clear, so a carrier learns who is talking to whom. The specification also defines *Routed* and *Nested* modes that provide additional metadata protection through intermediaries.
    `,
    diagram: tspDiagram(),
    caption: "What each part of a Direct-mode TSP message reveals. The landing page shows a real one, byte for byte.",
    here: {
      libraries: ["trust-core", "relay", "mesh-transport"],
      points: [
        html`<strong>Direct messages.</strong> Trust-core uses <code>@openvtc/vti-tsp-js</code> over an in-memory <code>Bus</code> or the WebSocket relay.`,
        html`<strong>Radio delivery.</strong> Mesh transport carries the same messages, replacing visible identifiers with short address tags on the air.`,
      ],
      note: html`Communication starts with a Direct message. The invitation handshake and Routed mode are not implemented here.`,
    },
    sources: [
      { href: X.tspSpec, label: "ToIP Trust Spanning Protocol specification" },
      { href: X.hpke, label: "RFC 9180: Hybrid Public Key Encryption" },
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
    here: {
      libraries: ["trust-core"],
      points: [
        html`<strong>Send and handle.</strong> <code>Endpoint</code> builds, signs, encrypts, and checks Trust Tasks using the OpenVTC libraries, then dispatches them to registered handlers.`,
        html`<strong>Define interactions.</strong> This repository's types use the <code>https://toip.tools/spec/</code> namespace. The <a href="${u("/spec/")}">task reference</a> documents each one.`,
      ],
    },
    sources: [
      { href: X.trustTasks, label: "Trust Tasks registry" },
      { href: X.trustTasksTf, label: "ToIP Trust Tasks task force" },
    ],
  },
  {
    id: "governance",
    title: "Trust registries and governance",
    short: "Decide whose claims you accept, and under what rules.",
    body: md`
      A valid signature tells you which key signed a claim. You still need to decide whether to accept that signer as an authority. For a garden membership credential, that means knowing the garden's DID and trusting it to vouch for members.

      A governance framework records those decisions: who may issue which credentials, how members join and leave, and how disputes are resolved. A trust registry makes a key question answerable by software: *is this DID authorized to issue this kind of credential?*

      These rules belong to the community operating the system. A shared credential format does not determine who may join, who can delegate authority, or how decisions can be challenged.
    `,
    diagram: governanceDiagram(),
    caption: "Governance turns 'this key signed it' into 'this is an authority for this claim'.",
    here: {
      libraries: ["anon-membership", "mandates", "trust-core"],
      points: [
        html`<strong>Accepted issuers.</strong> Anonymous membership uses <code>AcceptPolicy</code> to pin issuers. <a href="${u("/examples/#shared-todo")}">Shared To-Do</a> checks rosters signed by the list's own key.`,
        html`<strong>Delegated authority.</strong> Mandates checks a chain of credentials leading back to a principal.`,
        html`<strong>Local decisions.</strong> Trust-core's <code>Policies</code> runs Rego policy on the party's own device.`,
      ],
      note: html`There is no general trust-registry library in this toolkit yet.`,
    },
    sources: [
      { href: X.toip, label: "Trust over IP Foundation" },
      { href: X.toipModel, label: "The ToIP model: technology, governance, and ecosystems" },
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
    here: {
      libraries: ["eventlog"],
      points: [
        html`<strong>Verifiable key histories.</strong> Write KERI 1.0 logs with Ed25519 or P-256 keys, witnesses, and watchers. Interoperability tests verify the logs with KERIpy 1.3.6.`,
        html`<strong>Audit trails.</strong> The toolkit adds its own signed logs, called <em>trails</em>. A key rotation seals the open trails.`,
      ],
      note: html`Delegated identifiers, weighted thresholds, and KERI 2.0 are unsupported and rejected.`,
    },
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

      A membership proof is one application: a person shows they belong to an accepted group without revealing their membership record. The verifier still needs rules for which issuers, group roots, and proof systems it accepts.
    `,
    diagram: zkDiagram(),
    caption: "Group membership in zero knowledge: the verifier checks a signed root and a nullifier, and never sees the leaf.",
    here: {
      libraries: ["anon-membership"],
      points: [
        html`<strong>Membership proofs.</strong> Prove membership in one of up to four groups and check attribute requirements.`,
        html`<strong>Repeat participation.</strong> A scope-specific nullifier lets a verifier recognize the same membership without learning which record it is.`,
        html`<strong>Disclosure scope.</strong> Field-level credential disclosure with BBS or SD-JWT is not implemented.`,
      ],
      noteLabel: "Experimental cryptography",
      note: html`The library uses Noir and Barretenberg's UltraHonk in a mode <strong>designed to be zero-knowledge</strong>. Its authors found no published proof of that property, and Noir is not yet intended for production use.`,
    },
    sources: [
      { href: X.noir, label: "Noir" },
      { href: X.barretenberg, label: "Barretenberg (in Aztec's repository)" },
      { href: X.semaphore, label: "Semaphore, an earlier design for anonymous group signalling" },
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
    ${pageHead("Core concepts", "Identity, messaging, credentials, governance, and proofs: what each does and how this toolkit uses it.")}
    <div class="prose">
      <p>Each section links to its specifications. For the communities behind them and their different implementation choices, see the <a href="${u("/ecosystem/")}">ecosystem guide</a>.</p>
    </div>
    ${concepts.map(
      (c) => html`<section class="concept" id="${c.id}" aria-labelledby="${c.id}-h">
      <h2 id="${c.id}-h">${c.title}</h2>
      <p class="lede prose">${c.short}</p>
      <div class="prose">${c.body}</div>
      <figure class="diagram"><div class="diagram__scroll" tabindex="0">${c.diagram}</div><figcaption>${c.caption}</figcaption></figure>
      <div class="concept-implementation">
        <div class="concept-implementation__heading"><span aria-hidden="true">&lt;/&gt;</span><h3>In this toolkit</h3></div>
        <div class="concept-implementation__libraries">${c.here.libraries.map((slug) => libLink(slug))}</div>
        <ul class="concept-implementation__points">${c.here.points.map((point) => html`<li>${point}</li>`)}</ul>
        ${c.here.note ? html`<div class="concept-implementation__note"><strong>${c.here.noteLabel ?? "Scope"}</strong><p>${c.here.note}</p></div>` : ""}
      </div>
      <div class="sources"><strong>Read the source</strong><ul>${c.sources.map((s) => html`<li><a href="${s.href}">${s.label}</a></li>`)}</ul></div>
    </section>`,
    )}
  </div>
</div>`;
  return {
    path: "/concepts/",
    title: "Core concepts",
    description: "Decentralized identifiers, verifiable credentials, the Trust Spanning Protocol, Trust Tasks, governance, KERI and zero-knowledge membership, in plain words.",
    section: "concepts",
    body,
  };
}
