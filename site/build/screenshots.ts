// Screenshots of the main pages at desktop (1440) and phone (390) widths, plus one with JavaScript off
// and one showing keyboard focus, into screenshots/. Build first.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { BASE, SITE_DIR } from "./config";
import { serve } from "./serve";

const PAGES: [string, string][] = [
  ["home", ""],
  ["quickstart", "quickstart/"],
  ["concepts", "concepts/"],
  ["toolkit", "toolkit/"],
  ["toolkit-trust-core", "toolkit/trust-core/"],
  ["toolkit-mesh-transport", "toolkit/mesh-transport/"],
  ["examples", "examples/"],
  ["spec", "spec/"],
  ["spec-settle-escrow-attest", "spec/settle/escrow/attest/0.1/"],
  ["get-involved", "get-involved/"],
  ["404", "no-such-page/"],
];

const only = process.argv.slice(2);
const out = join(SITE_DIR, "screenshots");
mkdirSync(out, { recursive: true });
const port = 4400 + Math.floor(Math.random() * 400);
const server = serve(port);
const root = `http://127.0.0.1:${port}${BASE}`;
const browser = await chromium.launch();

for (const [w, h, tag] of [
  [1440, 900, "desktop"],
  [390, 844, "phone"],
] as const) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: tag === "phone" ? 2 : 1, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  for (const [name, path] of PAGES) {
    if (only.length && !only.includes(name)) continue;
    await page.goto(root + path, { waitUntil: "networkidle" });
    await page.screenshot({ path: join(out, `${name}-${tag}.png`), fullPage: true });
  }
  await ctx.close();
}

// JavaScript off: the home page and the quickstart must read the same.
const nojs = await browser.newContext({ viewport: { width: 1440, height: 900 }, javaScriptEnabled: false });
const p2 = await nojs.newPage();
await p2.goto(root, { waitUntil: "networkidle" });
await p2.screenshot({ path: join(out, "home-nojs-desktop.png"), fullPage: true });
await p2.goto(root + "quickstart/", { waitUntil: "networkidle" });
await p2.screenshot({ path: join(out, "quickstart-nojs-desktop.png") });
await nojs.close();

// Keyboard focus: tab to the skip link, then into the navigation.
const kb = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const p3 = await kb.newPage();
await p3.goto(root, { waitUntil: "networkidle" });
await p3.keyboard.press("Tab");
await p3.screenshot({ path: join(out, "focus-skip.png") });
for (let i = 0; i < 3; i++) await p3.keyboard.press("Tab");
await p3.screenshot({ path: join(out, "focus-nav.png") });
await p3.goto(root + "quickstart/", { waitUntil: "networkidle" });
for (let i = 0; i < 12; i++) await p3.keyboard.press("Tab");
await p3.screenshot({ path: join(out, "focus-quickstart.png") });
await kb.close();

await browser.close();
server.close();
console.log(`screenshots in ${out}`);
