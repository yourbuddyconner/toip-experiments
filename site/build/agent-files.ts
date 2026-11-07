// The files search engines and AI agents read: llms.txt and llms-full.txt (https://llmstxt.org), JSON
// indexes under /api/, sitemap.xml, robots.txt, an Atom feed of releases, and /.well-known/security.txt.
// Everything comes from the same data and rendered pages as the HTML.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OUT_DIR, REPO, REPO_DIR, SITE_NAME, SPEC_ORIGIN, abs, gh, ghTree } from "./config";
import type { Release } from "./changelogs";
import { esc } from "./html";
import type { ApiModule } from "./sdk-api";
import { SITE_DESCRIPTION, npmUrl } from "./seo";
import type { Spec } from "./specs";
import { guides } from "../src/data/guides";
import { libraries } from "../src/data/libraries";
import { projects } from "../src/data/projects";
import type { Page } from "../src/layout";
import { AGENT_FILES } from "../src/pages/agents";
import { FEED_PATH, releaseId } from "../src/pages/releases";
import { apiModulePath, apiSymbolPath } from "../src/sdk-reference";

export interface BuiltPage {
  page: Page;
  markdown?: string;
  markdownPath?: string;
  lastmod?: string;
}

const write = (rel: string, body: string) => {
  const file = join(OUT_DIR, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
};

const mdUrl = (path: string) => abs(`${path}index.md`);
const stripMd = (s: string) => s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[`*]/g, "").replace(/\s+/g, " ").trim();
const pkgOf = (dir: string) => JSON.parse(readFileSync(join(REPO_DIR, dir, "package.json"), "utf8")) as {
  name: string; version: string; description: string; license: string; keywords?: string[]; author?: string; dependencies?: Record<string, string>;
};

const SUMMARY =
  "toip.tools documents @toip-tools, TypeScript libraries on npm for building Trust over IP applications: Ed25519 did:key identities, signed and end-to-end encrypted messages over the Trust Spanning Protocol (TSP), Trust Tasks, W3C VC-shaped credentials with status lists, delegation mandates for AI agents, KERI key event logs, COSE signing, zero-knowledge group membership, and Trust Tasks over LoRa radio. It is an independent project, unaffiliated with the Trust over IP Foundation.";

function facts(version: string): string {
  return [
    `- Install from npm: \`npm install @toip-tools/trust-core\`; every other library builds on it. All packages are at version ${version}, ES modules with TypeScript declarations.`,
    "- Needs Node 22.13 or later. Browser entry points work through a bundler; the relay is Node only.",
    "- Identities are Ed25519 `did:key` (and `did:keri` in eventlog). There is no resolver for other DID methods.",
    "- TSP is used in Direct mode only, through the OpenVTC library `@openvtc/vti-tsp-js`.",
    `- Every page has a Markdown version: add \`index.md\` to its URL. All of the docs in one file: ${abs(AGENT_FILES.llmsFull)}`,
    `- Source: ${REPO}`,
  ].join("\n");
}

/** /llms.txt: an H1, a blockquote summary, facts, and sections of links to Markdown pages. */
export function llmsTxt(byPath: Map<string, BuiltPage>, version: string): string {
  const link = (path: string, note: string, name?: string) => {
    const b = byPath.get(path);
    if (!b?.markdownPath) throw new Error(`llms.txt links ${path}, which has no Markdown twin`);
    return `- [${name ?? b.page.title}](${abs(b.markdownPath)}): ${note}`;
  };
  const sections: [string, string[]][] = [
    ["Docs", [
      link("/docs/", "install from npm, setup, and where to start"),
      link("/quickstart/", "two did:key identities, a signed and encrypted Trust Task, a relay, and a revocable credential, in four runnable steps"),
      link("/concepts/", "DIDs, verifiable credentials, TSP, Trust Tasks, governance, KERI and zero-knowledge membership, and which library implements each"),
      link("/faq/", "Trust over IP, TSP, install, Node version, browser support, DID methods, license, and the relationship to the ToIP Foundation"),
    ]],
    ["Guides", guides.map((g) => link(`/guides/${g.slug}/`, g.summary))],
    ["Libraries", libraries.map((l) => link(`/toolkit/${l.slug}/`, `${l.does} Setup, usage, lifecycle, errors and API.`, l.name))],
    ["Reference", [
      link("/toolkit/", "every library and a searchable index of every export", "SDK reference"),
      link("/spec/", "every Trust Task type defined in the code: purpose, sender, receiver and payload"),
      `- [libraries.json](${abs(AGENT_FILES.libraries)}): every package with version, install command, entry points and exports (kind, summary, reference URL), as JSON`,
      `- [specs.json](${abs(AGENT_FILES.specs)}): every Trust Task type with URI, purpose, from, to, kind, and payload and response types, as JSON`,
      `- [examples.json](${abs(AGENT_FILES.examples)}): every example project with status, libraries and run commands, as JSON`,
    ]],
    ["Examples", [link("/examples/", "complete applications: conditional payments, shared lists, whistleblowing, anonymous forums, AI agents, audit trails, signed media, LoRa")]],
    ["Optional", [
      `- [llms-full.txt](${abs(AGENT_FILES.llmsFull)}): all of the documentation above in one Markdown file`,
      link("/ecosystem/", "ToIP, First Person, OpenVTC, the P2P Trust Stack, KERI and DIF, and how this toolkit relates to them"),
      link("/releases/", "every published version, from the changelogs"),
      `- [Releases feed](${abs(FEED_PATH)}): Atom`,
      link("/get-involved/", "how to contribute"),
    ]],
  ];
  return `# ${SITE_NAME}\n\n> ${SUMMARY}\n\n${facts(version)}\n\n${sections.map(([h, items]) => `## ${h}\n\n${items.join("\n")}`).join("\n\n")}\n`;
}

/** The pages llms-full.txt holds, in reading order. */
export function fullPaths(all: BuiltPage[]): string[] {
  const pick = (test: (b: BuiltPage) => boolean) => all.filter(test).map((b) => b.page.path);
  const isModuleIndex = (b: BuiltPage, slug: string) => b.page.path.startsWith(`/toolkit/${slug}/api/`) && b.page.title.endsWith(" API");
  return [
    "/docs/", "/quickstart/", "/concepts/", "/faq/", "/guides/",
    ...guides.map((g) => `/guides/${g.slug}/`),
    "/toolkit/",
    ...libraries.flatMap((l) => [`/toolkit/${l.slug}/`, ...pick((b) => isModuleIndex(b, l.slug))]),
    "/spec/",
    ...pick((b) => b.page.path.startsWith("/spec/") && b.page.path !== "/spec/"),
    "/examples/", "/ecosystem/", "/api/",
  ];
}

export function llmsFullTxt(byPath: Map<string, BuiltPage>, order: string[], version: string): string {
  const parts = order.map((path) => {
    const b = byPath.get(path);
    if (!b?.markdown) throw new Error(`llms-full.txt wants ${path}, which has no Markdown`);
    return `<page url="${abs(path)}">\n\n${b.markdown.trim()}\n\n</page>`;
  });
  return `# ${SITE_NAME}: the complete documentation\n\n> ${SUMMARY}\n\n${facts(version)}\n\nThis file is generated from the site's pages at build time. Each page below is wrapped in a <page> element naming its URL.\n\n${parts.join("\n\n")}\n`;
}

export function librariesJson(modules: ApiModule[]): unknown {
  return {
    site: abs("/"),
    description: "Every @toip-tools package, its entry points and its public exports, generated from the source.",
    libraries: libraries.map((l) => {
      const pkg = pkgOf(l.dir);
      const deps = Object.keys(pkg.dependencies ?? {}).filter((d) => d.startsWith("@toip-tools/"));
      return {
        name: l.name,
        slug: l.slug,
        version: pkg.version,
        description: l.does,
        install: `npm install ${l.name}`,
        runtime: stripMd(l.runsIn),
        license: pkg.license,
        keywords: pkg.keywords ?? [],
        dependsOn: deps,
        docs: abs(`/toolkit/${l.slug}/`),
        markdown: mdUrl(`/toolkit/${l.slug}/`),
        npm: npmUrl(l.name),
        source: ghTree(l.dir),
        guides: guides.filter((g) => g.libraries.includes(l.slug)).map((g) => ({ title: g.title, url: abs(`/guides/${g.slug}/`) })),
        usedBy: l.usedBy.map((p) => ({ project: p, url: abs(`/examples/#${p}`) })),
        entryPoints: modules.filter((m) => m.library === l.slug).map((m) => ({
          import: m.name,
          subpath: m.subpath,
          runtime: m.runtime,
          reference: abs(apiModulePath(m)),
          exports: m.symbols.map((s) => ({
            name: s.name,
            kind: s.kind,
            summary: s.description.split(/\n|(?<=\.)\s/)[0] || undefined,
            reference: abs(apiSymbolPath(m, s)),
            source: `${gh(s.source.file)}#L${s.source.line}`,
            ...(s.deprecated !== undefined ? { deprecated: true } : {}),
          })),
        })),
      };
    }),
  };
}

export function specsJson(specs: Spec[]): unknown {
  return {
    site: abs("/"),
    description: "Every Trust Task type defined in the toip.tools packages and projects, generated from the code.",
    namespace: `${SPEC_ORIGIN}/spec/`,
    envelope: "Every Trust Task is a JSON document with id, type (the URI below), issuer, recipient, issuedAt, payload and a Data Integrity proof (eddsa-jcs-2022), sent in a TSP Direct message. A response's type is the request's URI with #response appended.",
    specs: specs.map((s) => ({
      name: s.name,
      uri: `${SPEC_ORIGIN}/spec/${s.name}/0.1`,
      family: s.family,
      purpose: s.note?.purpose ?? s.doc ?? null,
      from: s.note?.from ?? null,
      to: s.note?.to ?? null,
      kind: s.note?.kind ?? null,
      ...(s.note?.kind === "request/response" ? { responseUri: `${SPEC_ORIGIN}/spec/${s.name}/0.1#response` } : {}),
      payload: s.payload?.text ?? null,
      response: s.response?.text ?? null,
      reference: abs(`/spec/${s.name}/0.1/`),
      markdown: mdUrl(`/spec/${s.name}/0.1/`),
      definedIn: `${gh(s.file)}#L${s.line}`,
      ...(s.note ? { design: gh(s.note.design, s.designAnchor) } : {}),
    })),
  };
}

export function examplesJson(): unknown {
  return {
    site: abs("/"),
    description: "The example applications in the toip-tools repository, with honest status and the commands that run them.",
    setup: ["git clone https://github.com/yourbuddyconner/toip-tools.git", "cd toip-tools", "npm install"],
    projects: projects.map((p) => ({
      slug: p.slug,
      name: p.name,
      status: p.status,
      summary: p.pitch,
      demonstrates: p.demonstrates,
      libraries: p.libraries.map((l) => libraries.find((x) => x.slug === l)?.name ?? l),
      run: (p.run ?? []).map((r) => ({ description: r.what, command: r.cmd })),
      page: abs(`/examples/#${p.slug}`),
      readme: gh(`projects/${p.slug}/README.md`),
      design: gh(`projects/${p.slug}/docs/design.md`),
      source: ghTree(`projects/${p.slug}`),
      ...(p.specs ? { trustTasks: abs(`/spec/#${p.specs}`) } : {}),
    })),
  };
}

export function sitemapXml(all: BuiltPage[]): string {
  const urls = all
    .filter((b) => b.page.path !== "/404.html")
    .map((b) => `  <url><loc>${esc(abs(b.page.path))}</loc>${b.lastmod ? `<lastmod>${b.lastmod}</lastmod>` : ""}</url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

/** Crawlers that identify AI training or answer engines, welcomed by name so a blanket rule elsewhere can't shut them out. */
export const AI_CRAWLERS = [
  "GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot", "Claude-User", "anthropic-ai", "PerplexityBot", "Perplexity-User",
  "Google-Extended", "Applebot-Extended", "CCBot", "Meta-ExternalAgent", "Amazonbot", "DuckAssistBot", "cohere-ai", "MistralAI-User", "Bytespider",
];

export function robotsTxt(): string {
  return [
    "# toip.tools welcomes search engines and AI crawlers. Everything here is public documentation.",
    `# For language models: ${abs(AGENT_FILES.llms)} (index) and ${abs(AGENT_FILES.llmsFull)} (everything).`,
    "",
    "User-agent: *",
    "Allow: /",
    "",
    ...AI_CRAWLERS.map((a) => `User-agent: ${a}`),
    "Allow: /",
    "",
    `Sitemap: ${abs(AGENT_FILES.sitemap)}`,
    "",
  ].join("\n");
}

export function atomFeed(releases: Release[], renderMd: (s: string) => string): string {
  const updated = releases.find((r) => r.date)?.date ?? "2026-11-07T00:00:00Z";
  const entries = releases.map((r) => {
    const url = `${abs("/releases/")}#${releaseId(r)}`;
    return `  <entry>
    <id>${esc(url)}</id>
    <title>${esc(`${r.name} ${r.version}`)}</title>
    <link rel="alternate" type="text/html" href="${esc(url)}"/>
    <link rel="related" href="${esc(npmUrl(r.name, r.version))}"/>
    <updated>${r.date ?? updated}</updated>
    <content type="html">${esc(renderMd(r.notes))}</content>
  </entry>`;
  });
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${esc(abs(FEED_PATH))}</id>
  <title>toip.tools releases</title>
  <subtitle>New versions of the @toip-tools TypeScript libraries.</subtitle>
  <link rel="self" type="application/atom+xml" href="${esc(abs(FEED_PATH))}"/>
  <link rel="alternate" type="text/html" href="${esc(abs("/releases/"))}"/>
  <author><name>toip.tools</name><uri>${esc(REPO)}</uri></author>
  <updated>${updated}</updated>
${entries.join("\n")}
</feed>
`;
}

/** RFC 9116. Expires a little under a year after the build; every deploy renews it. */
export function securityTxt(now = new Date()): string {
  const expires = new Date(now.getTime() + 360 * 86_400_000);
  expires.setUTCHours(0, 0, 0, 0);
  return [
    `Contact: ${REPO}/security`,
    `Contact: ${REPO}/issues`,
    `Expires: ${expires.toISOString()}`,
    "Preferred-Languages: en",
    `Canonical: ${abs("/.well-known/security.txt")}`,
    "",
  ].join("\n");
}

export function writeAgentFiles(o: { all: BuiltPage[]; modules: ApiModule[]; specs: Spec[]; releases: Release[]; renderMd: (s: string) => string }): Record<string, number> {
  const byPath = new Map(o.all.map((b) => [b.page.path, b]));
  const version = pkgOf("packages/trust-core").version;
  const files: Record<string, string> = {
    [AGENT_FILES.llms]: llmsTxt(byPath, version),
    [AGENT_FILES.llmsFull]: llmsFullTxt(byPath, fullPaths(o.all), version),
    [AGENT_FILES.libraries]: `${JSON.stringify(librariesJson(o.modules), null, 2)}\n`,
    [AGENT_FILES.specs]: `${JSON.stringify(specsJson(o.specs), null, 2)}\n`,
    [AGENT_FILES.examples]: `${JSON.stringify(examplesJson(), null, 2)}\n`,
    [AGENT_FILES.sitemap]: sitemapXml(o.all),
    [AGENT_FILES.robots]: robotsTxt(),
    [AGENT_FILES.feed]: atomFeed(o.releases, o.renderMd),
    "/.well-known/security.txt": securityTxt(),
  };
  const sizes: Record<string, number> = {};
  for (const [path, body] of Object.entries(files)) {
    write(path.slice(1), body);
    sizes[path] = Buffer.byteLength(body);
  }
  return sizes;
}
