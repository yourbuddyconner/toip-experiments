import { BASE, ORIGIN, REPO, u } from "../build/config";
import { fingerprintSvg } from "../build/fingerprint";
import { html, raw, type Raw } from "../build/html";

export type Section = "home" | "quickstart" | "concepts" | "toolkit" | "examples" | "spec" | "ecosystem" | "involved" | "none";

export interface Page {
  /** Site path, starting and ending with "/" (or ending in .html for the 404 page). */
  path: string;
  title: string;
  description: string;
  section: Section;
  body: Raw;
}

const NAV: { section: Section; href: string; label: string }[] = [
  { section: "quickstart", href: "/quickstart/", label: "Quickstart" },
  { section: "concepts", href: "/concepts/", label: "Concepts" },
  { section: "toolkit", href: "/toolkit/", label: "Toolkit" },
  { section: "examples", href: "/examples/", label: "Examples" },
  { section: "spec", href: "/spec/", label: "Task specs" },
  { section: "ecosystem", href: "/ecosystem/", label: "Ecosystem" },
  { section: "involved", href: "/get-involved/", label: "Get involved" },
];

export function layout(p: Page, opts: { cssHref: string; jsHref: string }): string {
  const title = p.section === "home" ? p.title : `${p.title} · toip.tools`;
  const canonical = ORIGIN + BASE + p.path.replace(/^\//, "");
  return `<!doctype html>
${html`<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${p.description}">
<link rel="canonical" href="${canonical}">
<meta property="og:title" content="${p.title}">
<meta property="og:description" content="${p.description}">
<meta property="og:type" content="website">
<meta name="theme-color" content="#1e372f">
<link rel="icon" href="${u("/favicon.svg")}" type="image/svg+xml">
<link rel="preload" href="${u("/fonts/recursive-latin-mono.woff2")}" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${opts.cssHref}">
<script>document.documentElement.classList.add("js")</script>
<script type="module" src="${opts.jsHref}"></script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-head">
  <div class="wrap">
    <a class="mark" href="${u("/")}"${p.section === "home" ? raw(' aria-current="page"') : ""}>${fingerprintSvg("toip.tools", { cell: 4 })}<span>toip.tools</span></a>
    <nav class="site-nav" aria-label="Site">
      <ul>
        ${NAV.map(
          (n) => html`<li><a href="${u(n.href)}"${p.section === n.section ? raw(p.path === n.href ? ' aria-current="page"' : ' aria-current="true"') : ""}>${n.label}</a></li>`,
        )}
      </ul>
    </nav>
  </div>
</header>
<main id="main" tabindex="-1">
${p.body}
</main>
<footer class="site-foot">
  <div class="wrap">
    <a class="mark" href="${u("/")}">toip.tools</a>
    <p>Independent TypeScript libraries and examples for verifiable trust. Source in <a href="${REPO}">toip-tools</a>. Unaffiliated with the Trust over IP Foundation.</p>
    <ul>
      <li><a href="${u("/quickstart/")}">Quickstart</a></li>
      <li><a href="${u("/spec/")}">Trust Task types</a></li>
      <li><a href="${u("/ecosystem/")}">Ecosystem guide</a></li>
      <li><a href="${REPO}">Source on GitHub</a></li>
      <li><a href="${REPO}/issues">Issues</a></li>
    </ul>
  </div>
</footer>
</body>
</html>`}
`;
}
