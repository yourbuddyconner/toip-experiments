import { REPO, u } from "../../build/config";
import { html } from "../../build/html";
import { externals as X } from "../data/links";
import type { Page } from "../layout";

export function ecosystemPage(): Page {
  const body = html`
<div class="wrap">
  <header class="page-head ecosystem-head">
    <p class="eyebrow">A field guide for ToIP builders</p>
    <h1>Shared ideas.<br><em>Different approaches.</em></h1>
    <p class="lede">ToIP, First Person, OpenVTC, and the P2P Trust Stack are connected communities and projects. They have different scopes, architectures, and implementation choices.</p>
  </header>

  <nav class="guide-nav" aria-label="Ecosystem guide">
    <a href="#orientation">The landscape</a><a href="#approaches">The approaches</a><a href="#choices">The differences</a><a href="#this-toolkit">This toolkit</a>
  </nav>

  <section class="guide-intro" id="orientation" aria-labelledby="orientation-h">
    <div class="prose">
      <p class="eyebrow">Start with the architecture</p>
      <h2 id="orientation-h">Coming from ToIP?</h2>
      <p>The <a href="${X.toip}">Trust over IP Foundation</a> develops an architecture for digital trust, pairing technology with governance. Its model leaves ecosystems in control of their own implementations. A ToIP specification, a network built around it, and a software package implementing it are different things.</p>
      <p>That distinction matters here. You can use TSP without adopting a particular community model, use KERI for key histories without deploying a complete agent stack, or implement Trust Tasks over different transports. The <a href="${X.toipModel}">ToIP model</a> makes room for that diversity.</p>
    </div>
    <aside class="field-note">
      <span class="field-note__mark" aria-hidden="true">↗</span>
      <h3>Read the choices, not just the names.</h3>
      <p>Two projects can use “agent,” “community,” or “trust task” and still differ in who holds keys, how messages move, and how authority is checked.</p>
      <a href="#choices">Compare the implementation choices</a>
    </aside>
  </section>

  <table class="rows landscape">
    <caption>The names you'll encounter</caption>
    <thead><tr><th scope="col">Name</th><th scope="col">What it contributes</th><th scope="col">Start here</th></tr></thead>
    <tbody>
      <tr><th scope="row">ToIP</th><td>Architecture, governance frameworks, and protocol specifications.</td><td><a href="${X.toipModel}">The model</a> · <a href="${X.tspSpec}">TSP</a></td></tr>
      <tr><th scope="row">First Person</th><td>A network vision centered on personhood and real trust relationships.</td><td><a href="#first-person">The network vision</a></td></tr>
      <tr><th scope="row">OpenVTC / VTI</th><td>Agent and community services, applications, and protocol libraries.</td><td><a href="#openvtc">The service approach</a></td></tr>
      <tr><th scope="row">P2P Trust Stack</th><td>TrustStackers' integrated agent stack with libp2p networking.</td><td><a href="#p2p">The agent approach</a></td></tr>
      <tr><th scope="row">KERI / WebOfTrust</th><td>Key-event histories, pre-rotation, witnesses, and supporting implementations.</td><td><a href="#keri">The key-history approach</a></td></tr>
      <tr><th scope="row">DIF / DIDComm</th><td>Decentralized identity engineering and a distinct messaging protocol family.</td><td><a href="#dif">The messaging approach</a></td></tr>
      <tr><th scope="row">W3C DIDs / VCs</th><td>Shared identifier and credential data models used across projects.</td><td><a href="${X.didCore}">DIDs</a> · <a href="${X.vc2}">Credentials</a></td></tr>
      <tr><th scope="row">Trust Tasks</th><td>A ToIP task framework and registry of interaction specifications.</td><td><a href="#trust-tasks">The task vocabulary</a></td></tr>
    </tbody>
  </table>

  <section class="guide-section" id="approaches" aria-labelledby="approaches-h">
    <div class="section-heading"><p class="eyebrow">Different starting points</p><h2 id="approaches-h">What each approach emphasizes</h2></div>
    <p class="prose">These perspectives overlap. People contribute across communities, and one system can combine several of them. The differences below describe documented design choices, rather than fixed camps.</p>
    <div class="approach-grid">
      <article class="approach approach--network" id="first-person">
        <p class="eyebrow">Network vision</p><h3>First Person</h3>
        <p class="approach__question">How do real relationships become verifiable?</p>
        <p>The First Person Project starts with people and their relationships. Its white paper proposes personhood credentials issued within an ecosystem, relationship credentials exchanged between people, and a network built from those connections.</p>
        <p>The First Person Network is the intended network; the First Person Cooperative is the governance body proposed in the paper. Neither name identifies a single software distribution.</p>
        <p class="approach__source"><a href="${X.firstPersonPaper}">Read the First Person white paper</a></p>
      </article>
      <article class="approach approach--services" id="openvtc">
        <p class="eyebrow">Service infrastructure</p><h3>OpenVTC &amp; VTI</h3>
        <p class="approach__question">How do agents and communities operate?</p>
        <p>OpenVTC contains several projects. Its Rust Verifiable Trust Infrastructure implementation provides VTA services for keys and authority, and VTC services for community membership and credentials. The separate VTI specification defines their composition, trust contexts, and client authority.</p>
        <p>OpenVTC also publishes TypeScript protocol libraries. This toolkit uses those libraries; it does not deploy the full VTI service architecture.</p>
        <p class="approach__source"><a href="${X.vti}">VTI implementation</a> · <a href="${X.vtiSpec}">VTI specification</a> · <a href="${X.openvtcTsp}">TypeScript TSP library</a></p>
      </article>
      <article class="approach approach--agents" id="p2p">
        <p class="eyebrow">Integrated agent stack</p><h3>P2P Trust Stack</h3>
        <p class="approach__question">What does a complete peer agent need?</p>
        <p>TrustStackers' implementation brings identity, an encrypted keystore, TSP messaging, relationship ceremonies, communities, and an application API into one Node.js stack.</p>
        <p>Its documented choices include <code>did:peer:4</code> and <code>did:scid:vh</code>, libp2p transport, and a structured local policy interpreter. That is a specific implementation of related ideas, with different APIs and deployment assumptions from OpenVTC or this toolkit.</p>
        <p class="approach__source"><a href="${X.p2pRepo}">Read the P2P Trust Stack README</a> · <a href="${X.p2pPolicy}">Policy implementation</a></p>
      </article>
      <article class="approach approach--keys" id="keri">
        <p class="eyebrow">Key-event architecture</p><h3>KERI &amp; WebOfTrust</h3>
        <p class="approach__question">How does an identity survive changes to its keys?</p>
        <p>KERI starts with verifiable key history: an identifier's signed events record key establishment and rotation, while witnesses and watchers help expose conflicting histories. KERIpy, in the WebOfTrust organization, is an implementation.</p>
        <p>The KERI specification is developed within ToIP. It addresses an identity foundation that other systems can build on; it does not prescribe every application, transport, or community rule.</p>
        <p class="approach__source"><a href="${X.keriSpec}">KERI specification</a> · <a href="${X.keripy}">KERIpy</a></p>
      </article>
      <article class="approach approach--messaging" id="dif">
        <p class="eyebrow">Identity engineering &amp; messaging</p><h3>DIF &amp; DIDComm</h3>
        <p class="approach__question">How do identity agents exchange messages?</p>
        <p>The Decentralized Identity Foundation develops specifications and reference implementations across decentralized identity. DIDComm is one of its messaging efforts: encrypted messages, routing, and higher-level interactions built around DIDs.</p>
        <p>DIDComm and TSP are distinct protocols. Sharing DIDs or an application goal does not make their messages interchangeable. This toolkit currently uses TSP.</p>
        <p class="approach__source"><a href="${X.dif}">Explore DIF</a> · <a href="${X.didcomm}">DIDComm specification</a></p>
      </article>
      <article class="approach approach--tasks" id="trust-tasks">
        <p class="eyebrow">Interaction specifications</p><h3>Trust Tasks</h3>
        <p class="approach__question">What work are the parties agreeing to do?</p>
        <p>The Trust Tasks effort under ToIP's Decentralized Trust Graph Working Group defines a JSON task framework and a registry of specifications. Tasks describe interactions; delivery is a separate concern.</p>
        <p>A task can travel over different transports. A registry entry also does not establish that a particular agent implements it. This site's <a href="${u("/spec/")}">task reference</a> documents the project-specific types used here.</p>
        <p class="approach__source"><a href="${X.trustTasksTf}">Framework and registry source</a> · <a href="${X.trustTasks}">Browse the registry</a></p>
      </article>
    </div>
  </section>

  <section class="guide-section" id="choices" aria-labelledby="choices-h">
    <div class="section-heading"><p class="eyebrow">Where the differences matter</p><h2 id="choices-h">Compare decisions, not labels</h2></div>
    <table class="rows choices">
      <thead><tr><th scope="col">Decision</th><th scope="col">This toolkit</th><th scope="col">Other approaches</th></tr></thead>
      <tbody>
        <tr><th scope="row">Identity</th><td data-label="This toolkit"><code>did:key</code> for messaging; KERI histories in the event-log library.</td><td data-label="Other approaches">The P2P Trust Stack supports <code>did:peer:4</code> and <code>did:scid:vh</code>. KERI models identity through a key-event history.</td></tr>
        <tr><th scope="row">Messaging</th><td data-label="This toolkit">TSP Direct over a WebSocket relay, an in-memory bus, or the mesh transport.</td><td data-label="Other approaches">The P2P Trust Stack integrates libp2p. DIDComm defines another message protocol, independently of its delivery transport.</td></tr>
        <tr><th scope="row">Authority</th><td data-label="This toolkit">Credential-based mandates and local Rego policy checks.</td><td data-label="Other approaches">The P2P Trust Stack has its own policy interpreter. VTI specifies authority within trust contexts and client enrollment.</td></tr>
        <tr><th scope="row">Deployment</th><td data-label="This toolkit">Separate libraries and example apps for browsers and Node.</td><td data-label="Other approaches">TrustStackers documents a Node-only agent stack. OpenVTC's VTI implementation runs Rust services and clients.</td></tr>
      </tbody>
    </table>
    <p class="prose small quiet">These comparisons describe the sources linked above. Shared protocol names are not an interoperability result: this toolkit has not been tested against the P2P Trust Stack.</p>
  </section>

  <section class="toolkit-position" id="this-toolkit" aria-labelledby="this-toolkit-h">
    <div><p class="eyebrow">Where we fit</p><h2 id="this-toolkit-h">An independent<br>place to experiment.</h2></div>
    <div>
      <p>toip.tools is a collection of TypeScript libraries and runnable examples. It uses OpenVTC's TSP and Trust Tasks libraries, W3C-shaped credentials, and its own application protocols. The relay, mandates, anonymous membership proofs, and audit trails reflect choices made in this repository.</p>
      <p>Use it to explore those choices in code. For the architecture behind another project, start with that project's documentation.</p>
      <p class="actions"><a class="btn" href="${u("/quickstart/")}">Try the toolkit <span aria-hidden="true">↗</span></a><a href="${REPO}">Read the source</a></p>
    </div>
  </section>
</div>`;
  return {
    path: "/ecosystem/",
    title: "Ecosystem",
    description: "Understand ToIP, First Person, OpenVTC, the P2P Trust Stack, KERI, and DIF: their roles, implementation choices, and relationship to this toolkit.",
    section: "ecosystem",
    body,
  };
}
