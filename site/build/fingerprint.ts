// A key fingerprint: a small 2 x 8 glyph and a hue, both from SHA-256 of a DID.
// Every DID the site prints carries one, so the same key looks the same everywhere.
import { createHash } from "node:crypto";
import { esc, html, raw, type Raw } from "./html";

export function hueOf(did: string): number {
  const h = createHash("sha256").update(did).digest();
  return Math.round((h.readUInt16BE(0) / 65536) * 360);
}

export function fingerprintSvg(did: string, opts: { cell?: number; label?: string } = {}): Raw {
  const h = createHash("sha256").update(did).digest();
  const hue = hueOf(did);
  const c = opts.cell ?? 5;
  const gap = 1;
  const rects: string[] = [];
  for (let i = 0; i < 16; i++) {
    const on = (h[2 + (i >> 3)] >> (i & 7)) & 1;
    const x = (i % 8) * (c + gap);
    const y = Math.floor(i / 8) * (c + gap);
    rects.push(`<rect x="${x}" y="${y}" width="${c}" height="${c}" fill="${on ? `oklch(0.52 0.15 ${hue})` : `oklch(0.86 0.06 ${hue})`}"/>`);
  }
  const w = 8 * (c + gap) - gap;
  const hgt = 2 * (c + gap) - gap;
  const label = opts.label ?? "";
  return raw(
    `<svg class="fp" width="${w}" height="${hgt}" viewBox="0 0 ${w} ${hgt}" ${label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"'} focusable="false">${rects.join("")}</svg>`,
  );
}

export function shortDid(did: string): string {
  return `${did.slice(0, 14)}…${did.slice(-4)}`;
}

/** A DID as the site prints it: its fingerprint, then the identifier in monospace. */
export function didTag(did: string, opts: { short?: boolean; name?: string } = {}): Raw {
  const shown = opts.short ? shortDid(did) : did;
  return html`<span class="did" style="--h:${hueOf(did)}" title="${did}">${fingerprintSvg(did)}${opts.name ? html`<span class="did__name">${opts.name}</span>` : ""}<code>${shown}</code></span>`;
}
