import { existsSync } from "node:fs";
import { join } from "node:path";
import { SITE_DIR, abs, gh, u } from "../../build/config";
import { code } from "../../build/highlight";
import { html, md, mdi, type Raw } from "../../build/html";
import type { ApiModule } from "../../build/sdk-api";
import { exampleSource } from "../../build/source";
import { guideBySlug, guides, type Guide } from "../data/guides";
import { libBySlug } from "../data/libraries";
import { docsNav } from "../docs-nav";
import type { Page } from "../layout";
import { pageHead } from "../parts";
import { apiSymbolPath, findApi } from "../sdk-reference";

const CONCEPT_TITLES: Record<string, string> = {
  dids: "Decentralized identifiers",
  credentials: "Verifiable credentials and status lists",
  tsp: "The Trust Spanning Protocol",
  "trust-tasks": "Trust Tasks",
  governance: "Trust registries and governance",
  keri: "KERI key event logs and witnesses",
  zk: "Selective disclosure and zero-knowledge membership",
};

/** Site-absolute links in the guides' Markdown ("/guides/…") get the base path. */
const based = (s: string) => s.replace(/\]\(\//g, `](${u("/")}`);

/** Markdown whose fenced code blocks become the site's highlighted code panels. */
function prose(src: string): Raw {
  const parts: Raw[] = [];
  let last = 0;
  for (const m of src.matchAll(/^```(\w+)\n([\s\S]*?)^```$/gm)) {
    parts.push(html`<div class="prose">${md(based(src.slice(last, m.index)))}</div>`);
    parts.push(code(m[2], m[1] === "bash" ? "bash" : "ts", { caption: m[1] === "bash" ? "Terminal" : undefined }));
    last = m.index + m[0].length;
  }
  parts.push(html`<div class="prose">${md(based(src.slice(last)))}</div>`);
  return html`${parts}`;
}

export const guideFile = (slug: string) => `examples/guides/${slug}.ts`;

function apiChips(g: Guide, modules: ApiModule[]): Raw {
  return html`${g.apis.map((group) => html`<div class="sdk-related" aria-label="${libBySlug(group.library).name} exports">${group.names.map((name) => {
    const ref = findApi(modules, group.library, name);
    if (!ref) throw new Error(`Guide ${g.slug} names an unknown export: ${group.library}/${name}`);
    return html`<a href="${u(apiSymbolPath(ref.module, ref.symbol))}"><code>${name}</code></a>`;
  })}</div>`)}`;
}

function guidePage(g: Guide, modules: ApiModule[]): Page {
  const path = `/guides/${g.slug}/`;
  const file = guideFile(g.slug);
  const outFile = `examples/guides/output/${g.slug}.txt`;
  const output = existsSync(join(SITE_DIR, outFile)) ? exampleSource(outFile) : undefined;
  const install = `npm install ${[...g.packages, "tsx"].join(" ")}`;
  const libs = g.libraries.map(libBySlug);
  const body = html`<div class="wrap docs">
  ${docsNav(path, [
    { label: "Before you start", href: "#before" },
    { label: "The code", href: "#code" },
    { label: "How it works", href: "#how" },
    { label: "Limits", href: "#notes" },
    { label: "Related", href: "#related" },
  ])}
  <div class="docs__content">
    <div class="doc-breadcrumbs" data-md-skip><a href="${u("/docs/")}">Documentation</a><span>/</span><a href="${u("/guides/")}">Guides</a></div>
    <div class="page-head guide-head">
      <p class="eyebrow">Guide · ${libs.map((l, i) => html`${i ? ", " : ""}<code>${l.name}</code>`)}</p>
      <h1>${g.title}</h1>
      <p class="lede">${g.summary}</p>
    </div>
    ${prose(g.intro)}

    <section class="prose" aria-labelledby="before">
      <h2 id="before">Before you start</h2>
      <p>You need Node 22.13 or later. In a new folder, install the package${g.packages.length > 1 ? "s" : ""} and <code>tsx</code>, a TypeScript runner:</p>
      ${code(`mkdir ${g.slug} && cd ${g.slug}\nnpm init -y && npm pkg set type=module\n${install}`, "bash", { caption: "Terminal" })}
    </section>

    <section aria-labelledby="code">
      <h2 id="code">The code</h2>
      <p class="prose">Save this as <code>${g.slug}.ts</code>. It is the complete program; the site's checks run it on every build.</p>
      ${code(exampleSource(file), "ts", { caption: `${g.slug}.ts` })}
      <p class="prose">Run it:</p>
      ${code(`npx tsx ${g.slug}.ts`, "bash", { caption: "Terminal" })}
      ${output ? code(output, "console", { caption: "Recorded output" }) : ""}
      <p class="small quiet">Keys are random, so identifiers and sizes differ on each run. From a clone of the repository, run <code>npx tsx --tsconfig site/tsconfig.json site/${file}</code>, or read it in <a href="${gh(`site/${file}`)}"><code>site/${file}</code></a>.</p>
    </section>

    <section class="prose" aria-labelledby="how">
      <h2 id="how">How it works</h2>
      <ul>${g.how.map((h) => html`<li>${mdi(based(h))}</li>`)}</ul>
    </section>

    <section class="prose" aria-labelledby="notes">
      <h2 id="notes">Limits and production notes</h2>
      <ul>${g.notes.map((n) => html`<li>${mdi(based(n))}</li>`)}</ul>
    </section>

    <section aria-labelledby="related" class="guide-related">
      <h2 id="related">Related</h2>
      <h3>API used</h3>
      ${apiChips(g, modules)}
      <h3>Libraries</h3>
      <ul class="prose">${libs.map((l) => html`<li><a href="${u(`/toolkit/${l.slug}/`)}"><code>${l.name}</code></a>: ${l.does}</li>`)}</ul>
      <h3>Concepts</h3>
      <ul class="prose">${g.concepts.map((c) => html`<li><a href="${u(`/concepts/#${c}`)}">${CONCEPT_TITLES[c] ?? c}</a></li>`)}</ul>
      <h3>More guides</h3>
      <ul class="prose">${g.related.map((r) => {
        const o = guideBySlug(r);
        return html`<li><a href="${u(`/guides/${o.slug}/`)}">${o.title}</a></li>`;
      })}</ul>
    </section>
  </div>
</div>`;
  return {
    path,
    title: g.title,
    seoTitle: g.seoTitle,
    description: g.description,
    section: "guides",
    kind: "article",
    eyebrow: "Guide",
    ogFooter: `npm install ${g.packages.join(" ")}`,
    tools: true,
    sources: [`site/${file}`, `site/${outFile}`, "site/src/data/guides.ts", ...g.libraries.map((l) => `${libBySlug(l).dir}/src`)],
    body,
  };
}

function indexPage(): Page {
  const body = html`<div class="wrap docs">
  ${docsNav("/guides/")}
  <div class="docs__content">
    ${pageHead("Guides", "Short how-tos, each answering one question with one complete program you can run.")}
    <div class="prose"><p>Every guide installs the published packages from npm and runs with Node 22.13 or later. The programs are checked on every build of this site, and the output shown is recorded from a real run. New to the libraries? Start with the <a href="${u("/quickstart/")}">Quickstart</a>.</p></div>
    <ul class="guide-list">${guides.map((g) => html`<li>
      <a href="${u(`/guides/${g.slug}/`)}"><h2>${g.title}</h2><p>${g.summary}</p><span class="guide-list__libs">${g.libraries.map((l) => libBySlug(l).name).join(" · ")}</span></a>
    </li>`)}</ul>
    <div class="prose"><p>Looking for a whole application? See the <a href="${u("/examples/")}">examples</a>. Looking up one function? Search the <a href="${u("/toolkit/")}">SDK reference</a>.</p></div>
  </div>
</div>`;
  return {
    path: "/guides/",
    title: "Guides",
    seoTitle: "Trust over IP how-to guides in TypeScript: DIDs, verifiable credentials, TSP, KERI · toip.tools",
    description: "Task-focused TypeScript how-tos: did:key signing, verifiable credentials and revocation, TSP encrypted messaging, relays, AI agent mandates, KERI logs, COSE, LoRa, ZK.",
    section: "guides",
    kind: "collection",
    eyebrow: "Guides",
    ogFooter: "npm install @toip-tools/trust-core",
    tools: true,
    sources: ["site/src/data/guides.ts", "site/examples/guides"],
    schema: [{
      "@type": "ItemList",
      itemListElement: guides.map((g, i) => ({ "@type": "ListItem", position: i + 1, name: g.title, url: abs(`/guides/${g.slug}/`) })),
    }],
    body,
  };
}

export function guidePages(modules: ApiModule[]): Page[] {
  return [indexPage(), ...guides.map((g) => guidePage(g, modules))];
}
