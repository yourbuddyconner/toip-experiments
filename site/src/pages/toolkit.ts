import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, REPO_DIR, SITE_DIR, abs, gh, ghTree, u } from "../../build/config";
import { npmUrl } from "../../build/seo";
import { guides } from "../data/guides";
import { projects } from "../data/projects";
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

/** Each library's <title>: what someone would search for, then the package name. */
const SEO_TITLES: Record<string, string> = {
  "trust-core": "did:key identities, verifiable credentials and TSP messaging in TypeScript · @toip-tools/trust-core",
  relay: "TSP relay: a WebSocket mailbox for encrypted messages in Node · @toip-tools/relay",
  cose: "COSE_Sign1 and deterministic CBOR in TypeScript, with passkey signing · @toip-tools/cose",
  "web-vault": "Passkey-sealed keys and data in the browser (WebAuthn PRF) · @toip-tools/web-vault",
  mandates: "Delegation mandates for AI agents: limits, approvals, revocation · @toip-tools/mandates",
  "anon-membership": "Zero-knowledge group membership proofs in TypeScript (Noir) · @toip-tools/anon-membership",
  eventlog: "KERI key event logs and tamper-evident audit trails in TypeScript · @toip-tools/eventlog",
  "mesh-transport": "TSP and Trust Tasks over LoRa radio, offline · @toip-tools/mesh-transport",
};

type Pkg = { version: string; license: string; author?: string; keywords?: string[]; exports: Record<string, unknown>; dependencies?: Record<string, string> };
const pkgOf = (library: Library) => JSON.parse(readFileSync(join(REPO_DIR, library.dir, "package.json"), "utf8")) as Pkg;
const toipDeps = (library: Library) => Object.keys(pkgOf(library).dependencies ?? {}).filter(d => d.startsWith("@toip-tools/"));

/** Guides that use it, libraries it builds on and that build on it, and the example apps that use it. */
function connections(library: Library): Raw {
  const used = guides.filter(g => g.libraries.includes(library.slug));
  const builtOn = libraries.filter(l => toipDeps(library).includes(l.name));
  const builtBy = libraries.filter(l => toipDeps(l).includes(library.name));
  const apps = projects.filter(p => library.usedBy.includes(p.slug));
  const item = (l: Library) => html`<li><a href="${u(`/toolkit/${l.slug}/`)}"><code>${l.name}</code></a>: ${l.does}</li>`;
  return html`<section aria-labelledby="related" class="guide-related"><h2 id="related">Related</h2>
    ${used.length ? html`<h3>Guides</h3><ul class="prose">${used.map(g => html`<li><a href="${u(`/guides/${g.slug}/`)}">${g.title}</a></li>`)}</ul>` : ""}
    ${builtOn.length ? html`<h3>Built on</h3><ul class="prose">${builtOn.map(item)}</ul>` : ""}
    ${builtBy.length ? html`<h3>Libraries that build on it</h3><ul class="prose">${builtBy.map(item)}</ul>` : ""}
    ${apps.length ? html`<h3>Used by these examples</h3><ul class="prose">${apps.map(p => html`<li><a href="${u(`/examples/#${p.slug}`)}">${p.name}</a>: ${p.pitch.split(/(?<=\.) /)[0]}</li>`)}</ul>` : ""}
    <h3>Concepts</h3><p class="prose"><a href="${u("/concepts/")}">Concepts</a> explains the protocols behind ${library.slug}; the <a href="${u("/faq/")}">FAQ</a> covers install, runtimes and support.</p>
  </section>`;
}

function libraryPage(library: Library, all: ApiModule[]): Page {
  const modules = all.filter(m => m.library === library.slug);
  const main = modules.find(m => m.subpath === ".")!;
  const guide = sdkGuides[library.slug];
  if (!guide) throw new Error(`Missing SDK usage guide for ${library.slug}`);
  const path = `/toolkit/${library.slug}/`;
  const pkg = pkgOf(library);
  const assets = Object.entries(pkg.exports).flatMap(([subpath, file]) => typeof file === "string" && /\.wasm$/.test(file) ? [[subpath, file] as const] : []);
  const example = library.snippet ? splitLeadComment(exampleSource(`examples/snippets/${library.snippet.file}`)) : undefined;
  const output = library.snippet?.runs && existsSync(join(SITE_DIR, `examples/snippets/output/${library.slug}.txt`)) ? exampleSource(`examples/snippets/output/${library.slug}.txt`) : undefined;
  const body = html`<div class="wrap docs">${docsNav(path, [
    { label: "Setup", href: "#setup" }, { label: "Usage", href: "#usage" }, { label: "Example", href: "#example" },
    { label: "Lifecycle", href: "#lifecycle" }, { label: "Error handling", href: "#errors" }, { label: "API reference", href: "#api" },
  ])}<div class="docs__content">
    <div class="doc-breadcrumbs" data-md-skip><a href="${u("/docs/")}">Documentation</a><span>/</span><a href="${u("/toolkit/")}">SDK reference</a></div>
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
    ${connections(library)}
  </div></div>`;
  const runtimes = [...new Set(modules.map(m => m.runtime))];
  return {
    path, title: `${library.slug} SDK`, seoTitle: SEO_TITLES[library.slug] ?? `${library.name}: TypeScript library · toip.tools`,
    description: `${library.does} Install with npm install ${library.name}; setup, usage, errors and API reference.`,
    section: "toolkit", kind: "article", eyebrow: "SDK library", monoTitle: true, ogFooter: `npm install ${library.name}`, tools: true,
    ogTitle: library.name, ogText: library.does,
    sources: [`${library.dir}/src`, `${library.dir}/package.json`, `${library.dir}/README.md`, "site/src/data/sdk-guides.ts", "site/src/data/libraries.ts", ...(library.snippet ? [`site/examples/snippets/${library.snippet.file}`] : [])],
    schema: [{
      "@type": "SoftwareSourceCode",
      "@id": `${abs(path)}#code`,
      name: library.name,
      description: library.does,
      url: abs(path),
      codeRepository: REPO,
      ...(pkg.license ? { license: `https://spdx.org/licenses/${pkg.license}.html` } : {}),
      programmingLanguage: { "@type": "ComputerLanguage", name: "TypeScript" },
      runtimePlatform: runtimes.join(", "),
      version: pkg.version,
      ...(pkg.keywords?.length ? { keywords: pkg.keywords.join(", ") } : {}),
      ...(pkg.author ? { author: { "@type": "Person", name: pkg.author } } : {}),
      isAccessibleForFree: true,
      sameAs: [npmUrl(library.name), ghTree(library.dir)],
      targetProduct: {
        "@type": "SoftwareApplication",
        name: library.name,
        softwareVersion: pkg.version,
        applicationCategory: "DeveloperApplication",
        operatingSystem: runtimes.some(r => /browser/i.test(r)) ? "Node.js 22.13+, web browsers" : "Node.js 22.13+",
        downloadUrl: npmUrl(library.name),
        installUrl: npmUrl(library.name),
        isAccessibleForFree: true,
      },
    }],
    body,
  };
}

function indexPage(modules: ApiModule[]): Page {
  const catalog = modules.flatMap(module => module.symbols.map(symbol => ({
    name: symbol.name, module: module.name, kind: symbol.kind, href: u(apiSymbolPath(module, symbol)),
    summary: symbol.description.split(/\n|(?<=\.)\s/)[0], keywords: [...symbol.members, ...symbol.returnedMembers].map(m => m.name).join(" "),
  })));
  return {
    path: "/toolkit/", title: "SDK reference", seoTitle: "@toip-tools TypeScript SDK reference: every library and export · toip.tools",
    description: "Usage guides, runnable examples and a searchable API reference for every @toip-tools library: trust-core, relay, cose, mandates, eventlog and more.",
    section: "toolkit", kind: "collection", eyebrow: "SDK reference", ogFooter: "npm install @toip-tools/trust-core", tools: true,
    sources: ["packages", "site/src/data/libraries.ts", "site/src/toolkit-showcase.ts"],
    body: html`<div class="wrap docs">${docsNav("/toolkit/")}<div class="docs__content">
      ${pageHead("SDK reference", "Usage guides and API documentation for every public package entry point.")}
      <p class="prose">New to the SDK? Follow <a href="${u("/docs/#setup")}">Setup</a> and the <a href="${u("/quickstart/")}">Quickstart</a>. This reference covers ${modules.length} modules and ${catalog.length} exports from the current source.</p>
      <form class="sdk-search" role="search" aria-label="API reference" action="${u("/toolkit/")}" method="get" data-md-skip>
        <label for="api-search">Find an export</label>
        <input type="search" id="api-search" name="q" placeholder="Search classes, functions, types, or methods" aria-describedby="api-search-help" aria-controls="api-results" autocomplete="off">
        <p id="api-search-help" class="small quiet">Try <code>Endpoint</code>, <code>VaultConfig</code>, or <code>mesh SimMedium</code>.</p>
        <p id="api-search-status" class="small quiet" role="status"></p>
        <ul id="api-results" class="sdk-search__results" hidden></ul>
      </form>
      <script type="application/json" id="sdk-search-data">${raw(JSON.stringify(catalog).replaceAll("<", "\\u003c"))}</script>
      <div id="use" class="sdk-note"><p>Every library is on npm as <code>@toip-tools/&lt;name&gt;</code>, for example <code>npm install @toip-tools/trust-core</code>. To change the libraries themselves, <a href="${u("/docs/#workspace")}">work from the source</a>.</p></div>
      ${toolkitShowcase()}
    </div></div>`,
  };
}

export function readModules(): ApiModule[] {
  return readSdkModules(sdkEntryPoints());
}

export function toolkitPages(modules: ApiModule[]): Page[] {
  return [indexPage(modules), ...libraries.map(library => libraryPage(library, modules)),
    ...modules.flatMap(module => [moduleIndex(module, modules), ...module.symbols.map(symbol => symbolPage(module, symbol, modules))])];
}
