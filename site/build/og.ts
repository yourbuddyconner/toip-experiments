// Social images (Open Graph and Twitter cards): one 1200 x 630 PNG per page, drawn from an HTML template
// in the site's own type and colors and screenshotted with Playwright's Chromium. Images are cached by
// content in site/.cache/og/, so a rebuild only draws pages whose title or text changed.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { SITE_DIR } from "./config";
import { fingerprintSvg } from "./fingerprint";

export interface OgJob {
  /** Where to write the PNG. */
  file: string;
  title: string;
  eyebrow: string;
  description: string;
  footer: string;
  mono: boolean;
}

const CACHE = join(SITE_DIR, ".cache", "og");
const WIDTH = 1200;
const HEIGHT = 630;

function template(): string {
  const font = pathToFileURL(join(SITE_DIR, "node_modules/@fontsource-variable/recursive/files/recursive-latin-mono-normal.woff2")).href;
  const mark = fingerprintSvg("toip.tools", { cell: 9 }).value;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: "Recursive"; src: url("${font}") format("woff2-variations"); font-weight: 300 1000; }
* { box-sizing: border-box; margin: 0; }
html, body { width: ${WIDTH}px; height: ${HEIGHT}px; }
body { background: #f7f3eb; color: #1e372f; font-family: "Recursive", sans-serif; font-variation-settings: "MONO" 0; display: flex; flex-direction: column; overflow: hidden; }
.top { display: flex; justify-content: space-between; align-items: center; padding: 56px 72px 0; }
.mark { display: flex; align-items: center; gap: 18px; font-size: 34px; font-weight: 800; font-variation-settings: "MONO" 1; letter-spacing: -0.01em; }
.eyebrow { font-size: 22px; font-weight: 650; letter-spacing: 0.08em; text-transform: uppercase; color: #b4462b; font-variation-settings: "MONO" 1; border: 2px solid #d5cec0; border-radius: 6px; padding: 8px 16px; background: #fffdf8; }
.main { flex: 1; display: flex; flex-direction: column; justify-content: center; padding: 0 72px; gap: 22px; }
h1 { font-weight: 720; letter-spacing: -0.035em; line-height: 1.08; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
h1.mono { font-variation-settings: "MONO" 1; letter-spacing: -0.02em; font-weight: 700; }
p { font-size: 28px; line-height: 1.4; color: #58635a; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; max-width: 1020px; }
.foot { height: 104px; background: #142c26; color: #e8eee4; display: flex; align-items: center; gap: 40px; padding: 0 72px; font-variation-settings: "MONO" 1; font-size: 25px; border-top: 6px solid #b4462b; }
.foot #footer { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.foot #footer.cmd::before { content: "$ "; color: #aebeb1; }
.foot .site { flex: none; color: #aebeb1; font-size: 22px; }
</style></head><body>
<div class="top"><div class="mark">${mark}<span>toip.tools</span></div><div class="eyebrow" id="eyebrow"></div></div>
<div class="main"><h1 id="title"></h1><p id="desc"></p></div>
<div class="foot"><span id="footer"></span><span class="site">TypeScript</span></div>
</body></html>`;
}

function titleSize(title: string, mono: boolean): number {
  const n = title.length * (mono ? 1.15 : 1);
  return n <= 22 ? 92 : n <= 36 ? 80 : n <= 56 ? 66 : n <= 80 ? 56 : 48;
}

/** Draws every image that isn't cached yet, four at a time. */
export async function renderOgImages(jobs: OgJob[]): Promise<{ drawn: number; cached: number }> {
  mkdirSync(CACHE, { recursive: true });
  const tpl = template();
  const version = createHash("sha256").update(tpl).update(titleSize.toString()).digest("hex").slice(0, 12);
  const keyed = jobs.map((j) => ({ ...j, key: createHash("sha256").update(JSON.stringify([version, j.title, j.eyebrow, j.description, j.footer, j.mono])).digest("hex").slice(0, 32) }));
  const todo = keyed.filter((j) => !existsSync(join(CACHE, `${j.key}.png`)));
  if (todo.length) {
    const tplFile = join(CACHE, `template-${version}.html`);
    writeFileSync(tplFile, tpl);
    const browser = await chromium.launch();
    try {
      const ctx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
      const queue = [...new Map(todo.map((j) => [j.key, j])).values()];
      await Promise.all(
        Array.from({ length: Math.min(4, queue.length) }, async () => {
          const page = await ctx.newPage();
          await page.goto(pathToFileURL(tplFile).href);
          for (let j = queue.shift(); j; j = queue.shift()) {
            await page.evaluate(
              ({ title, eyebrow, description, footer, mono, size }) => {
                const t = document.getElementById("title")!;
                t.textContent = title;
                t.className = mono ? "mono" : "";
                t.style.fontSize = `${size}px`;
                document.getElementById("eyebrow")!.textContent = eyebrow;
                document.getElementById("desc")!.textContent = description;
                const f = document.getElementById("footer")!;
                f.textContent = footer;
                f.className = /^(npm|npx|curl|git) /.test(footer) ? "cmd" : "";
                return document.fonts.ready.then(() => undefined);
              },
              { title: j.title, eyebrow: j.eyebrow, description: j.description, footer: j.footer, mono: j.mono, size: titleSize(j.title, j.mono) },
            );
            await page.screenshot({ path: join(CACHE, `${j.key}.png`), type: "png" });
          }
          await page.close();
        }),
      );
    } finally {
      await browser.close();
    }
  }
  for (const j of keyed) {
    mkdirSync(dirname(j.file), { recursive: true });
    copyFileSync(join(CACHE, `${j.key}.png`), j.file);
  }
  return { drawn: new Set(todo.map((j) => j.key)).size, cached: keyed.length - todo.length };
}

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || sig.some((b, i) => bytes[i] !== b)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR") return undefined;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
