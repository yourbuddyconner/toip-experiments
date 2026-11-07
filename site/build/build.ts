// Builds the static site into dist/. Usage: npm run build (SITE_BASE=/ for the custom domain).
// Every page is written as HTML, as a Markdown twin (index.md), and as a social image (og.png); then the
// files agents and crawlers read: llms.txt, llms-full.txt, /api/*.json, the sitemap, robots.txt and the feed.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BASE, OUT_DIR, SITE_DIR, abs, u } from "./config";
import { writeAgentFiles, type BuiltPage } from "./agent-files";
import { loadReleases } from "./changelogs";
import { fingerprintSvg } from "./fingerprint";
import { lastModified } from "./git-dates";
import { sealSample } from "./hero";
import { md } from "./html";
import { htmlToMarkdown } from "./markdown";
import { renderOgImages, type OgJob } from "./og";
import { breadcrumbs, jsonLdFor } from "./seo";
import { loadSpecs, warnings } from "./specs";
import { layout, pageTitle, type Page } from "../src/layout";
import { agentsPage } from "../src/pages/agents";
import { conceptsPage } from "../src/pages/concepts";
import { docsPage } from "../src/pages/docs";
import { ecosystemPage } from "../src/pages/ecosystem";
import { examplesPage } from "../src/pages/examples";
import { faqPage } from "../src/pages/faq";
import { guidePages } from "../src/pages/guides";
import { homePage } from "../src/pages/home";
import { involvedPage } from "../src/pages/involved";
import { notFoundPage } from "../src/pages/notfound";
import { quickstartPage } from "../src/pages/quickstart";
import { FEED_PATH, releasesPage } from "../src/pages/releases";
import { specPages } from "../src/pages/spec";
import { readModules, toolkitPages } from "../src/pages/toolkit";

const t0 = Date.now();
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

// Static files.
cpSync(join(SITE_DIR, "public"), OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, ".nojekyll"), "");
const fontDir = join(SITE_DIR, "node_modules/@fontsource-variable/recursive/files");
mkdirSync(join(OUT_DIR, "fonts"), { recursive: true });
for (const sub of ["latin", "latin-ext"]) cpSync(join(fontDir, `recursive-${sub}-mono-normal.woff2`), join(OUT_DIR, "fonts", `recursive-${sub}-mono.woff2`));
cpSync(join(SITE_DIR, "node_modules/@fontsource-variable/recursive/LICENSE"), join(OUT_DIR, "fonts", "LICENSE.txt"));

const favicon = fingerprintSvg("toip.tools", { cell: 7 }).value.replace('aria-hidden="true" focusable="false"', 'xmlns="http://www.w3.org/2000/svg"');
writeFileSync(join(OUT_DIR, "favicon.svg"), favicon);

// Hashed CSS and JS.
function asset(src: string, name: string, ext: string): string {
  const body = readFileSync(join(SITE_DIR, src));
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 10);
  const file = `${name}.${hash}.${ext}`;
  mkdirSync(join(OUT_DIR, "assets"), { recursive: true });
  writeFileSync(join(OUT_DIR, "assets", file), body);
  return u(`/assets/${file}`);
}
const cssHref = asset("src/styles/site.css", "site", "css");
const jsHref = asset("src/scripts/site.js", "site", "js");

// Pages.
const specs = loadSpecs();
const sample = await sealSample();
const modules = readModules();
const releases = loadReleases();
const pages: Page[] = [
  homePage(sample, specs.length),
  docsPage(),
  quickstartPage(),
  ...guidePages(modules),
  conceptsPage(),
  faqPage(),
  ...toolkitPages(modules),
  examplesPage(),
  ecosystemPage(),
  ...specPages(specs),
  releasesPage(releases),
  agentsPage(),
  involvedPage(),
];

const byPath = new Map(pages.map((p) => [p.path, p]));
if (byPath.size !== pages.length) throw new Error("two pages share a path");
const titles = new Map<string, string>();
for (const p of pages) {
  const t = pageTitle(p);
  if (titles.has(t)) warnings.push(`two pages share the title "${t}": ${titles.get(t)} and ${p.path}`);
  titles.set(t, p.path);
}

/** Where each page's social image goes: next to its HTML. */
const ogPath = (p: Page) => (p.path === "/404.html" ? "/og.png" : `${p.path}og.png`);

const built: BuiltPage[] = [];
const ogJobs: OgJob[] = [];
for (const p of [...pages, notFoundPage()]) {
  const isPage = p.path !== "/404.html";
  const crumbs = breadcrumbs(p, byPath);
  const lastmod = p.sources ? lastModified(p.sources) : undefined;
  const markdownPath = isPage ? `${p.path}index.md` : undefined;
  const doc = layout(p, { cssHref, jsHref, crumbs, lastmod, ogImage: ogPath(p), markdownPath, jsonLd: jsonLdFor(p, crumbs, { lastmod, ogImage: ogPath(p) }), feedPath: FEED_PATH });
  const file = isPage ? join(OUT_DIR, p.path, "index.html") : join(OUT_DIR, "404.html");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, doc);
  if (!isPage) continue;
  const markdown = htmlToMarkdown(doc, { url: abs(p.path) });
  writeFileSync(join(OUT_DIR, p.path, "index.md"), `${markdown}\n---\n\nThis is the Markdown version of ${abs(p.path)}. An index of the documentation for AI assistants is at ${abs("/llms.txt")}.\n`);
  built.push({ page: p, markdown, markdownPath, lastmod });
  ogJobs.push({
    file: join(OUT_DIR, ogPath(p).slice(1)),
    title: p.ogTitle ?? p.title,
    eyebrow: p.eyebrow ?? "toip.tools",
    description: p.ogText ?? p.description,
    footer: p.ogFooter ?? "npm install @toip-tools/trust-core",
    mono: p.monoTitle ?? false,
  });
}

// Social images. They need Playwright's Chromium (npx playwright install chromium).
try {
  const og = await renderOgImages(ogJobs);
  console.log(`social images: ${og.drawn} drawn, ${og.cached} from the cache`);
} catch (e) {
  warnings.push(`social images not drawn: ${(e as Error).message.split("\n")[0]}. Run npx playwright install chromium.`);
}

const sizes = writeAgentFiles({ all: built, modules, specs, releases, renderMd: (s) => md(s).value });

// The fonts are referenced from CSS as ../fonts/, relative to /assets/.
if (!existsSync(join(OUT_DIR, "fonts", "recursive-latin-mono.woff2"))) throw new Error("fonts missing");

for (const w of warnings) console.warn(`warning: ${w}`);
const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
console.log(`llms.txt ${kb(sizes["/llms.txt"])}, llms-full.txt ${kb(sizes["/llms-full.txt"])}`);
console.log(`built ${pages.length + 1} pages and ${built.length} Markdown twins into dist/ with base ${BASE} in ${Date.now() - t0} ms`);
if (process.env.STRICT && warnings.length) process.exit(1);
