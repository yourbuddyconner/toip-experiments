// Serves dist/ under the base path, as GitHub Pages would. --watch rebuilds when sources change.
// PORT (default 4321).
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, watch } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { BASE, OUT_DIR, SITE_DIR } from "./config";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
};

function build(): Promise<void> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--import", "tsx", join(SITE_DIR, "build/build.ts")], { cwd: SITE_DIR, stdio: "inherit" });
    p.on("exit", () => resolve());
  });
}

export function serve(port: number) {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    let path = decodeURIComponent(url.pathname);
    if (!path.startsWith(BASE)) {
      res.writeHead(302, { location: BASE });
      return res.end();
    }
    path = normalize(path.slice(BASE.length - 1));
    let file = join(OUT_DIR, path);
    if (!file.startsWith(OUT_DIR)) {
      res.writeHead(400);
      return res.end();
    }
    if (existsSync(file) && statSync(file).isDirectory()) {
      if (!path.endsWith("/")) {
        res.writeHead(301, { location: `${url.pathname}/` });
        return res.end();
      }
      file = join(file, "index.html");
    }
    if (!existsSync(file)) {
      res.writeHead(404, { "content-type": TYPES[".html"] });
      return res.end(readFileSync(join(OUT_DIR, "404.html")));
    }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  }).listen(port, "127.0.0.1");
}

if (process.argv[1]?.endsWith("serve.ts")) {
  const port = Number(process.env.PORT ?? 4321);
  if (!existsSync(OUT_DIR) || process.argv.includes("--watch")) await build();
  serve(port);
  console.log(`serving dist/ at http://localhost:${port}${BASE}`);
  if (process.argv.includes("--watch")) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    for (const dir of ["src", "build", "examples", "public"]) {
      watch(join(SITE_DIR, dir), { recursive: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(build, 150);
      });
    }
  }
}
