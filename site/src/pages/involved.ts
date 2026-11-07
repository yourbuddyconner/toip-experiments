import { REPO, gh, ghTree, u } from "../../build/config";
import { html } from "../../build/html";
import { externals as X } from "../data/links";
import type { Page } from "../layout";
import { pageHead } from "../parts";

export function involvedPage(): Page {
  const body = html`
<div class="wrap">
  ${pageHead("Help put the protocols to work", "Try an example, test interoperability, improve the docs, or build something new. Implementations give open specifications something concrete to learn from.")}
  <div class="prose">
    <h2 id="toip">The Trust over IP Foundation</h2>
    <p>The <a href="${X.toip}">Trust over IP Foundation</a> develops specifications through working groups and task forces. Its website explains how to participate, and drafts and discussions are on <a href="${X.toipGithub}">GitHub</a>. This toolkit draws on:</p>
    <ul>
      <li>The <a href="${X.tspRepo}">Trust Spanning Protocol specification</a> (<a href="${X.tspSpec}">read the current draft</a>).</li>
      <li>The <a href="${X.trustTasksTf}">Trust Tasks task force</a>, which maintains the envelope and the specifications published at <a href="${X.trustTasks}">trusttasks.org</a>.</li>
      <li>The <a href="${X.keriSpec}">KERI</a> and <a href="${X.cesrSpec}">CESR</a> specifications.</li>
    </ul>
    <p>In 2025 ToIP and DIF <a href="${X.lfdtWorkingGroups}">announced three new working groups for trust in the age of AI</a>, including the Decentralized Trust Graph Working Group, whose trust tasks work this toolkit builds on. The <a href="${u("/examples/#agents")}">Agents</a> design names the AI and Human Trust working group as the place to bring it.</p>

    <h2 id="p2p">The P2P Trust Stack</h2>
    <p>The <a href="${X.p2pStack}">P2P Trust Stack</a>, a partner project of the <a href="${X.firstPerson}">First Person Cooperative</a>, explores the stack from identifiers through applications. Start with its <a href="${X.p2pGlossary}">glossary</a>, or inspect the TypeScript implementation at <a href="${X.trustStackers}">TrustStackers</a>.</p>
    <p>This toolkit uses the <a href="${X.openvtc}">OpenVTC</a> implementations of TSP and Trust Tasks. The Trust Tasks framework also has implementations in Rust, Go, and Dart. Testing interoperability between this toolkit and the P2P Trust Stack would be a useful contribution; it has not yet been verified.</p>

    <h2 id="iiw">IIW</h2>
    <p>The <a href="${X.iiw}">Internet Identity Workshop</a> brings this work into the same room. This repository began there in November 2026, after sessions on zero-knowledge policy and the P2P Trust Stack. A working demo and a clear question are good ways to join the conversation.</p>

    <h2 id="repo">This repository</h2>
    <p>The code and this site live in <a href="${REPO}">toip-experiments</a>. Run <code>npm test</code> at the repository root, or open <a href="${REPO}/issues">an issue</a> with a question, bug report, or correction.</p>
    <p><a href="${ghTree("docs/sources")}">Source notes</a> record what informed the work and the limits of those sources. <a href="${ghTree("docs/decisions")}">Decision records</a> explain changes in direction, and project designs document the implementation choices. Corrections are welcome throughout.</p>

    <h2 id="propose">Propose a new example</h2>
    <p>A useful example makes a ToIP idea tangible for people with a real problem. To add one:</p>
    <ol>
      <li>Open an issue saying who it's for, what trust problem it solves, and which libraries it would use.</li>
      <li>Write <code>projects/&lt;name&gt;/docs/design.md</code>. Describe the idea, its users, the threat model, the Trust Tasks, and the shared libraries it needs. <a href="${gh("projects/tipline/docs/design.md")}">Tipline's design</a> is a useful model.</li>
      <li>Follow the repository's <a href="${gh("docs/provenance.md")}">provenance rules</a>: claims about the stack cite a source note, ideas of our own are marked as ours, and a guess is labeled a guess.</li>
      <li>Build it as a workspace under <code>projects/</code>. Define its message types with <code>ourSpec("&lt;name&gt;/…")</code> and add a line for each to <a href="${gh("site/src/data/spec-notes.json")}"><code>site/src/data/spec-notes.json</code></a>; <a href="${u("/spec/")}">a spec page</a> appears for each type at the next build.</li>
      <li>Add it to the <a href="${gh("site/src/data/projects.ts")}">examples list</a> and mark its status: working, being built, or design only.</li>
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
