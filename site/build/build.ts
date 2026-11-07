// Builds the static site into dist/. Usage: npm run build (SITE_BASE=/ for the custom domain).
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BASE, OUT_DIR, SITE_DIR, u } from "./config";
import { fingerprintSvg } from "./fingerprint";
import { sealSample } from "./hero";
import { loadSpecs, warnings } from "./specs";
import { layout, type Page } from "../src/layout";
import { homePage } from "../src/pages/home";
import { quickstartPage } from "../src/pages/quickstart";
import { conceptsPage } from "../src/pages/concepts";
import { toolkitPages } from "../src/pages/toolkit";
import { examplesPage } from "../src/pages/examples";
import { specPages } from "../src/pages/spec";
import { involvedPage } from "../src/pages/involved";
import { notFoundPage } from "../src/pages/notfound";

const t0 = Date.now();
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

// Static files.
cpSync(join(SITE_DIR, "public"), OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, ".nojekyll"), "");
const fontDir = join(SITE_DIR, "node_modules/@fontsource-variable/recursive/files");
mkdirSync(join(OUT_DIR, "fonts"), { recursive: true });
for (const sub of ["latin", "latin-ext"]) cpSync(join(fontDir, `recursive-${sub}-mono-normal.woff2`), join(OUT_DIR, "fonts", `recursive-${sub}-mono.woff2`));
cpSync(join(SITE_DIR, "node_modules/@fontsource-variable/recursive/LICENSE"), join(OUT_DIR, "fonts", "LICENSE.txt"));

const favicon = fingerprintSvg("toip.tools", { cell: 7 }).value.replace('aria-hidden="true" focusable="false"', 'xmlns="http://www.w3.org/2000/svg"');
writeFileSync(join(OUT_DIR, "favicon.svg"), favicon);

// Hashed CSS and JS.
function asset(src: string, name: string, ext: string): string {
  const body = readFileSync(join(SITE_DIR, src));
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 10);
  const file = `${name}.${hash}.${ext}`;
  mkdirSync(join(OUT_DIR, "assets"), { recursive: true });
  writeFileSync(join(OUT_DIR, "assets", file), body);
  return u(`/assets/${file}`);
}
const cssHref = asset("src/styles/site.css", "site", "css");
const jsHref = asset("src/scripts/site.js", "site", "js");

// Pages.
const specs = loadSpecs();
const sample = await sealSample();
const pages: Page[] = [
  homePage(sample, specs.length),
  quickstartPage(),
  conceptsPage(),
  ...toolkitPages(),
  examplesPage(),
  ...specPages(specs),
  involvedPage(),
];

for (const p of pages) {
  const file = join(OUT_DIR, p.path, "index.html");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, layout(p, { cssHref, jsHref }));
}
writeFileSync(join(OUT_DIR, "404.html"), layout(notFoundPage(), { cssHref, jsHref }));

// The fonts are referenced from CSS as ../fonts/, relative to /assets/.
if (!existsSync(join(OUT_DIR, "fonts", "recursive-latin-mono.woff2"))) throw new Error("fonts missing");

for (const w of warnings) console.warn(`warning: ${w}`);
console.log(`built ${pages.length + 1} pages into dist/ with base ${BASE} in ${Date.now() - t0} ms`);
if (process.env.STRICT && warnings.length) process.exit(1);
