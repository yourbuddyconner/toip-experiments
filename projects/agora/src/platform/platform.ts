/**
 * Agora in one process (design §6.2): the TSP relay, three demo issuers with their groups, the
 * registrars' public reads, the forum host, a dev clock every component shares, and the web app on
 * its own origin. The web app is served with COOP and COEP, so the prover in its Web Worker gets
 * threads. The host and the registrar answer CORS for it.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { startRelay, type Relay } from "@zk-toip/relay";
import { DevClock, listen } from "./net";
import { startWorld, type World } from "./world";

export const WEB_DIR = join(import.meta.dirname, "..", "..", "web");

export interface PlatformOptions {
  /** The web app. 0 picks a free port. */
  webPort?: number;
  hostPort?: number;
  registrarPort?: number;
  relayPort?: number;
  /** "dev": Vite with hot reload. "static": web/dist (npm run build:web). "none": no web app. */
  web?: "dev" | "static" | "none";
  dataDir?: string;
  simulated?: number;
  log?: (line: string) => void;
}

export interface Platform {
  appUrl: string;
  hostUrl: string;
  registrarUrl: string;
  relayUrl: string;
  world: World;
  relay: Relay;
  clock: DevClock;
  dataDir: string;
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
  ".json": "application/json",
};

/** The web app's own headers: cross-origin isolation for the prover's threads, and a strict CSP. */
const ISOLATION = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
  "cross-origin-resource-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export async function startPlatform(opts: PlatformOptions = {}): Promise<Platform> {
  const log = opts.log ?? (() => {});
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), "agora-"));
  mkdirSync(dataDir, { recursive: true });
  const clockFile = join(dataDir, "clock.json");
  const clock = new DevClock(existsSync(clockFile) ? Number(JSON.parse(readFileSync(clockFile, "utf8")).offsetMs) || 0 : 0);
  clock.subscribe(() => writeFileSync(clockFile, JSON.stringify({ offsetMs: clock.offsetMs })));

  const relay = await startRelay({ port: opts.relayPort ?? 0, host: "127.0.0.1", dbPath: join(dataDir, "relay.db") });
  const world = await startWorld({
    clock,
    tsp: { relayUrl: relay.url },
    dataDir,
    hostPort: opts.hostPort,
    registrarPort: opts.registrarPort,
    devClock: true,
    simulated: opts.simulated,
    log,
  });

  const config = () => ({
    hostUrl: world.hostServer.url,
    registrarUrl: world.registrarServer.url,
    relayUrl: relay.url,
    host: { did: world.host.identity.did, aid: world.host.aid },
    issuers: world.issuers.map((i) => i.info()),
  });

  let vite: { middlewares: (req: IncomingMessage, res: ServerResponse, next: () => void) => void; close(): Promise<void> } | undefined;
  const distDir = join(WEB_DIR, "dist");
  if (opts.web === "dev" || opts.web === undefined) {
    const { createServer } = await import("vite");
    vite = await createServer({ root: WEB_DIR, configFile: join(WEB_DIR, "vite.config.ts"), appType: "spa", server: { middlewareMode: true, hmr: false }, logLevel: "error" });
  } else if (opts.web === "static" && !existsSync(join(distDir, "index.html"))) {
    throw new Error("the web app isn't built: run `npm run build:web --workspace @zk-toip/agora`");
  }

  const serveStatic = (req: IncomingMessage, res: ServerResponse) => {
    const path = normalize(decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(distDir, path);
    if (!file.startsWith(distDir) || !existsSync(file) || statSync(file).isDirectory()) file = join(distDir, "index.html");
    const cache = file.includes(`${join(distDir, "assets")}`) ? "public, max-age=31536000, immutable" : "no-cache";
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": cache }).end(readFileSync(file));
  };

  let web: Awaited<ReturnType<typeof listen>> | undefined;
  if (opts.web !== "none") {
    web = await listen(
      (req, res) => {
        for (const [k, v] of Object.entries(ISOLATION)) res.setHeader(k, v);
        const path = new URL(req.url ?? "/", "http://x").pathname;
        if (path === "/config.json") {
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(config()));
          return;
        }
        if (vite) return vite.middlewares(req, res, () => res.writeHead(404).end());
        serveStatic(req, res);
      },
      opts.webPort ?? 0,
      "localhost",
    );
  }

  return {
    // Passkeys need a domain: the app is used at http://localhost, which listen() answers on 127.0.0.1 and ::1.
    appUrl: web ? `http://localhost:${web.port}` : "",
    hostUrl: world.hostServer.url,
    registrarUrl: world.registrarServer.url,
    relayUrl: relay.url,
    world,
    relay,
    clock,
    dataDir,
    close: async () => {
      await web?.close();
      await vite?.close();
      await world.close();
      await relay.close();
    },
  };
}
