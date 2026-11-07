import { REPO, gh, ghTree, u } from "../../build/config";
import { html } from "../../build/html";
import { externals as X } from "../data/links";
import type { Page } from "../layout";
import { pageHead } from "../parts";

export function involvedPage(): Page {
  const body = html`
<div class="wrap">
  ${pageHead("Get involved", "The specifications are written in the open, and the people writing them want implementations to test against. Here is where that work happens, and how to add an example of your own.")}
  <div class="prose">
    <h2 id="toip">The Trust over IP Foundation</h2>
    <p>The <a href="${X.toip}">Trust over IP Foundation</a> develops the specifications this toolkit implements, in working groups and task forces; its site explains how to join them. Their drafts and discussions are on <a href="${X.toipGithub}">GitHub</a>. Three you'll meet here:</p>
    <ul>
      <li>The <a href="${X.tspRepo}">Trust Spanning Protocol specification</a> (<a href="${X.tspSpec}">read the current draft</a>).</li>
      <li>The <a href="${X.trustTasksTf}">Trust Tasks task force</a>, which maintains the envelope and the specifications published at <a href="${X.trustTasks}">trusttasks.org</a>.</li>
      <li>The <a href="${X.keriSpec}">KERI</a> and <a href="${X.cesrSpec}">CESR</a> specifications.</li>
    </ul>
    <p>In 2025 ToIP and DIF <a href="${X.lfdtWorkingGroups}">announced three new working groups for trust in the age of AI</a>, including the Decentralized Trust Graph Working Group, whose trust tasks work this toolkit builds on. The <a href="${u("/examples/#agents")}">Agents</a> design names the AI and Human Trust working group as the place to bring it.</p>

    <h2 id="p2p">The P2P Trust Stack</h2>
    <p>The <a href="${X.p2pStack}">P2P Trust Stack</a> is a partner project of the <a href="${X.firstPerson}">First Person Cooperative</a>: a testbed for the four layers, from identifiers to applications. Its <a href="${X.p2pGlossary}">glossary</a> is a good map of the vocabulary. Its TypeScript implementation is at <a href="${X.trustStackers}">TrustStackers</a> on GitHub.</p>
    <p>This toolkit builds on the <a href="${X.openvtc}">OpenVTC</a> libraries, which implement TSP and Trust Tasks in TypeScript; the Trust Tasks framework also has implementations in Rust, Go and Dart. Whether the two implementations interoperate on the wire hasn't been tested. That's a good first contribution.</p>

    <h2 id="iiw">IIW</h2>
    <p>The <a href="${X.iiw}">Internet Identity Workshop</a> is an unconference at the Computer History Museum in Mountain View, where much of this work gets argued over in person. This repository started there, after sessions on zero-knowledge policy and on the P2P Trust Stack in November 2026. Bring a demo.</p>

    <h2 id="repo">This repository</h2>
    <p>Everything on this site comes from <a href="${REPO}">toip-experiments</a>. Run the tests with <code>npm test</code> at the root. Ask questions and report problems in <a href="${REPO}/issues">its issues</a>.</p>
    <p>The repository keeps a written record: <a href="${ghTree("docs/sources")}">source notes</a> say what was read about the stack and how reliable that reading is, <a href="${ghTree("docs/decisions")}">decisions</a> record each change of direction, and each project's design explains its choices. Corrections to any of them are welcome, especially where a claim about the stack is wrong.</p>

    <h2 id="propose">Propose a new example</h2>
    <p>An example earns its place by making one ToIP idea concrete for a real situation. To propose one:</p>
    <ol>
      <li>Open an issue saying who it's for, what trust problem it solves, and which libraries it would use.</li>
      <li>Write a design in <code>projects/&lt;name&gt;/docs/design.md</code>. The existing designs show the shape: the idea, who uses it, a threat model, the Trust Tasks it needs, and what it needs from shared code. <a href="${gh("projects/tipline/docs/design.md")}">Tipline's</a> is a good model.</li>
      <li>Follow the repository's <a href="${gh("docs/provenance.md")}">provenance rules</a>: claims about the stack cite a source note, ideas of our own are marked as ours, and a guess is labeled a guess.</li>
      <li>Build it as a workspace under <code>projects/</code>. Define its message types with <code>ourSpec("&lt;name&gt;/…")</code> and add a line for each to <a href="${gh("site/src/data/spec-notes.json")}"><code>site/src/data/spec-notes.json</code></a>; <a href="${u("/spec/")}">a spec page</a> appears for each type at the next build.</li>
      <li>Add it to this site's <a href="${gh("site/src/data/projects.ts")}">examples list</a> with an honest status.</li>
    </ol>
  </div>
</div>`;
  return {
    path: "/get-involved/",
    title: "Get involved",
    description: "Where Trust over IP work happens: the Trust over IP Foundation, the P2P Trust Stack, IIW, and this repository. How to propose a new example.",
    section: "involved",
    body,
  };
}
