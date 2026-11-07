import { REPO, gh, u } from "../../build/config";
import { html } from "../../build/html";
import { externals as X } from "../data/links";
import type { Page } from "../layout";
import { pageHead } from "../parts";

export function involvedPage(): Page {
  const body = html`
<div class="wrap">
  ${pageHead("Contribute", "Report a bug, improve an example, test interoperability, or propose an application.")}
  <div class="prose">
    <h2 id="toip">Work on the protocols</h2>
    <p>For specification work, start with the <a href="${X.toip}">Trust over IP Foundation</a> and its <a href="${X.toipGithub}">working group repositories</a>. Relevant projects include:</p>
    <ul>
      <li>The <a href="${X.tspRepo}">Trust Spanning Protocol</a> (<a href="${X.tspSpec}">published specification</a>).</li>
      <li>The <a href="${X.trustTasksTf}">Trust Tasks task force</a>, which maintains the envelope and the specifications published at <a href="${X.trustTasks}">trusttasks.org</a>.</li>
      <li>The <a href="${X.keriSpec}">KERI</a> and <a href="${X.cesrSpec}">CESR</a> specifications.</li>
    </ul>
    <p>For other communities and implementations, use the <a href="${u("/ecosystem/")}">ecosystem guide</a>.</p>

    <h2 id="iiw">IIW</h2>
    <p>This project started at the <a href="${X.iiw}">Internet Identity Workshop</a> in November 2026.</p>

    <h2 id="repo">This repository</h2>
    <p>The code and this site live in <a href="${REPO}">toip-tools</a>. Run <code>npm test</code> at the repository root, or open <a href="${REPO}/issues">an issue</a> with a question, bug report, or correction.</p>

    <h2 id="propose">Propose a new example</h2>
    <p>To add an example:</p>
    <ol>
      <li>Open an issue saying who it's for, what trust problem it solves, and which libraries it would use.</li>
      <li>Write <code>projects/&lt;name&gt;/docs/design.md</code>. Describe the idea, its users, the threat model, the Trust Tasks, and the shared libraries it needs. <a href="${gh("projects/tipline/docs/design.md")}">Tipline's design</a> is a useful model.</li>
      <li>Build it as a workspace under <code>projects/</code>. Define its message types with <code>ourSpec("&lt;name&gt;/…")</code> and add a line for each to <a href="${gh("site/src/data/spec-notes.json")}"><code>site/src/data/spec-notes.json</code></a>; <a href="${u("/spec/")}">a spec page</a> appears for each type at the next build.</li>
      <li>Include run instructions, tests for the protocol behavior, and any known limitations. Add it to the <a href="${gh("site/src/data/projects.ts")}">examples list</a> with its current status: working, being built, or design only.</li>
    </ol>
  </div>
</div>`;
  return {
    path: "/get-involved/",
    title: "Contribute",
    description: "Contribute code, report bugs, work on specifications, or propose a new Trust over IP example.",
    section: "involved",
    body,
  };
}
