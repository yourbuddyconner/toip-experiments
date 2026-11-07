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
    description: "Set up the source workspace, run your first Trust Task, and find API documentation for the toip.tools TypeScript libraries.",
    section: "docs",
    body: html`<div class="wrap docs">
      ${docsNav("/docs/", [{ label: "Setup", href: "#setup" }, { label: "Use the libraries", href: "#workspace" }, { label: "Next steps", href: "#next" }])}
      <div class="docs__content">
        ${pageHead("Documentation", "Build with TypeScript libraries for identities, private messages, credentials, delegation, and verifiable logs.")}
        <div class="prose">
          <p>Start with the <a href="${u("/quickstart/")}">Quickstart</a> for a complete trust exchange. Use the <a href="${u("/toolkit/")}">SDK reference</a> for imports, examples, and public API declarations, or <a href="${u("/concepts/")}">Concepts</a> for the protocols behind them.</p>
        </div>

        <section class="prose" aria-labelledby="setup">
          <h2 id="setup">Setup</h2>
          <p>You'll need Git and Node 22.5 or later. Clone the repository, install its workspace dependencies and the site's separate tools, then build the packages:</p>
          ${code(`git clone ${CLONE}\ncd toip-tools\nnpm install\nnpm install --prefix site\nnpm run build`, "bash", { caption: "Terminal" })}
          <p>From the repository root, run a signed, encrypted request and response over an in-memory transport:</p>
          ${code("npx tsx --tsconfig site/tsconfig.json site/examples/snippets/trust-core.ts", "bash", { caption: "Run the trust-core example" })}
          <p>Run all four Quickstart steps, including a local relay and credential revocation:</p>
          ${code("npm run quickstart --prefix site", "bash", { caption: "Run the Quickstart" })}
        </section>

        <section class="prose" aria-labelledby="workspace">
          <h2 id="workspace">Use the libraries in a workspace</h2>
          <p>The root <a href="${gh("package.json")}"><code>package.json</code></a> lists the libraries in <code>packages/</code> and applications in <code>projects/</code> as npm workspaces. Installing at the root links local package names such as <code>@toip-tools/trust-core</code>, <code>@toip-tools/mandates</code>, and <code>@toip-tools/mesh-transport</code>.</p>
          <p>To build an application in this repository, add it to the root workspace list and declare each library it uses as a dependency matching its package manifest. The current <a href="${gh("packages/trust-core/package.json")}">trust-core version</a> is <code>${version}</code>. Run <code>npm install</code> from the root after changing those manifests, then <code>npm run build</code> to create the packages' <code>dist/</code> JavaScript and type declarations. Standard package imports use those build outputs; the <code>@toip-tools/source</code> export condition selects TypeScript source for development.</p>
          <p>The standalone site examples instead resolve package names through <a href="${gh("site/tsconfig.json")}"><code>site/tsconfig.json</code></a>. Its <code>paths</code> map public imports to local source; pass that configuration to <code>tsx</code> as shown above. Subpath imports, such as <code>@toip-tools/mesh-transport/sim</code>, have explicit mappings. These paths describe this checkout and are not registry installation instructions.</p>
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
