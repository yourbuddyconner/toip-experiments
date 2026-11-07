// Checks what the build wrote for crawlers and agents, after `npm run build`: a Markdown twin for every page,
// llms.txt's structure and links, llms-full.txt's coverage, the JSON indexes, the sitemap, robots.txt,
// JSON-LD on every page, one social image per page at 1200 x 630, the feed, security.txt, and each page's
// title, description, canonical URL, single <h1> and image alt text.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { BASE, ORIGIN, OUT_DIR, REPO_DIR } from "./config";
import { AI_CRAWLERS } from "./agent-files";
import { pngSize } from "./og";
import { guides } from "../src/data/guides";
import { libraries } from "../src/data/libraries";
import { projects } from "../src/data/projects";

const problems: string[] = [];
// On a case-insensitive disk (macOS by default), symbol pages such as DEPTH and Depth share a folder, and the
// last one written wins. The deploy builds on Linux, where they don't; here, compare paths ignoring case.
const caseless = existsSync(join(OUT_DIR, "INDEX.HTML"));
const same = (a?: string, b?: string) => (caseless ? a?.toLowerCase() === b?.toLowerCase() : a === b);
const fail = (s: string) => problems.push(s);
const read = (rel: string) => readFileSync(join(OUT_DIR, rel), "utf8");
const prefix = ORIGIN + BASE;

function files(dir: string, test: (n: string) => boolean, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) files(p, test, out);
    else if (test(n)) out.push(p);
  }
  return out;
}

/** The file in dist/ an absolute site URL serves, if any. */
function served(url: string): string | undefined {
  if (!url.startsWith(prefix)) return undefined;
  const rel = decodeURIComponent(url.slice(prefix.length).replace(/[#?].*$/, ""));
  const p = join(OUT_DIR, rel);
  if (existsSync(p) && statSync(p).isFile()) return p;
  if (existsSync(join(p, "index.html"))) return join(p, "index.html");
  return undefined;
}

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1]?.replace(/&amp;/g, "&").replace(/&quot;/g, '"');
const meta = (doc: string, key: string) => {
  for (const m of doc.matchAll(/<meta\s[^>]*>/g)) if (attr(m[0], "property") === key || attr(m[0], "name") === key) return attr(m[0], "content");
  return undefined;
};

// ── Every HTML page ──────────────────────────────────────
const pages = files(OUT_DIR, (n) => n === "index.html");
const titles = new Map<string, string>();
const jsonLdTypes = new Map<string, number>();
const ogImages = new Set<string>();

type Node = Record<string, unknown> & { "@type"?: string | string[] };
const REQUIRED: Record<string, string[]> = {
  WebSite: ["name", "url", "potentialAction"],
  TechArticle: ["headline", "description", "url", "inLanguage"],
  CollectionPage: ["name", "url"],
  WebPage: ["name", "url"],
  BreadcrumbList: ["itemListElement"],
  SoftwareSourceCode: ["name", "codeRepository", "programmingLanguage", "license", "version", "targetProduct"],
  SoftwareApplication: ["name", "softwareVersion", "downloadUrl", "applicationCategory"],
  FAQPage: ["mainEntity"],
  ItemList: ["itemListElement"],
};

function checkNode(page: string, n: Node) {
  const type = Array.isArray(n["@type"]) ? n["@type"][0] : n["@type"];
  if (!type) return fail(`${page}: JSON-LD node without @type`);
  jsonLdTypes.set(type, (jsonLdTypes.get(type) ?? 0) + 1);
  for (const k of REQUIRED[type] ?? []) if (n[k] === undefined || n[k] === "" || (Array.isArray(n[k]) && !(n[k] as unknown[]).length)) fail(`${page}: ${type} lacks ${k}`);
  if (type === "BreadcrumbList")
    (n.itemListElement as Node[]).forEach((li, i) => {
      if (li.position !== i + 1 || !li.name || typeof li.item !== "string" || !served(li.item)) fail(`${page}: breadcrumb ${i + 1} is incomplete or doesn't resolve`);
    });
  if (type === "FAQPage")
    for (const q of n.mainEntity as Node[]) {
      const a = q.acceptedAnswer as Node | undefined;
      if (q["@type"] !== "Question" || !q.name || a?.["@type"] !== "Answer" || !a.text) fail(`${page}: FAQ question incomplete`);
    }
  if (type === "SoftwareSourceCode") checkNode(page, n.targetProduct as Node);
  if (type === "WebSite" && !String((n.potentialAction as Node)?.["query-input"] ?? "").includes("search_term_string")) fail(`${page}: SearchAction lacks query-input`);
}

for (const file of pages) {
  const page = `/${relative(OUT_DIR, file)}`.replace(/index\.html$/, "");
  const doc = readFileSync(file, "utf8");

  const title = doc.match(/<title>([^<]*)<\/title>/)?.[1];
  if (!title) fail(`${page}: no <title>`);
  else if (titles.has(title)) fail(`${page}: same <title> as ${titles.get(title)}`);
  else titles.set(title, page);
  const description = meta(doc, "description");
  if (!description || description.length < 50) fail(`${page}: meta description missing or under 50 characters`);
  const canonical = doc.match(/<link rel="canonical" href="([^"]+)">/)?.[1];
  if (!same(canonical, prefix + page.slice(1))) fail(`${page}: canonical is ${canonical}`);
  const h1 = doc.match(/<h1[\s>]/g)?.length ?? 0;
  if (h1 !== 1) fail(`${page}: ${h1} <h1> elements`);
  for (const img of doc.matchAll(/<img\s[^>]*>/g)) if (attr(img[0], "alt") === undefined) fail(`${page}: <img> without alt`);

  // Markdown twin.
  const twin = doc.match(/<link rel="alternate" type="text\/markdown" href="([^"]+)"/)?.[1];
  const mdFile = join(file, "..", "index.md");
  if (!same(twin, `${prefix}${page.slice(1)}index.md`)) fail(`${page}: alternate Markdown link is ${twin}`);
  if (!existsSync(mdFile)) fail(`${page}: no index.md`);
  else {
    const md = readFileSync(mdFile, "utf8");
    if (!/^# \S/m.test(md)) fail(`${page}index.md: no level-1 heading`);
    if (/<(div|span|section|svg|script)\b/.test(md.replace(/^(```+)[\s\S]*?^\1/gm, ""))) fail(`${page}index.md: HTML left outside code`);
    if (/\]\((?!https?:|mailto:)/.test(md)) fail(`${page}index.md: a relative link`);
  }

  // Social image.
  const og = meta(doc, "og:image");
  const ogFile = og && served(og);
  if (!ogFile) fail(`${page}: og:image ${og} doesn't resolve`);
  else {
    const size = pngSize(readFileSync(ogFile));
    if (size?.width !== 1200 || size.height !== 630) fail(`${page}: og:image is ${size ? `${size.width}x${size.height}` : "not a PNG"}`);
    ogImages.add(ogFile);
  }
  for (const k of ["og:title", "og:description", "og:url", "twitter:card", "twitter:image"]) if (!meta(doc, k)) fail(`${page}: no ${k}`);

  // JSON-LD.
  const ld = [...doc.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  if (ld.length !== 1) fail(`${page}: ${ld.length} JSON-LD blocks`);
  for (const m of ld) {
    try {
      const data = JSON.parse(m[1]);
      if (data["@context"] !== "https://schema.org" || !Array.isArray(data["@graph"])) fail(`${page}: JSON-LD lacks @context or @graph`);
      for (const n of data["@graph"] as Node[]) checkNode(page, n);
      const types = (data["@graph"] as Node[]).map((n) => n["@type"]);
      if (page !== "/" && !types.includes("BreadcrumbList")) fail(`${page}: no BreadcrumbList`);
    } catch (e) {
      fail(`${page}: JSON-LD doesn't parse (${(e as Error).message})`);
    }
  }
}
const notFound = read("404.html");
if (!notFound.includes('<meta name="robots" content="noindex">')) fail("404.html: not marked noindex");

// ── llms.txt ─────────────────────────────────────────────
const llms = read("llms.txt");
const lines = llms.split("\n");
if (!/^# \S/.test(lines[0])) fail("llms.txt: the first line isn't an H1");
if (lines.filter((l) => /^# /.test(l)).length !== 1) fail("llms.txt: more than one H1");
const firstBlock = lines.slice(1).find((l) => l.trim());
if (!firstBlock?.startsWith("> ")) fail("llms.txt: no blockquote summary after the H1");
const sections = lines.filter((l) => /^## /.test(l)).map((l) => l.slice(3));
for (const s of ["Docs", "Guides", "Libraries", "Reference", "Optional"]) if (!sections.includes(s)) fail(`llms.txt: no "## ${s}" section`);
if (sections.at(-1) !== "Optional") fail("llms.txt: Optional isn't the last section");
let inSection = false;
let llmsLinks = 0;
for (const l of lines) {
  if (l.startsWith("## ")) inSection = true;
  if (!inSection || !l.startsWith("- ")) continue;
  const m = l.match(/^- \[([^\]]+)\]\((\S+)\)(: .+)?$/);
  if (!m) fail(`llms.txt: malformed link line: ${l}`);
  else if (!m[3]) fail(`llms.txt: link without a note: ${l}`);
  else if (!served(m[2])) fail(`llms.txt: ${m[2]} doesn't resolve`);
  else llmsLinks++;
}
for (const g of guides) if (!llms.includes(`/guides/${g.slug}/index.md`)) fail(`llms.txt: no link to guide ${g.slug}`);
for (const l of libraries) if (!llms.includes(`/toolkit/${l.slug}/index.md`)) fail(`llms.txt: no link to ${l.name}`);
for (const j of ["libraries.json", "specs.json", "examples.json"]) if (!llms.includes(`/api/${j}`)) fail(`llms.txt: no link to /api/${j}`);

// ── llms-full.txt ────────────────────────────────────────
const full = read("llms-full.txt");
const inFull = new Set([...full.matchAll(/<page url="([^"]+)">/g)].map((m) => m[1].slice(prefix.length - 1)));
const specPages = pages.map((f) => `/${relative(OUT_DIR, f)}`.replace(/index\.html$/, "")).filter((p) => /^\/spec\/.+\/0\.1\/$/.test(p));
for (const p of ["/docs/", "/quickstart/", "/concepts/", "/faq/", "/spec/", ...guides.map((g) => `/guides/${g.slug}/`), ...libraries.map((l) => `/toolkit/${l.slug}/`), ...specPages])
  if (!inFull.has(p)) fail(`llms-full.txt: no ${p}`);
if (!/^```ts$/m.test(full) || !/^```bash$/m.test(full)) fail("llms-full.txt: no TypeScript or shell code blocks");

// ── JSON indexes ─────────────────────────────────────────
function json(rel: string): any {
  try {
    return JSON.parse(read(rel));
  } catch (e) {
    fail(`${rel}: ${(e as Error).message}`);
    return {};
  }
}
const libs = json("api/libraries.json");
let exportCount = 0;
for (const l of libraries) {
  const entry = libs.libraries?.find((x: { name: string }) => x.name === l.name);
  const version = JSON.parse(readFileSync(join(REPO_DIR, l.dir, "package.json"), "utf8")).version;
  if (!entry) { fail(`libraries.json: no ${l.name}`); continue; }
  if (entry.version !== version) fail(`libraries.json: ${l.name} is ${entry.version}, package.json says ${version}`);
  for (const k of ["description", "install", "docs", "npm", "source"]) if (!entry[k]) fail(`libraries.json: ${l.name} lacks ${k}`);
  if (!entry.entryPoints?.length) fail(`libraries.json: ${l.name} has no entry points`);
  for (const ep of entry.entryPoints ?? []) {
    if (!ep.exports?.length) fail(`libraries.json: ${ep.import} has no exports`);
    for (const x of ep.exports ?? []) {
      exportCount++;
      if (!x.name || !x.kind || !served(x.reference)) fail(`libraries.json: ${ep.import} export ${x.name} is incomplete or its reference doesn't resolve`);
    }
  }
}
const specs = json("api/specs.json");
if (specs.specs?.length !== specPages.length) fail(`specs.json: ${specs.specs?.length} types, ${specPages.length} spec pages`);
for (const s of specs.specs ?? []) {
  for (const k of ["name", "uri", "purpose", "from", "to", "kind", "reference"]) if (!s[k]) fail(`specs.json: ${s.name} lacks ${k}`);
  if (!served(s.reference)) fail(`specs.json: ${s.name}'s reference doesn't resolve`);
}
const ex = json("api/examples.json");
for (const p of projects) if (!ex.projects?.some((x: { slug: string }) => x.slug === p.slug)) fail(`examples.json: no ${p.slug}`);
for (const p of ex.projects ?? []) if (!p.status || !Array.isArray(p.run)) fail(`examples.json: ${p.slug} lacks status or run`);

// ── sitemap.xml ──────────────────────────────────────────
const sitemap = read("sitemap.xml");
if (!sitemap.startsWith('<?xml version="1.0" encoding="UTF-8"?>') || !sitemap.includes('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')) fail("sitemap.xml: bad header");
const locs = [...sitemap.matchAll(/<url><loc>([^<]+)<\/loc>(?:<lastmod>([^<]+)<\/lastmod>)?<\/url>/g)];
const distinctLocs = new Set(locs.map((l) => (caseless ? l[1].toLowerCase() : l[1]))).size;
if (distinctLocs !== pages.length) fail(`sitemap.xml: ${locs.length} URLs for ${pages.length} pages`);
let withLastmod = 0;
for (const [, loc, lastmod] of locs) {
  if (!served(loc.replace(/&amp;/g, "&"))) fail(`sitemap.xml: ${loc} doesn't resolve`);
  if (lastmod) {
    withLastmod++;
    if (Number.isNaN(Date.parse(lastmod))) fail(`sitemap.xml: bad lastmod ${lastmod}`);
  }
}

// ── robots.txt ───────────────────────────────────────────
const robots = read("robots.txt");
const FIELDS = new Set(["user-agent", "allow", "disallow", "sitemap", "crawl-delay"]);
let sawAgent = false;
const agents = new Set<string>();
for (const [i, raw] of robots.split("\n").entries()) {
  const l = raw.replace(/#.*$/, "").trim();
  if (!l) continue;
  const m = l.match(/^([A-Za-z-]+):\s*(.*)$/);
  if (!m || !FIELDS.has(m[1].toLowerCase())) { fail(`robots.txt line ${i + 1}: not a known directive: ${raw}`); continue; }
  const field = m[1].toLowerCase();
  if (field === "user-agent") { sawAgent = true; agents.add(m[2]); }
  else if (field === "sitemap") { if (!served(m[2])) fail(`robots.txt: sitemap ${m[2]} doesn't resolve`); }
  else if (!sawAgent) fail(`robots.txt line ${i + 1}: ${m[1]} before any User-agent`);
  if (field === "disallow" && m[2]) fail(`robots.txt: disallows ${m[2]}`);
}
for (const a of ["*", ...AI_CRAWLERS]) if (!agents.has(a)) fail(`robots.txt: no group for ${a}`);
for (const a of ["GPTBot", "ClaudeBot", "Claude-SearchBot", "PerplexityBot", "Google-Extended", "CCBot", "Applebot-Extended"]) if (!agents.has(a)) fail(`robots.txt: ${a} isn't named`);

// ── The feed and security.txt ────────────────────────────
const feed = read("releases.xml");
const entries = feed.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
if (!feed.includes('<feed xmlns="http://www.w3.org/2005/Atom">') || !entries.length) fail("releases.xml: not an Atom feed with entries");
for (const e of entries) for (const t of ["id", "title", "updated", "content"]) if (!new RegExp(`<${t}[ >]`).test(e)) fail(`releases.xml: an entry lacks <${t}>`);
const security = read(".well-known/security.txt");
if (!/^Contact: https:\/\//m.test(security)) fail("security.txt: no Contact");
const expires = Date.parse(security.match(/^Expires: (.+)$/m)?.[1] ?? "");
if (!(expires > Date.now() && expires < Date.now() + 366 * 86_400_000)) fail("security.txt: Expires must be in the next year");

const kb = (rel: string) => `${(statSync(join(OUT_DIR, rel)).size / 1024).toFixed(0)} KB`;
console.log(`${pages.length} pages: every one has a Markdown twin, one <h1>, a 1200x630 social image (${ogImages.size} images) and JSON-LD (${[...jsonLdTypes].map(([t, n]) => `${t} ${n}`).join(", ")})`);
console.log(`llms.txt ${kb("llms.txt")} with ${llmsLinks} links; llms-full.txt ${kb("llms-full.txt")} with ${inFull.size} pages`);
console.log(`libraries.json: ${libs.libraries?.length} libraries, ${exportCount} exports; specs.json: ${specs.specs?.length} types; examples.json: ${ex.projects?.length} projects`);
console.log(`sitemap.xml: ${locs.length} URLs, ${withLastmod} with lastmod; robots.txt names ${agents.size - 1} crawlers; releases.xml: ${entries.length} entries`);
if (problems.length) {
  console.error(`\n${problems.length} problems:\n${problems.slice(0, 80).join("\n")}`);
  process.exit(1);
}
console.log("All outputs check out.");
