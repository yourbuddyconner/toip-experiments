/**
 * The visualizer's server: runs an act on the simulator when asked (GET /api/act/1?loss=0.2&seed=3)
 * and returns its Trace, which the web app plays back. It serves the web app too: through Vite while
 * developing, or the built files in web/dist.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { ACTS } from "./acts";
import type { Trace } from "./trace";

export const WEB_DIR = join(import.meta.dirname, "..", "web");

export interface AppOptions {
  /** 0 picks a free port. */
  port?: number;
  /** Default 127.0.0.1, answered on [::1] too, so http://localhost works. */
  host?: string;
  web?: "dev" | "static" | "none";
  log?: (line: string) => void;
}

export interface App {
  url: string;
  appUrl: string;
  port: number;
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
  ".json": "application/json",
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function startApp(opts: AppOptions = {}): Promise<App> {
  const log = opts.log ?? (() => {});
  const host = opts.host ?? "127.0.0.1";
  const loopbackOnly = host === "127.0.0.1" || host === "::1" || host === "localhost";
  // One act at a time: each starts its own relay and runs in a burst.
  let queue: Promise<unknown> = Promise.resolve();
  const runAct = (n: 1 | 2 | 3, loss: number, seed: number): Promise<Trace> => {
    const run = queue.then(() => ACTS[n]({ loss, seed }));
    queue = run.catch(() => {});
    return run;
  };

  async function api(req: IncomingMessage, url: URL): Promise<unknown> {
    if (req.method !== "GET") throw new HttpError(405, "use GET");
    if (url.pathname === "/api/health") return { ok: true };
    const m = /^\/api\/act\/([123])$/.exec(url.pathname);
    if (!m) throw new HttpError(404, "no such endpoint");
    const loss = Number(url.searchParams.get("loss") ?? "0");
    const seed = Number(url.searchParams.get("seed") ?? "1");
    if (!(loss >= 0 && loss <= 0.9)) throw new HttpError(400, "loss must be between 0 and 0.9");
    if (!Number.isInteger(seed) || seed < 0 || seed > 2 ** 31) throw new HttpError(400, "seed must be a whole number");
    const t0 = Date.now();
    const trace = await runAct(Number(m[1]) as 1 | 2 | 3, loss, seed);
    log(`act ${m[1]} at ${Math.round(loss * 100)}% loss, seed ${seed}: ${trace.summary.ok ? "ok" : "FAILED"} in ${Date.now() - t0} ms`);
    return trace;
  }

  let vite: { middlewares: (req: IncomingMessage, res: ServerResponse, next: () => void) => void; close(): Promise<void> } | undefined;
  const distDir = join(WEB_DIR, "dist");
  function serveStatic(req: IncomingMessage, res: ServerResponse): void {
    const path = normalize(decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(distDir, path);
    if (!file.startsWith(distDir) || !existsSync(file) || statSync(file).isDirectory()) file = join(distDir, "index.html");
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  }

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname.startsWith("/api/")) {
      try {
        const out = await api(req, url);
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(out));
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 500;
        if (status === 500) log(`error on ${url.pathname}: ${String((e as Error)?.stack ?? e)}`);
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: String((e as Error)?.message ?? e) }));
      }
      return;
    }
    if (vite) return vite.middlewares(req, res, () => res.writeHead(404).end());
    if (opts.web === "static") return serveStatic(req, res);
    res.writeHead(404).end("no web app here");
  });

  if (opts.web === "dev") {
    const { createServer: createVite } = await import("vite");
    vite = await createVite({ root: WEB_DIR, configFile: join(WEB_DIR, "vite.config.ts"), appType: "spa", server: { middlewareMode: true, hmr: { server } }, logLevel: "warn" });
  } else if (opts.web === "static" && !existsSync(join(distDir, "index.html"))) {
    throw new Error("the web app isn't built: run `npm run build:web --workspace @zk-toip/mesh`");
  }
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(opts.port ?? 0, host, () => resolve()));
  const port = (server.address() as { port: number }).port;
  // "localhost" can mean ::1 as well as 127.0.0.1: answer on both, so it never reaches another server.
  let server6: Server | undefined;
  if (loopbackOnly && host !== "::1") {
    const s6 = createServer((req, res) => server.emit("request", req, res));
    s6.on("upgrade", (...a) => server.emit("upgrade", ...a));
    const ok = await new Promise<boolean>((resolve) => s6.once("error", () => resolve(false)).listen(port, "::1", () => resolve(true)));
    if (ok) server6 = s6;
    else log(`couldn't also listen on [::1]:${port}; if http://localhost:${port} doesn't open, use http://127.0.0.1:${port}`);
  }
  return {
    url: `http://${host.includes(":") ? `[${host}]` : host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`,
    appUrl: loopbackOnly ? `http://localhost:${port}` : `http://${host}:${port}`,
    port,
    async close() {
      await vite?.close();
      for (const s of [server, server6]) {
        if (!s) continue;
        await new Promise<void>((resolve) => s.close(() => resolve()));
        s.closeAllConnections?.();
      }
      await queue.catch(() => {});
    },
  };
}
