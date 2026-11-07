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
    short: "Names that their owners make, not names a provider hands out.",
    body: md`
      A decentralized identifier (DID) is an identifier its subject creates and controls. It resolves to a short document listing keys, so whoever holds a DID can check that subject's signatures and encrypt to them. How a DID resolves depends on its *method*.

      \`did:key\` is the simplest method: the identifier is the public key itself, encoded. Resolving it needs no network and no registry. The cost is that its key can never change: lose or leak the key and the identifier goes with it. That suits short-lived or low-stakes identities, and tutorials.

      The P2P Trust Stack uses \`did:peer:4\` between parties and \`did:scid:vh\`, a self-certifying method with a hash-chained history, key pre-rotation and witnesses. KERI, below, is another answer to the same problem: an identifier whose keys can rotate.
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
    short: "Signed claims anyone can check, and a way to take them back.",
    body: md`
      A credential is a signed statement by an *issuer* about a *subject*: "Bob is a member of the Riverside Community Garden." The *holder* keeps it and shows it to whoever needs it. The *verifier* checks the issuer's signature and decides whether it trusts that issuer for that kind of claim. The issuer isn't asked, and doesn't learn that the credential was used.

      To revoke, the issuer publishes a signed list with one bit per credential it issued; each credential names its position. A verifier fetches the list from anywhere, because the signature makes any copy trustworthy, and checks the bit. Because one list covers many credentials, fetching it doesn't say which one is being checked.
    `,
    diagram: credentialDiagram(),
    caption: "Three roles. The verifier trusts the issuer, not the holder, and not whoever hosts the status list.",
    here: html`${libLinks(["trust-core"])} issues and verifies credentials in the W3C Verifiable Credentials 2.0 shape, signed with Data Integrity <code>eddsa-jcs-2022</code> proofs (<code>issueCredential</code>, <code>verifyCredential</code>). Its <code>StatusList</code> is its own signed format, after the W3C Bitstring Status List, not that format exactly. ${libLinks(["mandates"])} builds delegation on the same credentials.`,
    sources: [
      { href: X.vc2, label: "W3C Verifiable Credentials Data Model v2.0" },
      { href: X.bitstring, label: "W3C Bitstring Status List" },
      { href: X.diEddsa, label: "W3C Data Integrity EdDSA Cryptosuites" },
    ],
  },
  {
    id: "tsp",
    title: "The Trust Spanning Protocol",
    short: "Messages that prove who sent them and that only the recipient can read, over any transport.",
    body: md`
      TSP is ToIP's message layer, the "spanning" layer that every trust interaction crosses. A TSP message names its sender and receiver by verifiable identifiers (VIDs), seals its payload to the receiver with HPKE in authenticated mode, and is signed by the sender. The receiver checks the signature against the sender's VID before trusting anything inside. Whoever carries the message, a relay, a radio or a USB stick, only has to be trusted to deliver it.

      In *Direct* mode, which this toolkit uses, both VIDs travel in the clear, so a carrier learns who is talking to whom. The specification also defines *Routed* and *Nested* modes, in which intermediaries forward messages without learning both ends. The P2P Trust Stack runs TSP with CESR encoding over libp2p, and starts each relationship with an invitation and an acceptance (\`TSP_RFI\`, \`TSP_RFA\`).
    `,
    diagram: tspDiagram(),
    caption: "What each part of a Direct-mode TSP message reveals. The landing page shows a real one, byte for byte.",
    here: html`${libLinks(["trust-core"])} sends real TSP Direct messages through <code>@openvtc/vti-tsp-js</code>, over the in-memory <code>Bus</code> or ${libLinks(["relay"])}. Relationships start with the first Direct message, not the invitation handshake, and the relay is a WebSocket mailbox, not Routed mode. ${libLinks(["mesh-transport"])}, being built, carries the same messages over radio and hides the identifiers on the air.`,
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
    short: "Typed, signed requests between parties: the verbs of a trust relationship.",
    body: md`
      A Trust Task is one step of work between two parties who have a trusted channel: issue an endorsement, ask to join a community, approve a payment. The framework fixes one envelope for all of them: an \`id\`, a \`type\` that is a specification's URI, the \`issuer\` and \`recipient\`, when it was issued and when it expires, an optional proof, and the payload. A response uses the same type with \`#response\` appended.

      Before a handler sees a document, the receiving side checks it: is it fresh, has it been seen before, does it carry the proof its type requires, is the payload acceptable. The public registry at trusttasks.org published about 1,400 task specifications when this repository read it, from community membership to voting. A specification says what a task means. It doesn't mean anyone has implemented it.
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
    short: "Signatures tell you who said something. Governance tells you whether they count.",
    body: md`
      A credential from "the garden" is only worth something if the verifier knows the garden's DID and accepts it as the authority on who is a member. Ecosystems write those decisions down: a governance framework says who may issue what, how members join and leave, and how disputes go. A trust registry answers the question a verifier actually has: *is this DID allowed to issue this kind of credential?*

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
    short: "Identifiers whose keys can change, with a history nobody can quietly rewrite.",
    body: md`
      KERI (Key Event Receipt Infrastructure) gives an identifier a history instead of a fixed key. The identifier (an AID) is a digest of its *inception* event, which lists the current keys and a digest of the *next* keys. Rotating reveals those pre-committed keys, so a thief who steals only the current key can't rotate to keys of their own. Every event is signed and appended to the identifier's key event log (KEL).

      *Witnesses* receipt the first version of each event they see. A controller who shows one history to some people and another to others commits *duplicity*, and *watchers* catch it by comparing what witnesses hold. A signature made last year still verifies against the key that was current last year.
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
    short: "Prove what's needed, and nothing else.",
    body: md`
      Showing a whole credential reveals everything in it, and showing the same one twice links the two visits. *Selective disclosure* reveals some claims and withholds others. *Zero-knowledge proofs* go further: they prove a statement about your credentials, such as "I am a current employee" or "I am over 18", without revealing the credentials.

      The P2P Trust Stack plans profile credentials with a visibility level "available only through a zero-knowledge proof", without a protocol for it yet, and the Trust Tasks registry already has a task in which a member's agent proves that enough distinct vetters attested for it.
    `,
    diagram: zkDiagram(),
    caption: "Group membership in zero knowledge: the verifier checks a signed root and a nullifier, and never sees the leaf.",
    here: html`${libLinks(["anon-membership"])} does one kind: a member proves they are in one of up to four groups, that their attributes meet some predicates, and gives a nullifier that's stable per scope, so a verifier can count distinct members without knowing them. It uses Noir and Barretenberg's UltraHonk, which is <strong>designed to be zero-knowledge</strong>: its authors found no published proof that it is, and Noir isn't yet for production use. Field-by-field selective disclosure of one credential (BBS, SD-JWT) isn't implemented here.`,
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
    <h2>On this page</h2>
    <ul>${concepts.map((c) => html`<li><a href="#${c.id}">${c.title}</a></li>`)}</ul>
  </nav>
  <div>
    ${pageHead("Concepts", "The ideas under the toolkit, in plain words, with the specifications they come from and what this repository implements of each.")}
    <div class="prose">
      <p>Each section ends with what the toolkit does about that idea, and where it differs from the stack. What it says about the P2P Trust Stack comes from the repository's ${S("S01-p2p-trust-stack-site.md")} and its ${html`<a href="${gh("docs/sources/S02-trust-tasks-registry-and-openvtc.md")}">follow-up</a>`}, which record that the stack's pages were read through summaries. Check the stack's own pages before relying on a detail.</p>
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
