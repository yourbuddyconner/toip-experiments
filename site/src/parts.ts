// Small pieces several pages share.
import { u } from "../build/config";
import { html, raw, type Raw } from "../build/html";
import { libBySlug, type LibStatus } from "./data/libraries";
import type { ProjectStatus } from "./data/projects";

/** A status, as a shape and words: filled for working, half for being built, ring for design only. */
export function status(s: ProjectStatus | LibStatus): Raw {
  const shape =
    s === "working" || s === "ready"
      ? '<circle cx="6" cy="6" r="5" fill="currentColor"/>'
      : s === "being built" || s === "in progress"
        ? '<circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6 1.5a4.5 4.5 0 0 1 0 9z" fill="currentColor"/>'
        : '<circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/>';
  const cls = s.replace(/ /g, "-");
  return html`<span class="status status--${cls}"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">${raw(shape)}</svg>${s === "ready" ? "Ready" : s[0].toUpperCase() + s.slice(1)}</span>`;
}

export function libLink(slug: string): Raw {
  const l = libBySlug(slug);
  return html`<a href="${u(`/toolkit/${slug}/`)}"><code>${l.name}</code></a>`;
}

export function libLinks(slugs: string[]): Raw {
  return html`${slugs.map((s, i) => html`${i ? (i === slugs.length - 1 ? " and " : ", ") : ""}${libLink(s)}`)}`;
}

export function pageHead(title: string, lede?: string | Raw): Raw {
  return html`<div class="page-head"><h1>${title}</h1>${lede ? html`<p class="lede">${lede}</p>` : ""}</div>`;
}

export function specHref(name: string): string {
  return u(`/spec/${name}/0.1/`);
}

/** An arrow for diagrams and flows (an SVG, so the font doesn't need the glyph). */
export function arrow(label = "to"): Raw {
  return raw(
    `<svg width="22" height="12" viewBox="0 0 22 12" role="img" aria-label="${label}" data-md="→"><path d="M1 6h18M14 1.5 19.5 6 14 10.5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`,
  );
}
