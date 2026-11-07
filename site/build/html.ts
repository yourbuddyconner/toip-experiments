// A tiny HTML templating layer: tagged templates that escape by default.
import { marked } from "marked";

export class Raw {
  constructor(readonly value: string) {}
  toString() {
    return this.value;
  }
}

export const raw = (s: string) => new Raw(s);

export function esc(s: unknown): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

type Part = Raw | string | number | boolean | null | undefined | Part[];

function render(v: Part): string {
  if (v === null || v === undefined || v === false || v === true) return "";
  if (Array.isArray(v)) return v.map(render).join("");
  if (v instanceof Raw) return v.value;
  return esc(v);
}

/** html`<p>${text}</p>` escapes interpolations unless they are Raw (or arrays of Raw). */
export function html(strings: TemplateStringsArray, ...values: Part[]): Raw {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new Raw(out);
}

marked.use({ gfm: true });

/** Markdown for prose. Indentation common to every line is removed first. */
export function md(strings: TemplateStringsArray | string, ...values: unknown[]): Raw {
  let src = typeof strings === "string" ? strings : strings.reduce((a, s, i) => a + s + (i < values.length ? String(values[i]) : ""), "");
  const lines = src.replace(/^\n/, "").split("\n");
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length));
  src = lines.map((l) => l.slice(indent)).join("\n");
  return new Raw(marked.parse(src, { async: false }) as string);
}

/** Inline markdown (no wrapping <p>). */
export function mdi(s: string): Raw {
  return new Raw(marked.parseInline(s, { async: false }) as string);
}

/** GitHub's heading anchors, for links into design documents. */
export function githubSlug(heading: string): string {
  return heading
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
