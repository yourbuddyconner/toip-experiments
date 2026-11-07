/**
 * The Trail service: the witnesses (each on its own port, and also at /w/1 to /w/4 here), the watchers,
 * the explorer's API, and the explorer itself.
 *
 *   GET  /api/state       the demo's progress, actors, witnesses and display names
 *   GET  /api/bundle?aid  Ada's view of an AID: what her watcher holds, with the bodies disclosed to her
 *   GET  /api/evidence    duplicity evidence held by the watchers and witnesses
 *   GET  /api/samples     bundles for the Verify page (the clean review, the tampered copies, Mallory's)
 *   GET  /api/captures    the camera's signed photos
 *   POST /api/step {n}    runs demo step n (the next one)
 *   POST /api/reset       starts the demo over
 *   /w/<n>/...            witness n's HTTP API: POST submit, POST receipts, GET log/:id, GET head/:id, GET evidence, GET info
 *
 * It listens on this machine only. The demo actions have no authentication (design §14.2).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { evidenceToJson } from "@zk-toip/eventlog";
import { STEPS, runNext } from "./steps";
import { World } from "./world";

const WEB_DIR = fileURLToPath(new URL("../web", import.meta.url));
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".json": "application/json" };

export interface ServiceOptions {
  port?: number;
  host?: string;
  /** Ports for witnesses 1 to 4. */
  witnessPorts?: number[];
  /** Where to keep the data. Without it, everything is in memory. */
  dataDir?: string;
  /** How to serve the explorer: Vite with hot reload, the built files in web/dist, or not at all. */
  web?: "dev" | "static" | "none";
  log?: (line: string) => void;
}

export interface Service {
  /** The API's address. */
  url: string;
  /** The explorer, for people: http://localhost:<port> on this machine. */
  appUrl: string;
  world(): World;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export async function startService(opts: ServiceOptions = {}): Promise<Service> {
  const log = opts.log ?? (() => {});
  const host = opts.host ?? "127.0.0.1";
  const loopbackOnly = host === "127.0.0.1" || host === "::1" || host === "localhost";
  const openWorld = () => World.open({ dataDir: opts.dataDir, host, witnessPorts: opts.witnessPorts });
  let world = await openWorld();
  // one demo action at a time
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = queue.then(fn, fn);
    queue = p.catch(() => {});
    return p;
  };

  const state = () => ({
    progress: world.state.progress,
    steps: STEPS.map((s) => ({ n: s.n, title: s.title, redTeam: s.redTeam, summary: s.summary, done: s.n <= world.state.progress })),
    reports: world.state.reports,
    logs: world.logs(),
    witnesses: world.witnesses.map((w) => ({
      n: w.n,
      name: w.name,
      aid: w.aid,
      url: w.url,
      path: `/w/${w.n}`,
      rogue: w.rogue,
      inUse: world.state.scoutWitnesses.includes(w.n),
    })),
    ada: { did: world.ada.did },
    scout: world.state.scout ? { ...world.state.scout, did: world.scoutId.did } : null,
    policy: "Every tool call must cite the mandate it runs under (entry 1).",
    keripy: world.state.keripy ?? null,
    names: world.names(),
  });

  const routes: Record<string, (req: IncomingMessage, url: URL) => Promise<unknown>> = {
    "GET /api/state": async () => state(),
    "GET /api/bundle": async (_req, url) => {
      const aid = url.searchParams.get("aid") ?? "";
      if (!world.logs().some((l) => l.aid === aid)) throw new HttpError(404, "no such identifier");
      return { bundle: await world.adaBundle(aid) };
    },
    "GET /api/evidence": async () => (await world.evidence()).map((x) => ({ holder: x.holder, evidence: evidenceToJson(x.evidence) })),
    "GET /api/samples": async () => world.state.samples,
    "GET /api/captures": async () => ({ captures: world.state.captures, camera: world.state.camera ?? null }),
    "POST /api/step": async (req) => {
      const b = JSON.parse((await readBody(req)).toString() || "{}") as { n?: number };
      return serial(async () => {
        try {
          const report = await runNext(world, typeof b.n === "number" ? b.n : undefined);
          log(`step ${report.n}: ${report.title}`);
          return { report, state: state() };
        } catch (e) {
          throw new HttpError(409, (e as Error).message);
        }
      });
    },
    "POST /api/reset": async () =>
      serial(async () => {
        await world.close();
        if (opts.dataDir) rmSync(opts.dataDir, { recursive: true, force: true });
        world = await openWorld();
        log("the demo was reset");
        return state();
      }),
  };

  // ---------------------------------------------------------------- the explorer
  let vite: { middlewares: (req: IncomingMessage, res: ServerResponse, next: () => void) => void; close(): Promise<void> } | undefined;
  const distDir = join(WEB_DIR, "dist");
  function serveStatic(req: IncomingMessage, res: ServerResponse): void {
    const path = normalize(decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(distDir, path);
    if (!file.startsWith(distDir) || !existsSync(file) || statSync(file).isDirectory()) file = join(distDir, "index.html");
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  }

  async function witnessRoute(req: IncomingMessage, res: ServerResponse, n: number, rest: string): Promise<void> {
    const w = world.witnesses[n - 1];
    if (!w) {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "no such witness" }));
      return;
    }
    const body = req.method === "POST" ? await readBody(req) : undefined;
    const r = await w.handler(new Request(`http://${host}/${rest}`, { method: req.method, ...(body ? { body: new Uint8Array(body) } : {}) }));
    res.writeHead(r.status, { ...Object.fromEntries(r.headers), "cache-control": "no-store" }).end(Buffer.from(await r.arrayBuffer()));
  }

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const wm = /^\/w\/(\d)\/(.*)$/.exec(url.pathname);
    if (wm) {
      try {
        await witnessRoute(req, res, Number(wm[1]), wm[2] + url.search);
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: String((e as Error)?.message ?? e) }));
      }
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      try {
        const route = routes[`${req.method} ${url.pathname}`];
        if (!route) throw new HttpError(404, "no such endpoint");
        if (req.method === "POST") {
          // No cross-site requests: a form on another site can't send JSON, and a script there sends its Origin.
          if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "send JSON");
          const origin = req.headers.origin;
          let sameSite = false;
          try {
            sameSite = new URL(String(origin)).host === req.headers.host;
          } catch {
            sameSite = false;
          }
          if (origin && !sameSite) throw new HttpError(403, "cross-site request refused");
        }
        const out = await route(req, url);
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
    res.writeHead(404, { "content-type": "text/plain" }).end("the explorer isn't served here");
  });

  if (opts.web === "dev") {
    const { createServer: createVite } = await import("vite");
    vite = await createVite({ root: WEB_DIR, configFile: join(WEB_DIR, "vite.config.ts"), appType: "spa", server: { middlewareMode: true, hmr: { server } }, logLevel: "warn" });
  } else if (opts.web === "static" && !existsSync(join(distDir, "index.html"))) {
    throw new Error("the explorer isn't built: run `npm run build:web --workspace @zk-toip/trail`");
  }
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(opts.port ?? 0, host, () => resolve()));
  const port = (server.address() as { port: number }).port;
  // "localhost" can mean ::1 as well as 127.0.0.1 on this machine: answer on both, so it never reaches another server.
  let server6: Server | undefined;
  if (loopbackOnly && host !== "::1") {
    const s6 = createServer((req, res) => server.emit("request", req, res));
    s6.on("upgrade", (...a) => server.emit("upgrade", ...a));
    const ok = await new Promise<boolean>((resolve) => s6.once("error", () => resolve(false)).listen(port, "::1", () => resolve(true)));
    if (ok) server6 = s6;
    else log(`couldn't also listen on [::1]:${port}; if http://localhost:${port} doesn't open Trail, use http://127.0.0.1:${port}`);
  }
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
  return {
    url,
    appUrl: loopbackOnly ? `http://localhost:${port}` : url,
    world: () => world,
    close: async () => {
      await queue;
      await vite?.close();
      for (const s of [server, server6]) {
        if (!s) continue;
        await new Promise<void>((resolve) => s.close(() => resolve()));
        s.closeAllConnections?.();
      }
      await world.close();
    },
  };
}
