import { u } from "../build/config";
import { html, raw, type Raw } from "../build/html";
import { libraries } from "./data/libraries";

interface Link { label: string; href: string }

/** Shared documentation navigation, with a disclosure menu on small screens. */
export function docsNav(current: string, local: Link[] = []): Raw {
  const groups: { label: string; links: Link[] }[] = [
    { label: "Get started", links: [
      { label: "Documentation", href: "/docs/" },
      { label: "Setup", href: "/docs/#setup" },
      { label: "Quickstart", href: "/quickstart/" },
    ] },
    { label: "Learn", links: [{ label: "Concepts", href: "/concepts/" }] },
    { label: "Reference", links: [
      { label: "SDK reference", href: "/toolkit/" },
      { label: "Trust Task reference", href: "/spec/" },
    ] },
    { label: "Libraries", links: libraries.map((library) => ({ label: library.slug, href: `/toolkit/${library.slug}/` })) },
    ...(local.length ? [{ label: "On this page", links: local }] : []),
  ];
  const content = html`${groups.map((group) => html`<div class="docs-nav__group">
    <p class="side-h">${group.label}</p>
    <ul>${group.links.map((link) => {
      const active = current === link.href ? "page"
        : link.href.startsWith("/toolkit/") && current.startsWith(link.href) ? "true" : undefined;
      return html`<li><a href="${link.href.startsWith("#") ? link.href : u(link.href)}"${active ? raw(` aria-current="${active}"`) : ""}>${link.label}</a></li>`;
    })}</ul>
  </div>`)}`;
  return html`<nav class="docs__side" aria-label="Documentation">
    <div class="docs-nav__desktop">${content}</div>
    <details class="docs-nav__mobile"><summary>Documentation menu</summary>${content}</details>
  </nav>`;
}
