// Breadcrumbs and JSON-LD for every page, from the page list itself.
import { REPO, SITE_NAME, abs } from "./config";
import { DOC_SECTIONS, type Page } from "../src/layout";

export const WEBSITE_ID = `${abs("/")}#website`;
export const SITE_DESCRIPTION =
  "TypeScript libraries and runnable examples for Trust over IP: did:key identities, verifiable credentials, the Trust Spanning Protocol (TSP), Trust Tasks, delegation, KERI event logs and zero-knowledge membership.";

export type Crumb = { name: string; path: string };

/** Home, then every ancestor path that is a page, then the page. Documentation pages sit under /docs/. */
export function breadcrumbs(p: Page, byPath: Map<string, Page>): Crumb[] {
  if (p.path === "/") return [];
  const crumbs: Crumb[] = [{ name: "Home", path: "/" }];
  if (p.path !== "/docs/" && (DOC_SECTIONS.includes(p.section) || p.section === "guides") && p.section !== "docs") crumbs.push({ name: "Documentation", path: "/docs/" });
  const parts = p.path.split("/").filter(Boolean);
  for (let i = 1; i < parts.length; i++) {
    const prefix = `/${parts.slice(0, i).join("/")}/`;
    const ancestor = byPath.get(prefix);
    if (ancestor && !crumbs.some((c) => c.path === prefix)) crumbs.push({ name: ancestor.title, path: prefix });
  }
  crumbs.push({ name: p.title, path: p.path });
  return crumbs;
}

function breadcrumbList(crumbs: Crumb[]): Record<string, unknown> {
  return {
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.name, item: abs(c.path) })),
  };
}

/** The JSON-LD graph for a page: what it is, where it sits, and anything the page adds. */
export function jsonLdFor(p: Page, crumbs: Crumb[], opts: { lastmod?: string; ogImage: string }): Record<string, unknown>[] {
  if (p.path === "/404.html") return [];
  const url = abs(p.path);
  const nodes: Record<string, unknown>[] = [];
  const isPartOf = { "@id": WEBSITE_ID };
  switch (p.kind ?? "page") {
    case "home":
      nodes.push({
        "@type": "WebSite",
        "@id": WEBSITE_ID,
        name: SITE_NAME,
        url,
        description: SITE_DESCRIPTION,
        inLanguage: "en",
        sameAs: [REPO],
        potentialAction: {
          "@type": "SearchAction",
          target: { "@type": "EntryPoint", urlTemplate: `${abs("/toolkit/")}?q={search_term_string}` },
          "query-input": "required name=search_term_string",
        },
      });
      break;
    case "article":
    case "reference":
      nodes.push({
        "@type": "TechArticle",
        "@id": `${url}#article`,
        headline: p.seoTitle && p.seoTitle.length <= 110 ? p.seoTitle : p.title,
        name: p.title,
        description: p.description,
        url,
        mainEntityOfPage: url,
        image: abs(opts.ogImage),
        inLanguage: "en",
        isPartOf,
        ...(p.kind === "reference" ? { genre: "Reference" } : {}),
        ...(opts.lastmod ? { dateModified: opts.lastmod } : {}),
        ...(p.section === "guides" ? { proficiencyLevel: "Beginner" } : {}),
      });
      break;
    case "collection":
      nodes.push({ "@type": "CollectionPage", "@id": `${url}#page`, name: p.title, description: p.description, url, inLanguage: "en", isPartOf, ...(opts.lastmod ? { dateModified: opts.lastmod } : {}) });
      break;
    case "faq":
      break; // the FAQ page supplies its FAQPage node
    default:
      nodes.push({ "@type": "WebPage", "@id": `${url}#page`, name: p.title, description: p.description, url, inLanguage: "en", isPartOf, ...(opts.lastmod ? { dateModified: opts.lastmod } : {}) });
  }
  if (crumbs.length) nodes.push(breadcrumbList(crumbs));
  nodes.push(...(p.schema ?? []));
  return nodes;
}

/** The npm page for a package. */
export const npmUrl = (name: string, version?: string) => `https://www.npmjs.com/package/${name}${version ? `/v/${version}` : ""}`;
