import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLONE, REPO_DIR, gh, u } from "../../build/config";
import { code } from "../../build/highlight";
import { html } from "../../build/html";
import { docsNav } from "../docs-nav";
import type { Page } from "../layout";
import { pageHead } from "../parts";

export function docsPage(): Page {
  const version = JSON.parse(readFileSync(join(REPO_DIR, "packages/trust-core/package.json"), "utf8")).version as string;
  return {
    path: "/docs/",
    title: "Documentation",
    description: "Install the libraries from npm, run your first Trust Task, and find API documentation for the toip.tools TypeScript libraries.",
    section: "docs",
    body: html`<div class="wrap docs">
      ${docsNav("/docs/", [{ label: "Setup", href: "#setup" }, { label: "Work from the source", href: "#workspace" }, { label: "Next steps", href: "#next" }])}
      <div class="docs__content">
        ${pageHead("Documentation", "Build with TypeScript libraries for identities, private messages, credentials, delegation, and verifiable logs.")}
        <div class="prose">
          <p>Start with the <a href="${u("/quickstart/")}">Quickstart</a> for a complete trust exchange. Use the <a href="${u("/toolkit/")}">SDK reference</a> for imports, examples, and public API declarations, or <a href="${u("/concepts/")}">Concepts</a> for the protocols behind them.</p>
        </div>

        <section class="prose" aria-labelledby="setup">
          <h2 id="setup">Setup</h2>
          <p>You'll need Node 22.13 or later. Install the libraries you use from npm. Each is a separate package under <code>@toip-tools</code>; start with trust-core, which every other library builds on:</p>
          ${code("npm install @toip-tools/trust-core", "bash", { caption: "Terminal" })}
          <p>Add others as you need them, for example <code>@toip-tools/relay</code> for a message relay, <code>@toip-tools/mandates</code> for delegation, or <code>@toip-tools/eventlog</code> for verifiable logs. The <a href="${u("/toolkit/")}">SDK reference</a> lists all of them. The packages are ES modules with TypeScript declarations, and work in Node and, through a bundler, in browsers.</p>
          <p>To run this site's examples, or to change the libraries, clone the repository instead. Build the packages after installing:</p>
          ${code(`git clone ${CLONE}\ncd toip-tools\nnpm install\nnpm install --prefix site\nnpm run build`, "bash", { caption: "Work from the source" })}
          <p>From the repository root, run a signed, encrypted request and response over an in-memory transport:</p>
          ${code("npx tsx --tsconfig site/tsconfig.json site/examples/snippets/trust-core.ts", "bash", { caption: "Run the trust-core example" })}
          <p>Run all four Quickstart steps, including a local relay and credential revocation:</p>
          ${code("npm run quickstart --prefix site", "bash", { caption: "Run the Quickstart" })}
        </section>

        <section class="prose" aria-labelledby="workspace">
          <h2 id="workspace">Work from the source</h2>
          <p>The root <a href="${gh("package.json")}"><code>package.json</code></a> lists the libraries in <code>packages/</code> and applications in <code>projects/</code> as npm workspaces. Installing at the root links local package names such as <code>@toip-tools/trust-core</code>, <code>@toip-tools/mandates</code>, and <code>@toip-tools/mesh-transport</code>.</p>
          <p>To build an application in this repository, add it to the root workspace list and declare each library it uses as a dependency matching its package manifest. The current <a href="${gh("packages/trust-core/package.json")}">trust-core version</a> is <code>${version}</code>. Run <code>npm install</code> from the root after changing those manifests, then <code>npm run build</code> to create the packages' <code>dist/</code> JavaScript and type declarations. Standard package imports use those build outputs; the <code>@toip-tools/source</code> export condition selects TypeScript source for development.</p>
          <p>The standalone site examples instead resolve package names through <a href="${gh("site/tsconfig.json")}"><code>site/tsconfig.json</code></a>. Its <code>paths</code> map public imports to local source; pass that configuration to <code>tsx</code> as shown above. Subpath imports, such as <code>@toip-tools/mesh-transport/sim</code>, have explicit mappings. These paths apply to this checkout only; in your own project, install the packages from npm.</p>
        </section>

        <section class="prose" aria-labelledby="next">
          <h2 id="next">Next steps</h2>
          <ul>
            <li><a href="${u("/quickstart/")}">Quickstart</a>: create identities, exchange Trust Tasks, and verify credentials.</li>
            <li><a href="${u("/toolkit/")}">SDK reference</a>: choose a library and look up its public API.</li>
            <li><a href="${u("/spec/")}">Trust Task reference</a>: inspect the message types used by the applications.</li>
            <li><a href="${u("/examples/")}">Examples</a>: run complete applications and read their designs.</li>
          </ul>
        </section>
      </div>
    </div>`,
  };
}
