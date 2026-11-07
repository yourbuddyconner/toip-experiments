import { existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_DIR, SITE_DIR, gh, ghTree, u } from "../../build/config";
import { githubSlug, html, md, mdi, type Raw } from "../../build/html";
import { code } from "../../build/highlight";
import { exampleSource, splitLeadComment } from "../../build/source";
import { libraries, type Library } from "../data/libraries";
import { projectBySlug } from "../data/projects";
import type { Page } from "../layout";
import { pageHead, status } from "../parts";

function side(current?: string): Raw {
  return html`<nav class="docs__side" aria-label="Libraries">
    <p class="side-h">Toolkit</p>
    <ul><li><a href="${u("/toolkit/")}"${current ? "" : html` aria-current="page"`}>Overview</a></li></ul>
    <p class="side-h">Libraries</p>
    <ul>${libraries.map((l) => html`<li><a href="${u(`/toolkit/${l.slug}/`)}"${current === l.slug ? html` aria-current="page"` : ""}><code>${l.slug}</code></a></li>`)}</ul>
  </nav>`;
}

const useFromRepo = (name: string) => `// Not on npm yet. Inside the repository (see "Use the libraries" on the toolkit page):
import { … } from "${name}";`;

function outputFor(slug: string): string | undefined {
  const f = join(SITE_DIR, "examples/snippets/output", `${slug}.txt`);
  return existsSync(f) ? exampleSource(`examples/snippets/output/${slug}.txt`) : undefined;
}

const hasReadme = (l: Library) => existsSync(join(REPO_DIR, l.dir, "README.md"));
const entry = (l: Library) => (existsSync(join(REPO_DIR, l.dir, "src/index.ts")) ? `${l.dir}/src/index.ts` : `${l.dir}/src/server.ts`);

function libPage(l: Library): Page {
  const snip = l.snippet ? splitLeadComment(exampleSource(`examples/snippets/${l.snippet.file}`)) : undefined;
  const out = l.snippet?.runs ? outputFor(l.slug) : undefined;
  const designMesh = gh("projects/mesh/docs/design.md", githubSlug("19.1 `packages/mesh-transport` API"));
  const body = html`
<div class="wrap docs">
  ${side(l.slug)}
  <div>
    <div class="page-head">
      <h1 class="mono" style="font-size: clamp(1.7rem, 4vw, 2.6rem)">${l.name}</h1>
      <p class="lede">${l.does}</p>
    </div>
    <dl class="facts">
      <dt>Status</dt><dd>${status(l.status)}</dd>
      <dt>Runs in</dt><dd>${mdi(l.runsIn)}</dd>
      <dt>Built on</dt><dd>${mdi(l.builtOn)}</dd>
      <dt>Used by</dt><dd>${l.usedBy.map((p, i) => html`${i ? ", " : ""}<a href="${u(`/examples/#${p}`)}">${projectBySlug(p).name}</a>`)}</dd>
      ${l.specs ? html`<dt>Trust Tasks</dt><dd><a href="${u(`/spec/#${l.specs}`)}">The <code>${l.specs}/…</code> types</a></dd>` : ""}
      <dt>Source</dt><dd>${l.status === "in progress" ? html`<a href="${designMesh}">The Mesh design, section 19.1</a> (the package is being built)` : hasReadme(l) ? html`<a href="${ghTree(l.dir)}"><code>${l.dir}</code></a> and its <a href="${gh(`${l.dir}/README.md`)}">README</a>` : html`<a href="${ghTree(l.dir)}"><code>${l.dir}</code></a> (no README yet; start at <a href="${gh(entry(l))}"><code>${entry(l).slice(l.dir.length + 1)}</code></a>)`}</dd>
    </dl>
    <div class="prose">${md(l.about)}</div>

    <div class="prose">
      <h2>When to use it</h2>
      <ul>${l.reachFor.map((r) => html`<li>${mdi(r)}</li>`)}</ul>
      ${l.notFor ? html`<h3>Limitations</h3><ul>${l.notFor.map((r) => html`<li>${mdi(r)}</li>`)}</ul>` : ""}
    </div>

    ${
      snip
        ? html`<h2>Example</h2>
    <div class="prose"><p>${snip.lead}</p>${l.snippet!.note ? html`<p class="small quiet">${l.snippet!.note}</p>` : ""}</div>
    ${code(snip.code, "ts", { caption: `site/examples/snippets/${l.snippet!.file}: ${l.snippet!.caption}` })}
    ${
      l.snippet!.runs
        ? html`${code(`npx tsx --tsconfig site/tsconfig.json site/examples/snippets/${l.snippet!.file}`, "bash", { caption: "Run it from the repository root" })}
    ${out ? code(out, "console", { caption: "Recorded output" }) : ""}`
        : ""
    }`
        : html`<h2>Explore the API</h2><div class="prose"><p>For the transport API and usage examples, start with <a href="${gh(`${l.dir}/README.md`)}">the package README</a>. The architecture is documented in <a href="${designMesh}">section 19.1 of the Mesh design</a>.</p></div>`
    }

    <h2>Import</h2>
    ${code(useFromRepo(l.name), "ts", { caption: "Import" })}
    ${l.subpaths ? html`<div class="prose"><ul>${l.subpaths.map((s) => html`<li><code>${s.path}</code>: ${s.what}.</li>`)}</ul></div>` : ""}

    <h2>API at a glance</h2>
    <div class="api">${l.api.map((a) => html`<div><h4>${a.area}</h4><p>${a.names.map((n) => html`<code>${n}</code> `)}</p></div>`)}</div>
    <div class="prose"><p>${l.status === "in progress" ? html`These are the design's names and may change.` : hasReadme(l) ? html`The full list, with every option, is in the <a href="${gh(`${l.dir}/README.md`)}">README</a> and <a href="${gh(entry(l))}"><code>${entry(l).slice(l.dir.length + 1)}</code></a>.` : html`Everything it exports is in <a href="${gh(entry(l))}"><code>${entry(l).slice(l.dir.length + 1)}</code></a>, with short comments on each.`}</p></div>
  </div>
</div>`;
  return { path: `/toolkit/${l.slug}/`, title: l.name, description: `${l.name}: ${l.does}`, section: "toolkit", body };
}

function indexPage(): Page {
  const body = html`
<div class="wrap docs">
  ${side()}
  <div>
    ${pageHead("The building blocks", "Eight TypeScript libraries, from identity and messaging to delegation and audit trails. Choose a library to see where it fits, how to use it, and what it exports.")}
    <table class="rows">
      <thead><tr><th scope="col">Library</th><th scope="col">What it does</th><th scope="col">Status</th></tr></thead>
      <tbody>${libraries.map((l) => html`<tr><th scope="row"><a href="${u(`/toolkit/${l.slug}/`)}"><code>${l.slug}</code></a></th><td>${l.does}</td><td>${status(l.status)}</td></tr>`)}</tbody>
    </table>

    <div class="prose">
      <h2 id="use">Use the libraries</h2>
      <p>The packages aren't published to npm yet. You can use them as local workspaces or point TypeScript directly at the source. Every example on this site is typechecked against that source.</p>
      <h3>Build inside the repository</h3>
      <p>Create a project under <code>projects/</code> and add it to <code>workspaces</code> in the root <code>package.json</code>. Declare the libraries as dependencies at version <code>0.0.0</code>, following <a href="${gh("projects/settle/package.json")}">Settle's example</a>. Then run <code>npm install</code> at the root to link them.</p>
    </div>
    ${code(`{\n  "name": "my-app",\n  "type": "module",\n  "dependencies": {\n    "@toip-tools/trust-core": "0.0.0",\n    "@toip-tools/relay": "0.0.0"\n  }\n}`, "json", { caption: "projects/my-app/package.json" })}
    <div class="prose">
      <h3>Point TypeScript at the source</h3>
      <p>The packages expose TypeScript source directly. A <code>paths</code> mapping lets <code>tsc</code> and <code>tsx</code> resolve their import names to local entry points; bundlers may need matching aliases. The configuration below runs this site's examples. Install dependencies at the repository root first.</p>
    </div>
    ${code(exampleSource("tsconfig.json"), "json", { caption: "site/tsconfig.json" })}
  </div>
</div>`;
  return {
    path: "/toolkit/",
    title: "Toolkit",
    description: "TypeScript libraries for Trust over IP: identities and TSP messaging, a relay, COSE, a passkey vault, delegation, zero-knowledge membership, KERI event logs, and radio transport.",
    section: "toolkit",
    body,
  };
}

export function toolkitPages(): Page[] {
  return [indexPage(), ...libraries.map(libPage)];
}
