import { REPO, SITE_NAME, abs, u } from "../build/config";
import { fingerprintSvg } from "../build/fingerprint";
import { html, raw, type Raw } from "../build/html";

export type Section =
  | "home" | "docs" | "quickstart" | "concepts" | "guides" | "faq" | "toolkit" | "examples" | "spec" | "ecosystem" | "involved" | "api" | "releases" | "none";

/** What a page is, for structured data and the Open Graph type. */
export type PageKind = "home" | "article" | "reference" | "collection" | "faq" | "page";

export interface Page {
  /** Site path, starting and ending with "/" (or ending in .html for the 404 page). */
  path: string;
  /** The page's own name: its heading, breadcrumbs and Open Graph title. */
  title: string;
  /** The search result snippet, and the Open Graph description. */
  description: string;
  section: Section;
  body: Raw;
  /** The full <title>, written for what someone would search for. Defaults to "<title> · toip.tools". */
  seoTitle?: string;
  kind?: PageKind;
  /** A short label for the social image: "Guide", "SDK library", "API reference". */
  eyebrow?: string;
  /** The social image's title and text, when they should differ from the page's title and description. */
  ogTitle?: string;
  ogText?: string;
  /** The social image's footer line, such as an install command. */
  ogFooter?: string;
  /** Show the title in monospace on the social image (identifiers, package names). */
  monoTitle?: boolean;
  /** Extra JSON-LD nodes, such as SoftwareSourceCode or FAQPage. */
  schema?: Record<string, unknown>[];
  /** Repository paths (files or folders) whose last commit dates this page, for the sitemap. */
  sources?: string[];
  /** A "Copy page as Markdown" tool at the top of the content column. Documentation pages have one. */
  tools?: boolean;
}

/** What the build knows about a page beyond its template: breadcrumbs, dates, and asset URLs. */
export interface PageContext {
  cssHref: string;
  jsHref: string;
  crumbs: { name: string; path: string }[];
  lastmod?: string;
  ogImage: string;
  /** The Markdown twin's site path, if the page has one. */
  markdownPath?: string;
  jsonLd: Record<string, unknown>[];
  feedPath: string;
}

const NAV: { section: Section; href: string; label: string }[] = [
  { section: "docs", href: "/docs/", label: "Documentation" },
  { section: "guides", href: "/guides/", label: "Guides" },
  { section: "examples", href: "/examples/", label: "Examples" },
  { section: "ecosystem", href: "/ecosystem/", label: "Ecosystem" },
];

/** Sections that sit under Documentation in the navigation. */
export const DOC_SECTIONS: Section[] = ["docs", "quickstart", "concepts", "faq", "toolkit", "spec", "api", "releases"];

export function pageTitle(p: Page): string {
  return p.seoTitle ?? (p.section === "home" ? p.title : `${p.title} · ${SITE_NAME}`);
}

/** Copy the page as Markdown (with JavaScript), or open its Markdown twin (always). */
function pageTools(markdownPath: string): Raw {
  return html`<div class="page-tools" data-md-skip><a class="page-tools__md" href="${u(markdownPath)}" type="text/markdown" data-copy-markdown>View as Markdown</a></div>`;
}

const jsonLdScript = (nodes: Record<string, unknown>[]) =>
  raw(`<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": nodes }).replaceAll("<", "\\u003c")}</script>`);

export function layout(p: Page, ctx: PageContext): string {
  const title = pageTitle(p);
  const canonical = abs(p.path);
  const article = p.kind === "article" || p.kind === "reference" || p.kind === "faq";
  const noindex = p.path === "/404.html";
  let body = p.body.value;
  if (p.tools && ctx.markdownPath) {
    const marker = '<div class="docs__content">';
    if (!body.includes(marker)) throw new Error(`${p.path}: page tools need a .docs__content column`);
    body = body.replace(marker, marker + pageTools(ctx.markdownPath).value);
  }
  const ogAlt = `${p.title}: ${p.eyebrow ?? "toip.tools"}`;
  return `<!doctype html>
${html`<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${p.description}">
${noindex ? raw('<meta name="robots" content="noindex">') : html`<link rel="canonical" href="${canonical}">`}
${ctx.markdownPath ? html`<link rel="alternate" type="text/markdown" href="${abs(ctx.markdownPath)}" title="This page as Markdown">` : ""}
<link rel="alternate" type="application/atom+xml" href="${abs(ctx.feedPath)}" title="toip.tools releases">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:type" content="${article ? "article" : "website"}">
<meta property="og:locale" content="en_US">
${noindex ? "" : html`<meta property="og:url" content="${canonical}">`}
<meta property="og:title" content="${p.seoTitle ?? p.title}">
<meta property="og:description" content="${p.description}">
<meta property="og:image" content="${abs(ctx.ogImage)}">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${ogAlt}">
${article && ctx.lastmod ? html`<meta property="article:modified_time" content="${ctx.lastmod}">` : ""}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${p.seoTitle ?? p.title}">
<meta name="twitter:description" content="${p.description}">
<meta name="twitter:image" content="${abs(ctx.ogImage)}">
<meta name="twitter:image:alt" content="${ogAlt}">
<meta name="theme-color" content="#1e372f">
<link rel="icon" href="${u("/favicon.svg")}" type="image/svg+xml">
<link rel="preload" href="${u("/fonts/recursive-latin-mono.woff2")}" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${ctx.cssHref}">
${ctx.jsonLd.length ? jsonLdScript(ctx.jsonLd) : ""}
<script>document.documentElement.classList.add("js")</script>
<script type="module" src="${ctx.jsHref}"></script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-head">
  <div class="wrap">
    <a class="mark" href="${u("/")}"${p.section === "home" ? raw(' aria-current="page"') : ""}>${fingerprintSvg("toip.tools", { cell: 4 })}<span>toip.tools</span></a>
    <nav class="site-nav" aria-label="Site">
      <ul>
        ${NAV.map((n) => {
          const inside = p.section === n.section || (n.section === "docs" && DOC_SECTIONS.includes(p.section));
          return html`<li><a href="${u(n.href)}"${inside ? raw(p.path === n.href ? ' aria-current="page"' : ' aria-current="true"') : ""}>${n.label}</a></li>`;
        })}
        <li><a href="${REPO}">GitHub</a></li>
      </ul>
    </nav>
  </div>
</header>
<main id="main" tabindex="-1">
${raw(body)}
</main>
<footer class="site-foot">
  <div class="wrap">
    <a class="mark" href="${u("/")}">toip.tools</a>
    <p>Independent TypeScript libraries and examples for verifiable trust. Source in <a href="${REPO}">toip-tools</a>. Unaffiliated with the Trust over IP Foundation.</p>
    <ul>
      <li><a href="${u("/docs/")}">Documentation</a></li>
      <li><a href="${u("/guides/")}">Guides</a></li>
      <li><a href="${u("/faq/")}">FAQ</a></li>
      <li><a href="${u("/spec/")}">Trust Task reference</a></li>
      <li><a href="${u("/ecosystem/")}">Ecosystem guide</a></li>
      <li><a href="${u("/releases/")}">Releases</a></li>
      <li><a href="${u("/api/")}">For AI agents</a></li>
      <li><a href="${REPO}">Source on GitHub</a></li>
      <li><a href="${REPO}/issues">Issues</a></li>
      <li><a href="${u("/get-involved/")}">Contribute</a></li>
    </ul>
  </div>
</footer>
</body>
</html>`}
`;
}
