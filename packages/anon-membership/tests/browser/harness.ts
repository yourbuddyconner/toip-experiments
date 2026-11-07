// Builds tests/browser with Vite, serves it cross-origin isolated on port 0, and runs it in Chromium,
// recording every request the page and its workers make.
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium } from "playwright";

const here = fileURLToPath(new URL(".", import.meta.url));

export function chromiumAvailable(): boolean {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

export async function buildPage(): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), "anon-membership-browser-"));
  await build({
    root: here,
    logLevel: "error",
    configFile: false,
    build: { outDir, emptyOutDir: true, target: "esnext", chunkSizeWarningLimit: 100_000 },
    worker: { format: "es" },
  });
  return outDir;
}

const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".gz": "application/gzip" };

export function servePage(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    let p = normalize(decodeURIComponent((req.url ?? "/").split("?")[0]));
    if (p.endsWith("/")) p += "index.html";
    const f = join(dir, p);
    if (!f.startsWith(dir) || !existsSync(f) || !statSync(f).isFile()) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[extname(f)] ?? "application/octet-stream" });
    res.end(readFileSync(f));
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => new Promise((r) => server.close(() => r())) });
    }),
  );
}

export async function runInChromium(url: string, timeoutMs = 120_000): Promise<{ result: Record<string, unknown>; requests: string[]; blocked: string[] }> {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const requests: string[] = [];
    const blocked: string[] = [];
    const origin = new URL(url).origin;
    // Every request from the page and its workers: our origin passes, anything else is blocked and recorded.
    await context.route("**/*", (route) => {
      const u = route.request().url();
      requests.push(u);
      if (u.startsWith(origin + "/")) return route.continue();
      blocked.push(u);
      return route.abort();
    });
    context.on("request", (r) => {
      if (!requests.includes(r.url())) requests.push(r.url());
    });
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => (window as unknown as { __result?: unknown }).__result !== undefined, null, { timeout: timeoutMs });
    const result = (await page.evaluate(() => (window as unknown as { __result: unknown }).__result)) as Record<string, unknown>;
    return { result, requests, blocked };
  } finally {
    await browser.close();
  }
}
