// Turns a built page into clean Markdown: its Markdown twin at <page>/index.md, and its part of llms-full.txt.
// It reads the HTML the build just rendered, so the two never drift. Code blocks keep their language,
// links become absolute, and interface-only parts (navigation, search boxes, buttons) are left out.
//
// Markup hints, for templates: data-md-skip leaves an element out; data-md="text" replaces it with text.
import { parse, type DefaultTreeAdapterMap } from "parse5";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

const SKIP_TAGS = new Set(["script", "style", "template", "nav", "button", "input", "select", "textarea", "label", "dialog", "noscript", "head"]);
const BLOCK_TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "dl", "table", "pre", "figure", "blockquote", "div", "section", "article",
  "header", "footer", "aside", "details", "summary", "hr", "main", "form", "fieldset", "dt", "dd", "li", "figcaption",
]);
const FENCE_LANG: Record<string, string> = { ts: "ts", bash: "bash", json: "json", console: "text", text: "text" };

const isElement = (n: Node): n is Element => "tagName" in n;
const attr = (e: Element, name: string) => e.attrs.find((a) => a.name === name)?.value;
const hasClass = (e: Element, cls: string) => (attr(e, "class") ?? "").split(/\s+/).includes(cls);
const children = (n: Node): Node[] => ("childNodes" in n ? n.childNodes : []);

function skipped(e: Element): boolean {
  return SKIP_TAGS.has(e.tagName) || attr(e, "data-md-skip") !== undefined || attr(e, "aria-hidden") === "true" || attr(e, "hidden") !== undefined;
}

/** All text below a node, as written (for code). */
function textOf(n: Node): string {
  if (n.nodeName === "#text") return (n as DefaultTreeAdapterMap["textNode"]).value;
  if (isElement(n) && n.tagName === "br") return "\n";
  return children(n).map(textOf).join("");
}

function find(n: Node, test: (e: Element) => boolean): Element | undefined {
  for (const c of children(n)) {
    if (isElement(c)) {
      if (test(c)) return c;
      const f = find(c, test);
      if (f) return f;
    }
  }
  return undefined;
}

function fence(code: string, lang = ""): string {
  const longest = Math.max(2, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(longest + 1);
  return `${f}${lang}\n${code.replace(/\n+$/, "")}\n${f}`;
}

function inlineCode(s: string): string {
  const t = s.replace(/\s+/g, " ");
  const longest = Math.max(0, ...[...t.matchAll(/`+/g)].map((m) => m[0].length));
  const d = "`".repeat(longest + 1);
  return longest || /^`|`$/.test(t) ? `${d} ${t} ${d}` : `${d}${t}${d}`;
}

const escapeText = (s: string) => s.replace(/([\\`*_[\]<])/g, "\\$1");

export interface MarkdownOptions {
  /** The page's absolute URL, to make links absolute. */
  url: string;
}

class Converter {
  constructor(private readonly url: string) {}

  abs(href: string): string {
    try {
      return new URL(href, this.url).href;
    } catch {
      return href;
    }
  }

  inline(n: Node): string {
    if (n.nodeName === "#text") return escapeText((n as DefaultTreeAdapterMap["textNode"]).value.replace(/\s+/g, " "));
    if (!isElement(n)) return "";
    const replacement = attr(n, "data-md");
    if (replacement !== undefined) return replacement;
    if (skipped(n)) return "";
    const inner = () => children(n).map((c) => this.inline(c)).join("");
    switch (n.tagName) {
      case "br":
        return " ";
      case "code":
      case "kbd":
      case "samp": {
        const t = textOf(n);
        return t.trim() ? inlineCode(t) : "";
      }
      case "strong":
      case "b": {
        const t = inner().trim();
        return t ? `**${t}**` : "";
      }
      case "em":
      case "i": {
        const t = inner().trim();
        return t ? `*${t}*` : "";
      }
      case "a": {
        const href = attr(n, "href");
        // A card: a link wrapping a heading and a description. Link the heading; follow it with the description.
        const heading = find(n, (c) => /^h[1-6]$/.test(c.tagName));
        if (heading && href) {
          const desc = children(n)
            .filter((c): c is Element => isElement(c) && c.tagName === "p")
            .map((c) => this.line(c))
            .join(" ");
          return `[${this.line(heading)}](${this.abs(href)})${desc ? `: ${desc}` : ""}`;
        }
        const t = inner().replace(/\s+/g, " ").trim();
        if (!href) return t;
        if (!t) return "";
        return `[${t}](${this.abs(href)})`;
      }
      case "img": {
        const alt = attr(n, "alt") ?? "";
        const src = attr(n, "src");
        return src && alt ? `![${escapeText(alt)}](${this.abs(src)})` : "";
      }
      case "svg": {
        const label = attr(n, "role") === "img" ? attr(n, "aria-label") : undefined;
        return label ? escapeText(label) : "";
      }
      default:
        return inner();
    }
  }

  /** Inline content of a node, trimmed and with runs of spaces collapsed. */
  line(n: Node): string {
    const items = children(n).filter((c) => !(c.nodeName === "#text" && !textOf(c).trim()));
    if (items.length > 1 && items.every(isElement) && items.every((c) => !["code", "strong", "em", "b", "i"].includes((c as Element).tagName)))
      return items.map((c) => this.inline(c).replace(/[ \t]+/g, " ").trim()).filter(Boolean).join(" · ");
    return children(n)
      .map((c) => this.inline(c))
      .join("")
      .replace(/[ \t]+/g, " ")
      .trim();
  }

  blocks(n: Node): string[] {
    const out: string[] = [];
    let run: Node[] = [];
    const flush = () => {
      const items = run.filter((c) => !(c.nodeName === "#text" && !textOf(c).trim()));
      // Sibling elements with no text between them are laid out apart (a row of facts or links): keep them apart.
      const t = items.length > 1 && items.every(isElement)
        ? items.map((c) => this.inline(c).replace(/[ \t]+/g, " ").trim()).filter(Boolean).join(" · ")
        : run.map((c) => this.inline(c)).join("").replace(/[ \t]+/g, " ").trim();
      if (t) out.push(t);
      run = [];
    };
    for (const c of children(n)) {
      if (isElement(c) && (BLOCK_TAGS.has(c.tagName) || c.tagName === "svg") && attr(c, "data-md") === undefined) {
        flush();
        out.push(...this.block(c));
      } else run.push(c);
    }
    flush();
    return out;
  }

  block(e: Element): string[] {
    if (skipped(e)) return [];
    const tag = e.tagName;
    if (/^h[1-6]$/.test(tag)) {
      const t = this.line(e);
      return t ? [`${"#".repeat(Number(tag[1]))} ${t}`] : [];
    }
    switch (tag) {
      case "p":
      case "summary": {
        const t = this.line(e);
        return t ? [tag === "summary" ? `**${t}**` : t] : [];
      }
      case "hr":
        return ["---"];
      case "pre": {
        const inner = find(e, (c) => c.tagName === "code");
        const lang = (inner && (attr(inner, "class") ?? "").match(/language-(\w+)/)?.[1]) || (hasClass(e, "json") ? "json" : "");
        return [fence(textOf(e), lang)];
      }
      case "ul":
      case "ol":
        return [this.list(e)];
      case "dl":
        return this.definitions(e);
      case "table":
        return [this.table(e)];
      case "blockquote":
        return [this.blocks(e).join("\n\n").replace(/^/gm, "> ")];
      case "figure":
        return this.figure(e);
      case "svg": {
        const label = attr(e, "role") === "img" ? attr(e, "aria-label") : undefined;
        return label ? [`*${escapeText(label)}*`] : [];
      }
      default:
        return this.blocks(e);
    }
  }

  figure(e: Element): string[] {
    const cap = find(e, (c) => c.tagName === "figcaption");
    if (hasClass(e, "code")) {
      const pre = find(e, (c) => c.tagName === "pre");
      if (!pre) return [];
      const title = cap ? find(cap, (c) => hasClass(c, "code__title")) : undefined;
      const caption = title ? this.line(title) : "";
      const lang = attr(e, "data-lang") ?? "";
      const label = lang === "console" ? (caption && caption !== "Recorded output" ? `Output (${caption}):` : "Output:") : caption ? `${caption}:` : "";
      return [...(label ? [label] : []), fence(textOf(pre), FENCE_LANG[lang] ?? "")];
    }
    const out: string[] = [];
    for (const c of children(e)) {
      if (!isElement(c) || c === cap) continue;
      out.push(...(c.tagName === "img" ? [this.inline(c)].filter(Boolean) : this.block(c)));
    }
    if (cap) {
      const t = this.line(cap);
      if (t) out.push(`*${t}*`);
    }
    return out;
  }

  list(e: Element, depth = 0): string {
    const ordered = e.tagName === "ol";
    const items = children(e).filter((c): c is Element => isElement(c) && c.tagName === "li" && !skipped(c));
    return items
      .map((li, i) => {
        const marker = ordered ? `${i + 1}.` : "-";
        const pad = " ".repeat(marker.length + 1);
        const parts: string[] = [];
        let run: Node[] = [];
        const flush = () => {
          const t = run.map((c) => this.inline(c)).join("").replace(/[ \t]+/g, " ").trim();
          if (t) parts.push(t);
          run = [];
        };
        for (const c of children(li)) {
          if (isElement(c) && (c.tagName === "ul" || c.tagName === "ol")) {
            flush();
            if (!skipped(c)) parts.push(this.list(c, depth + 1));
          } else if (isElement(c) && BLOCK_TAGS.has(c.tagName)) {
            flush();
            parts.push(...this.block(c));
          } else run.push(c);
        }
        flush();
        const [first = "", ...rest] = parts;
        const body = [first, ...rest.map((p) => p.replace(/^(?=.)/gm, pad))].join(`\n\n`);
        return `${marker} ${body}`;
      })
      .join(items.some((li) => children(li).some((c) => isElement(c) && ["p", "figure", "div", "pre"].includes(c.tagName))) ? "\n\n" : "\n");
  }

  definitions(e: Element): string[] {
    const pairs: { term: string; defs: Element[] }[] = [];
    const visit = (n: Node) => {
      for (const c of children(n)) {
        if (!isElement(c) || skipped(c)) continue;
        if (c.tagName === "dt") pairs.push({ term: this.line(c), defs: [] });
        else if (c.tagName === "dd") pairs.at(-1)?.defs.push(c);
        else if (c.tagName === "div") visit(c);
      }
    };
    visit(e);
    const out: string[] = [];
    const simple = pairs.every((p) => p.defs.every((d) => !find(d, (x) => ["p", "ul", "ol", "pre", "figure", "dl", "div", "details"].includes(x.tagName))));
    if (simple) return [pairs.map((p) => `- **${p.term}**: ${p.defs.map((d) => this.line(d)).join("; ")}`).join("\n")];
    for (const p of pairs) {
      out.push(`**${p.term}**`);
      for (const d of p.defs) out.push(...this.blocks(d));
    }
    return out;
  }

  table(e: Element): string {
    const rows: string[][] = [];
    let header: string[] | undefined;
    const caption = find(e, (c) => c.tagName === "caption");
    const visit = (n: Node, inHead: boolean) => {
      for (const c of children(n)) {
        if (!isElement(c)) continue;
        if (c.tagName === "thead") visit(c, true);
        else if (c.tagName === "tbody" || c.tagName === "tfoot") visit(c, false);
        else if (c.tagName === "tr") {
          const cells = children(c)
            .filter((x): x is Element => isElement(x) && (x.tagName === "td" || x.tagName === "th"))
            .map((x) => this.blocks(x).join(" ").replace(/\|/g, "\\|").replace(/\n+/g, " ").trim());
          if (inHead && !header) header = cells;
          else rows.push(cells);
        }
      }
    };
    visit(e, false);
    if (!header) header = rows.shift() ?? [];
    const width = Math.max(header.length, ...rows.map((r) => r.length));
    const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")];
    const fmt = (r: string[]) => `| ${pad(r).join(" | ")} |`;
    const table = [fmt(header), `| ${Array(width).fill("---").join(" | ")} |`, ...rows.map(fmt)].join("\n");
    return caption ? `${this.line(caption)}\n\n${table}` : table;
  }
}

/** The Markdown for a page's content: its <main>, or its .docs__content column on documentation pages. */
export function htmlToMarkdown(document: string, opts: MarkdownOptions): string {
  const doc = parse(document);
  const main = find(doc, (e) => e.tagName === "main");
  if (!main) throw new Error(`no <main> in ${opts.url}`);
  const root = find(main, (e) => hasClass(e, "docs__content")) ?? main;
  const c = new Converter(opts.url);
  return `${c.blocks(root).join("\n\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}
