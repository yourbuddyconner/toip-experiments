// Syntax highlighting at build time with Shiki, in the site's own theme. The page ships no highlighter.
import { createHighlighter, type ThemeRegistrationRaw } from "shiki";
import { esc, html, raw, type Raw } from "./html";

const theme: ThemeRegistrationRaw = {
  name: "toip-ink",
  type: "dark",
  colors: { "editor.background": "#0f1d3a", "editor.foreground": "#dde6ef" },
  // The rules go under the TextMate `settings` key, which ThemeRegistrationRaw requires.
  settings: [
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#93a6bf", fontStyle: "" } },
    { scope: ["keyword", "storage", "storage.type", "keyword.control", "keyword.operator.new", "keyword.operator.expression"], settings: { foreground: "#b4c3ff" } },
    { scope: ["string", "string.quoted", "string.template", "punctuation.definition.string"], settings: { foreground: "#a8e2c6" } },
    { scope: ["constant.numeric", "constant.language", "support.constant"], settings: { foreground: "#f2c48d" } },
    { scope: ["entity.name.function", "support.function", "meta.function-call entity.name.function"], settings: { foreground: "#91d7f5" } },
    { scope: ["entity.name.type", "support.type", "entity.name.class", "support.class"], settings: { foreground: "#e5d3ff" } },
    { scope: ["variable.other.property", "meta.object-literal.key", "support.type.property-name"], settings: { foreground: "#cfdcea" } },
    { scope: ["variable.parameter"], settings: { foreground: "#e8eef5" } },
    { scope: ["punctuation", "meta.brace", "keyword.operator"], settings: { foreground: "#aebdd0" } },
  ],
};

const highlighter = await createHighlighter({ themes: [theme], langs: ["typescript", "bash", "json", "shellsession"] });

export type Lang = "ts" | "bash" | "json" | "text" | "console";

const LANG: Record<Lang, string> = { ts: "typescript", bash: "bash", json: "json", text: "text", console: "text" };
const LABEL: Record<Lang, string> = { ts: "TypeScript", bash: "Shell", json: "JSON", text: "Text", console: "Output" };

export function highlight(code: string, lang: Lang): string {
  const src = code.replace(/\n+$/, "");
  if (lang === "text" || lang === "console") return `<pre class="shiki" tabindex="0"><code>${esc(src)}</code></pre>`;
  return highlighter.codeToHtml(src, { lang: LANG[lang], theme: "toip-ink" }).replace("<pre ", '<pre tabindex="0" ');
}

/** A code block: a caption (file name or what it is), the code, and room for a copy button. */
export function code(src: string, lang: Lang = "ts", opts: { caption?: string | Raw; kind?: "output" | "code" } = {}): Raw {
  const kind = opts.kind ?? (lang === "console" ? "output" : "code");
  return html`<figure class="code code--${kind}" data-lang="${lang}">
<figcaption><span class="code__language">${LABEL[lang]}</span>${opts.caption ? html`<span class="code__title">${opts.caption}</span>` : ""}</figcaption>${raw(highlight(src, lang))}
</figure>`;
}
