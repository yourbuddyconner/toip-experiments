/**
 * Renders video/explainer.html frame by frame (deterministic timing) and encodes it with ffmpeg.
 *
 *   npx tsx video/render-explainer.ts                         → video/out/explainer.mp4 (general audience)
 *   npx tsx video/render-explainer.ts --page explainer-dev    → video/out/explainer-dev.mp4 (ToIP developers)
 *   add --stills 3,10,20                                      → PNG stills, for checking layout
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const DIR = import.meta.dirname;
const FPS = 30;
const stillsArg = process.argv.indexOf("--stills");
const stills = stillsArg > 0 ? process.argv[stillsArg + 1].split(",").map(Number) : null;
const pageArg = process.argv.indexOf("--page");
const NAME = pageArg > 0 ? process.argv[pageArg + 1] : "explainer";

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on("console", (m) => m.type() === "error" && console.error("page:", m.text()));
await page.goto(pathToFileURL(join(DIR, `${NAME}.html`)).href);
await page.evaluate(() => (window as unknown as { ready: Promise<unknown> }).ready);
const total = await page.evaluate(() => (window as unknown as { TOTAL: number }).TOTAL);
const render = (t: number) => page.evaluate((x) => (window as unknown as { render: (t: number) => Promise<void> }).render(x), t);

if (stills) {
  for (const t of stills) {
    await render(t);
    await page.screenshot({ path: join(DIR, "out", `${NAME}-still-${t}.png`) });
  }
  console.log("stills written");
} else {
  const frames = Math.round(total * FPS);
  const ff = spawn("ffmpeg", ["-v", "error", "-y", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "medium", "-movflags", "+faststart", join(DIR, "out", `${NAME}.mp4`)], { stdio: ["pipe", "inherit", "inherit"] });
  for (let f = 0; f < frames; f++) {
    await render(f / FPS);
    const jpg = await page.screenshot({ type: "jpeg", quality: 92 });
    if (!ff.stdin.write(jpg)) await new Promise((r) => ff.stdin.once("drain", r));
    if (f % 150 === 0) console.log(`frame ${f}/${frames}`);
  }
  ff.stdin.end();
  await new Promise((r) => ff.on("close", r));
  console.log("wrote", join(DIR, "out", `${NAME}.mp4`));
}
await browser.close();
