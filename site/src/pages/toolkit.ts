import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_DIR, SITE_DIR, gh, u } from "../../build/config";
import { code } from "../../build/highlight";
import { html, md, raw, type Raw } from "../../build/html";
import { readSdkModules, sdkEntryPoints, type ApiModule } from "../../build/sdk-api";
import { exampleSource, splitLeadComment } from "../../build/source";
import { libraries, type Library } from "../data/libraries";
import { sdkGuides } from "../data/sdk-guides";
import { docsNav } from "../docs-nav";
import type { Page } from "../layout";
import { pageHead } from "../parts";
import { apiModulePath, apiSymbolPath, findApi, moduleIndex, symbolPage } from "../sdk-reference";
import { toolkitShowcase } from "../toolkit-showcase";

function apiLinks(moduleList: ApiModule[], library: string, names: string[]): Raw {
  return html`<div class="sdk-related">${names.map(name => {
    const ref = findApi(moduleList, library, name);
    if (!ref) throw new Error(`Usage guide names an unknown public API: ${library}/${name}`);
    return html`<a href="${u(apiSymbolPath(ref.module, ref.symbol))}"><code>${name}</code></a>`;
  })}</div>`;
}

function libraryPage(library: Library, all: ApiModule[]): Page {
  const modules = all.filter(m => m.library === library.slug);
  const main = modules.find(m => m.subpath === ".")!;
  const guide = sdkGuides[library.slug];
  if (!guide) throw new Error(`Missing SDK usage guide for ${library.slug}`);
  const path = `/toolkit/${library.slug}/`;
  const pkg = JSON.parse(readFileSync(join(REPO_DIR, library.dir, "package.json"), "utf8")) as { version: string; exports: Record<string, unknown> };
  const assets = Object.entries(pkg.exports).flatMap(([subpath, file]) => typeof file === "string" && /\.wasm$/.test(file) ? [[subpath, file] as const] : []);
  const example = library.snippet ? splitLeadComment(exampleSource(`examples/snippets/${library.snippet.file}`)) : undefined;
  const output = library.snippet?.runs && existsSync(join(SITE_DIR, `examples/snippets/output/${library.slug}.txt`)) ? exampleSource(`examples/snippets/output/${library.slug}.txt`) : undefined;
  const body = html`<div class="wrap docs">${docsNav(path, [
    { label: "Setup", href: "#setup" }, { label: "Usage", href: "#usage" }, { label: "Example", href: "#example" },
    { label: "Lifecycle", href: "#lifecycle" }, { label: "Error handling", href: "#errors" }, { label: "API reference", href: "#api" },
  ])}<div class="docs__content">
    <div class="doc-breadcrumbs"><a href="${u("/docs/")}">Documentation</a><span>/</span><a href="${u("/toolkit/")}">SDK reference</a></div>
    <div class="page-head"><p class="eyebrow">SDK library · ${main.runtime}</p><h1 class="mono">${library.slug}</h1><div class="prose">${md(guide.intro)}</div></div>
    <div class="sdk-source"><code>${library.name}</code><span>v${pkg.version}</span><a href="${gh(main.file)}">Source</a></div>

    <section class="prose" aria-labelledby="setup"><h2 id="setup">Setup</h2>
      <p>Install the package from npm. It needs Node 22.13 or later, or a bundler for browser entry points.</p>
      ${code(`npm install ${library.name}`, "bash", { caption: "Install" })}
      <p><strong>Runtime:</strong> ${library.runsIn}</p>
    </section>
    ${code(`import { ${library.api[0].names.filter(name => main.symbols.some(s => s.name === name)).slice(0, 3).map(name => {
      const symbol = main.symbols.find(s => s.name === name)!;
      return ["interface", "type"].includes(symbol.kind) ? `type ${name}` : name;
    }).join(", ")} } from "${library.name}";`, "ts", { caption: "Import" })}

    <section aria-labelledby="usage"><h2 id="usage">Usage</h2>
      ${guide.tasks.map(task => html`<section class="sdk-task"><h3>${task.title}</h3><div class="prose">${md(task.body)}</div>${apiLinks(all, library.slug, task.symbols)}</section>`)}
    </section>

    <section aria-labelledby="example"><h2 id="example">Example</h2>
      ${example && library.snippet ? html`<div class="prose"><p>${example.lead}</p>${library.snippet.note ? html`<p class="small quiet">${library.snippet.note}</p>` : ""}</div>
      ${code(example.code, "ts", { caption: `site/examples/snippets/${library.snippet.file}` })}
      ${library.snippet.runs ? code(`npx tsx --tsconfig site/tsconfig.json site/examples/snippets/${library.snippet.file}`, "bash", { caption: "Run from the repository root" }) : ""}
      ${output ? code(output, "console", { caption: "Recorded output" }) : ""}` : html`<p class="prose">See the source and API reference for examples.</p>`}
    </section>

    <section class="prose" aria-labelledby="lifecycle"><h2 id="lifecycle">Lifecycle and persistence</h2><ul>${guide.lifecycle.map(item => html`<li>${md(item)}</li>`)}</ul></section>
    <section aria-labelledby="errors"><h2 id="errors">Error handling</h2>
      <div class="sdk-errors">${guide.errors.map(error => html`<article><h3><code>${error.name}</code></h3><div class="prose">${md(error.behavior)}${md(error.handling)}</div></article>`)}</div>
      ${library.notFor?.length ? html`<div class="sdk-note"><h3>Limitations</h3><ul>${library.notFor.map(item => html`<li>${md(item)}</li>`)}</ul></div>` : ""}
    </section>

    <section aria-labelledby="api"><h2 id="api">API reference</h2>
      <p class="prose">Choose an entry point for the complete export list. Each export has a reference page with its signature, parameter types, return type, fields, and public methods where applicable.</p>
      <ul class="sdk-modules">${modules.map(module => html`<li><a href="${u(apiModulePath(module))}"><code>${module.name}</code><span aria-hidden="true">↗</span></a><p>${module.runtime} · ${module.symbols.length} exports</p></li>`)}</ul>
      ${assets.length ? html`<h3>Bundled assets</h3><ul>${assets.map(([subpath, file]) => html`<li><code>${library.name}${subpath.slice(1)}</code> — <a href="${gh(join(library.dir, file))}">source asset</a></li>`)}</ul>` : ""}
    </section>
  </div></div>`;
  return { path, title: `${library.slug} SDK`, description: `${library.name}: setup, usage, examples, lifecycle, errors, and complete public API reference.`, section: "toolkit", body };
}

function indexPage(modules: ApiModule[]): Page {
  const catalog = modules.flatMap(module => module.symbols.map(symbol => ({
    name: symbol.name, module: module.name, kind: symbol.kind, href: u(apiSymbolPath(module, symbol)),
    summary: symbol.description.split(/\n|(?<=\.)\s/)[0], keywords: [...symbol.members, ...symbol.returnedMembers].map(m => m.name).join(" "),
  })));
  return {
    path: "/toolkit/", title: "SDK reference", description: "Setup, usage guides, runnable examples, and searchable API reference for the toip.tools TypeScript SDK.", section: "toolkit",
    body: html`<div class="wrap docs">${docsNav("/toolkit/")}<div class="docs__content">
      ${pageHead("SDK reference", "Usage guides and API documentation for every public package entry point.")}
      <p class="prose">New to the SDK? Follow <a href="${u("/docs/#setup")}">Setup</a> and the <a href="${u("/quickstart/")}">Quickstart</a>. This reference covers ${modules.length} modules and ${catalog.length} exports from the current source.</p>
      <div class="sdk-search" role="search" aria-label="API reference">
        <label for="api-search">Find an export</label>
        <input type="search" id="api-search" placeholder="Search classes, functions, types, or methods" aria-describedby="api-search-help" aria-controls="api-results" autocomplete="off">
        <p id="api-search-help" class="small quiet">Try <code>Endpoint</code>, <code>VaultConfig</code>, or <code>mesh SimMedium</code>.</p>
        <p id="api-search-status" class="small quiet" role="status"></p>
        <ul id="api-results" class="sdk-search__results" hidden></ul>
      </div>
      <script type="application/json" id="sdk-search-data">${raw(JSON.stringify(catalog).replaceAll("<", "\\u003c"))}</script>
      <div id="use" class="sdk-note"><p>Every library is on npm as <code>@toip-tools/&lt;name&gt;</code>, for example <code>npm install @toip-tools/trust-core</code>. To change the libraries themselves, <a href="${u("/docs/#workspace")}">work from the source</a>.</p></div>
      ${toolkitShowcase()}
    </div></div>`,
  };
}

export function toolkitPages(): Page[] {
  const modules = readSdkModules(sdkEntryPoints());
  return [indexPage(modules), ...libraries.map(library => libraryPage(library, modules)),
    ...modules.flatMap(module => [moduleIndex(module, modules), ...module.symbols.map(symbol => symbolPage(module, symbol, modules))])];
}
