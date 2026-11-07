/**
 * The whole Tipline demo in one process (design §5.2). Each party is its own web origin, so no app
 * can read another's storage:
 *
 *   outlet  The Ledger's site: the source app at /tip/<drop box>, descriptors, the mirror of Acme's log.
 *   inbox   Sam's inbox. It runs in Sam's browser; this server only serves the page and a directory.
 *   acme    Acme Chemicals: the HR console, the group's root log and snapshots, and the relay panel
 *           (Acme operates the relay in the demo). Acme's issuer answers anon-membership/enroll over TSP.
 *   wallet  An employee's own wallet page.
 *   relay   packages/relay.
 *
 * A dev clock (Skip ahead) moves every party's time, so epochs and windows can be shown.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { epochOf, initHashing, type GroupRoot } from "@zk-toip/anon-membership";
import { startRelay, type Relay, type StoredMessage } from "@zk-toip/relay";
import { Endpoint, RelayTransport, identityFromSeed, toB64u, type Clock } from "@zk-toip/trust-core";
import { OrgIssuer, type OrgIssuerState } from "../agents/issuer";
import { Mirror } from "../agents/mirror";
import { verifyDescriptor, type Descriptor } from "../protocol/descriptor";
import { FRESHNESS } from "../protocol/messages";

export const WEB_DIR = join(import.meta.dirname, "..", "..", "web");
const DIST = join(WEB_DIR, "dist");

/** A clock that keeps real time plus an offset the demo moves forward. */
export class DevClock implements Clock {
  constructor(public offsetMs = 0) {}
  now(): number {
    return Date.now() + this.offsetMs;
  }
  iso(): string {
    return new Date(this.now()).toISOString();
  }
  date(): Date {
    return new Date(this.now());
  }
}

export interface Ports {
  outlet: number;
  inbox: number;
  acme: number;
  wallet: number;
  relay: number;
}

export interface PlatformOptions {
  /** 0 picks a free port. */
  ports?: Partial<Ports>;
  /** Where the platform keeps its state between runs. Default: a fresh temporary directory. */
  dataDir?: string;
  /** Serve the built web apps (web/dist), or only the APIs. */
  web?: "static" | "none";
  /** Seeded employees enrolled from throwaway wallets, so the group is realistically large. Default 58. */
  seed?: number;
  /** How often the outlet's mirror refreshes from Acme. Default 2 s (the design says hourly). */
  mirrorRefreshMs?: number;
  log?: (line: string) => void;
}

export interface Platform {
  urls: { outlet: string; inbox: string; acme: string; wallet: string; relay: string };
  acme: OrgIssuer;
  mirror: Mirror;
  clock: DevClock;
  relay: Relay;
  dataDir: string;
  /** Moves the dev clock forward; Acme publishes each day's root on the way. */
  advanceDays(days: number): Promise<void>;
  close(): Promise<void>;
}

interface Saved {
  v: 1;
  acmeSeed: string;
  clockOffsetMs: number;
  acme: OrgIssuerState;
  descriptors: Record<string, Descriptor>;
}

const ORG = "Acme Chemicals";
const GROUP_NAME = "employees";
const GROUP_LABEL = "Acme Chemicals employees";
const MIRROR_SLUG = "acme-employees";
const MAX_BODY = 512 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "request too large");
    chunks.push(c as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!v || typeof v !== "object") throw new Error();
    return v;
  } catch {
    throw new HttpError(400, "expected a JSON object");
  }
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
  ".gz": "application/gzip",
};

/** Every page is cross-origin isolated, so bb.js can use threads. */
const ISOLATED = { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp", "cross-origin-resource-policy": "same-origin" };
/** Public data other origins fetch: logs, snapshots, descriptors. */
const PUBLIC = { "access-control-allow-origin": "*", "cross-origin-resource-policy": "cross-origin", "cache-control": "no-store" };

type Route = (req: IncomingMessage, m: RegExpExecArray) => Promise<unknown>;
interface Site {
  name: string;
  page: string;
  /** Method, path, handler, and whether other origins may POST to it (signed documents only). */
  routes: [string, RegExp, Route, "cors"?][];
  /** Extra headers for the HTML page (the source app's Content-Security-Policy). */
  pageHeaders?: () => Record<string, string>;
}

function json(res: ServerResponse, status: number, v: unknown, extra: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extra }).end(JSON.stringify(v));
}

function serveFile(res: ServerResponse, file: string, headers: Record<string, string>) {
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", ...ISOLATED, ...headers }).end(readFileSync(file));
}

function handler(site: Site, web: boolean, log: (l: string) => void) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    for (const [method, re, route, cors] of site.routes) {
      const m = re.exec(url.pathname);
      if (m && req.method === "OPTIONS" && cors) {
        return void res.writeHead(204, { ...PUBLIC, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type", "access-control-max-age": "600" }).end();
      }
      if (!m || req.method !== method) continue;
      try {
        if (method === "POST" && cors) {
          if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "send JSON");
        } else if (method === "POST") {
          if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "send JSON");
          const origin = req.headers.origin;
          if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, "cross-site request refused");
        }
        const out = await route(req, m);
        if (out instanceof Uint8Array) {
          res.writeHead(200, { "content-type": "application/octet-stream", ...PUBLIC }).end(out);
        } else if (out && typeof out === "object" && "__public" in out) {
          json(res, 200, (out as { __public: unknown }).__public, PUBLIC);
        } else json(res, 200, out ?? { ok: true }, cors ? PUBLIC : {});
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 500;
        if (status === 500) log(`${site.name}: error on ${url.pathname}: ${String((e as Error)?.stack ?? e)}`);
        json(res, status, { error: String((e as Error)?.message ?? e) }, url.pathname.startsWith("/api/") ? {} : PUBLIC);
      }
      return;
    }
    if (req.method === "OPTIONS") return void res.writeHead(204, { ...PUBLIC, "access-control-allow-methods": "GET" }).end();
    if (!web || req.method !== "GET") return json(res, 404, { error: "not found" });
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/dropbox/") || url.pathname.startsWith("/groups/")) return json(res, 404, { error: "not found" });
    const path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    const file = join(DIST, path);
    if (file.startsWith(DIST) && !path.endsWith(".html") && existsSync(file) && statSync(file).isFile()) return serveFile(res, file, { "cache-control": "no-cache" });
    serveFile(res, join(DIST, site.page), { "cache-control": "no-store", ...(site.pageHeaders?.() ?? {}) });
  };
}

/** Listens on 127.0.0.1 and, so http://localhost works for passkeys, on ::1 too (as Settle does). */
async function listen(port: number, h: (req: IncomingMessage, res: ServerResponse) => void, log: (l: string) => void): Promise<{ port: number; close: () => Promise<void> }> {
  const s4 = createServer(h);
  await new Promise<void>((resolve, reject) => s4.once("error", reject).listen(port, "127.0.0.1", () => resolve()));
  const actual = (s4.address() as { port: number }).port;
  const s6 = createServer(h);
  const ok6 = await new Promise<boolean>((resolve) => s6.once("error", () => resolve(false)).listen(actual, "::1", () => resolve(true)));
  if (!ok6) log(`couldn't also listen on [::1]:${actual}; if http://localhost:${actual} fails, use http://127.0.0.1:${actual}`);
  const servers: Server[] = ok6 ? [s4, s6] : [s4];
  return {
    port: actual,
    close: async () => {
      for (const s of servers) {
        s.closeAllConnections?.();
        await new Promise<void>((r) => s.close(() => r()));
      }
    },
  };
}

/** The forms a value takes in stored data: as given, hex without 0x, and base64url of the bytes. */
function forms(q: string): string[] {
  const out = new Set([q]);
  const hex = q.startsWith("0x") ? q.slice(2) : /^[0-9a-f]{64}$/i.test(q) ? q : null;
  if (hex && /^[0-9a-f]+$/i.test(hex) && hex.length % 2 === 0) {
    out.add(hex.toLowerCase());
    out.add(toB64u(Uint8Array.from(Buffer.from(hex, "hex"))));
  }
  return [...out].filter((s) => s.length >= 16);
}

export async function startPlatform(opts: PlatformOptions = {}): Promise<Platform> {
  const log = opts.log ?? (() => {});
  const web = (opts.web ?? "static") === "static";
  if (web && !existsSync(join(DIST, "source.html"))) throw new Error("the web apps aren't built: run `npm run build:web --workspace @zk-toip/tipline`");
  await initHashing();
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), "tipline-"));
  mkdirSync(dataDir, { recursive: true });
  const statePath = join(dataDir, "state.json");
  const saved: Saved | null = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;
  const clock = new DevClock(saved?.clockOffsetMs ?? 0);
  const acmeSeed = saved ? Uint8Array.from(Buffer.from(saved.acmeSeed, "hex")) : new Uint8Array(randomBytes(32));
  const acmeId = identityFromSeed(acmeSeed);
  const acme = new OrgIssuer({ identity: acmeId, clock, org: ORG, name: GROUP_NAME, state: saved?.acme });
  if (!saved) acme.seed(opts.seed ?? 58);
  const descriptors = new Map<string, Descriptor>(Object.entries(saved?.descriptors ?? {}));
  const save = () => {
    const s: Saved = { v: 1, acmeSeed: Buffer.from(acmeSeed).toString("hex"), clockOffsetMs: clock.offsetMs, acme: acme.state(), descriptors: Object.fromEntries(descriptors) };
    writeFileSync(statePath, JSON.stringify(s));
  };
  save();

  // ── The relay, operated by Acme in the demo ─────────────────────────
  const ports: Ports = { outlet: 4310, inbox: 4311, acme: 4312, wallet: 4313, relay: 4314, ...opts.ports };
  const stored: StoredMessage[] = [];
  const relayDb = join(dataDir, "relay.db");
  const relay = await startRelay({
    port: ports.relay,
    host: "127.0.0.1",
    dbPath: relayDb,
    publicUrl: undefined,
    onStored: (m) => {
      stored.push(m);
      if (stored.length > 2000) stored.splice(0, stored.length - 2000);
    },
  });
  // Clients sign the relay URL when they authenticate, so everyone uses the relay's own.
  const relayUrl = relay.url;

  // ── Acme's issuer, answering enroll over TSP ─────────────────────────
  const acmeTransport = new RelayTransport({ url: relay.url, identity: acmeId });
  const acmeEndpoint = new Endpoint({ identity: acmeId, transport: acmeTransport, clock, timeoutMs: 15_000, freshness: FRESHNESS });
  acme.serve(acmeEndpoint);
  acmeTransport.start();
  const origEnroll = acme.group.enroll.bind(acme.group);
  acme.group.enroll = (...a) => {
    const r = origEnroll(...a);
    log(`Acme: enrolled a commitment at index ${r.index}`);
    queueMicrotask(save);
    return r;
  };

  const servers: { port: number; close: () => Promise<void> }[] = [];
  const startSite = async (site: Site, port: number) => {
    const s = await listen(port, handler(site, web, log), log);
    servers.push(s);
    return s.port;
  };
  // Ports are known only once each site listens, and some sites name others; so listen first, with routes filled in after.
  const sites: Record<keyof Omit<Ports, "relay">, Site> = {
    outlet: { name: "outlet", page: "source.html", routes: [] },
    inbox: { name: "inbox", page: "inbox.html", routes: [] },
    acme: { name: "acme", page: "acme.html", routes: [] },
    wallet: { name: "wallet", page: "wallet.html", routes: [] },
  };
  const actual = {
    outlet: await startSite(sites.outlet, ports.outlet),
    inbox: await startSite(sites.inbox, ports.inbox),
    acme: await startSite(sites.acme, ports.acme),
    wallet: await startSite(sites.wallet, ports.wallet),
  };
  const urls = {
    outlet: `http://localhost:${actual.outlet}`,
    inbox: `http://localhost:${actual.inbox}`,
    acme: `http://localhost:${actual.acme}`,
    wallet: `http://localhost:${actual.wallet}`,
    relay: relayUrl,
  };
  const logUrl = `${urls.acme}/groups/${GROUP_NAME}/log.json`;
  const snapshotBase = `${urls.acme}/groups/${GROUP_NAME}/snapshot/`;

  // ── The outlet's mirror of Acme's log ───────────────────────────────
  const fetchFromAcme = {
    json: async () => structuredClone(acme.log()),
    bytes: async (u: string) => {
      const s = acme.group.snapshot(/snapshot\/(.+)\.bin$/.exec(u)?.[1] ?? "");
      if (!s) throw new Error("404");
      return s;
    },
  };
  // The mirror talks to Acme in-process; over HTTP it would fetch logUrl and snapshotBase.
  const mirror = new Mirror({ issuer: acmeId.did, logUrl, snapshotUrl: (e) => `${snapshotBase}${e}.bin`, fetcher: fetchFromAcme, clock });
  await mirror.refresh();
  const mirrorTimer = setInterval(() => void mirror.refresh(), opts.mirrorRefreshMs ?? 2000);
  mirrorTimer.unref();
  const publishTimer = setInterval(() => {
    if (acme.publishIfDue()) {
      save();
      void mirror.refresh();
    }
  }, 5000);
  publishTimer.unref();
  let cheating: { target: string; epoch: string; root: GroupRoot } | null = null;

  const advanceDays = async (days: number) => {
    for (let i = 0; i < days; i++) {
      clock.offsetMs += 86_400_000;
      const r = acme.publishIfDue();
      if (r) log(`Acme: published the root for ${r.epoch} (${r.size} members)`);
    }
    save();
    await mirror.refresh();
  };

  const clockRoutes: Site["routes"] = [["GET", /^\/api\/clock$/, async () => ({ now: clock.now(), offsetMs: clock.offsetMs })]];
  const groupInfo = { org: ORG, label: GROUP_LABEL, group: acme.groupId, issuer: acmeId.did, log: logUrl, snapshotBase, mirrorSlug: MIRROR_SLUG };

  // ── The outlet ─────────────────────────────────────────────────────
  const bundle = (() => {
    if (!web) return undefined;
    const html = readFileSync(join(DIST, "source.html"), "utf8");
    const src = /<script[^>]+src="([^"]+)"/.exec(html)?.[1];
    if (!src) return undefined;
    return { url: src, sha256: createHash("sha256").update(readFileSync(join(DIST, src))).digest("hex") };
  })();
  sites.outlet.pageHeaders = () => ({
    // The source app may talk to its own origin, the relay, and Acme's log (when the source agrees). Nothing else.
    "content-security-policy": [
      "default-src 'self'",
      // data: is bb.js loading its own bundled WebAssembly; it never reaches the network.
      `connect-src 'self' data: ${relayUrl} ${urls.acme}`,
      "script-src 'self' 'wasm-unsafe-eval'",
      "worker-src 'self' blob:",
      "img-src 'self' blob: data:",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
    "referrer-policy": "no-referrer",
  });
  sites.outlet.routes = [
    ...clockRoutes,
    ["GET", /^\/api\/config$/, async () => ({ relayUrl, outletUrl: urls.outlet, organizations: [{ ...groupInfo }], bundle })],
    ["GET", /^\/api\/dropboxes$/, async () => [...descriptors.values()].map((d) => ({ slug: d.slug, outlet: d.outlet, journalist: d.journalist.name, stories: d.stories.map((s) => ({ id: s.id, title: s.title })) }))],
    [
      "GET",
      /^\/dropbox\/([a-z0-9-]+)\/descriptor\.json$/,
      async (_r, m) => {
        const d = descriptors.get(m[1]);
        if (!d) throw new HttpError(404, "no such drop box");
        return { __public: d };
      },
    ],
    [
      "POST",
      /^\/dropbox\/([a-z0-9-]+)\/descriptor$/,
      async (req, m) => {
        const b = await body(req);
        const v = await verifyDescriptor(b.descriptor, clock);
        if (!v.ok) throw new HttpError(400, v.why);
        if (v.descriptor.slug !== m[1]) throw new HttpError(400, "the descriptor is for another slug");
        const prior = descriptors.get(m[1]);
        if (prior && prior.issuer !== v.descriptor.issuer) throw new HttpError(409, "another drop box already uses that name");
        descriptors.set(m[1], v.descriptor);
        save();
        log(`outlet: published the descriptor for /tip/${m[1]} (${v.descriptor.stories.length} stories)`);
        return { ok: true, url: `${urls.outlet}/tip/${m[1]}` };
      },
      "cors",
    ],
    [
      "GET",
      /^\/dropbox\/[a-z0-9-]+\/mirror\/([a-z0-9-]+)\/log\.json$/,
      async (_r, m) => {
        if (m[1] !== MIRROR_SLUG) throw new HttpError(404, "no such mirror");
        return { __public: mirror.serveLog() };
      },
    ],
    [
      "GET",
      /^\/dropbox\/[a-z0-9-]+\/mirror\/([a-z0-9-]+)\/snapshot\/([0-9-]{10})\.bin$/,
      async (_r, m) => {
        const s = m[1] === MIRROR_SLUG ? mirror.serveSnapshot(m[2]) : undefined;
        if (!s) throw new HttpError(404, "no such snapshot");
        return s;
      },
    ],
  ];

  // ── The inbox and the wallet: pages, a directory, the clock ─────────
  sites.inbox.routes = [...clockRoutes, ["GET", /^\/api\/config$/, async () => ({ relayUrl, outletUrl: urls.outlet, organizations: [{ ...groupInfo }], bundle })]];
  sites.wallet.routes = [...clockRoutes, ["GET", /^\/api\/config$/, async () => ({ relayUrl, groups: [{ ...groupInfo }] })]];

  // ── Acme ───────────────────────────────────────────────────────────
  const names = () => {
    const n: Record<string, string> = { [acmeId.did]: ORG };
    for (const e of acme.members()) n[e.did] = e.name;
    for (const d of descriptors.values()) n[d.issuer] = `${d.outlet} drop box (${d.journalist.name})`;
    return n;
  };
  const search = (q: string) => {
    const needles = forms(q.trim());
    if (!needles.length) throw new HttpError(400, "search for a DID, a commitment or a nullifier (at least 16 characters)");
    const hit = (s: string) => needles.some((n) => s.includes(n));
    const places: { where: string; found: boolean; detail: string }[] = [];
    const roster = acme.members().filter((m) => hit(JSON.stringify(m)));
    places.push({ where: "HR roster and group", found: roster.length > 0, detail: roster.length ? roster.map((m) => `${m.name} (leaf ${m.index ?? "none"})`).join(", ") : "no match" });
    const log = acme.log().filter((d) => hit(JSON.stringify(d)));
    places.push({ where: "Signed root log", found: log.length > 0, detail: log.length ? `${log.length} root documents` : "no match" });
    const relayHits = stored.filter((m) => hit(m.from) || hit(m.to));
    places.push({ where: "Relay records (who sent to whom)", found: relayHits.length > 0, detail: relayHits.length ? `${relayHits.length} messages` : "no match" });
    let dbHits = 0;
    try {
      const db = new DatabaseSync(relayDb, { readOnly: true });
      for (const r of db.prepare("SELECT sender, recipient, wire FROM messages").all() as { sender: string; recipient: string; wire: Uint8Array }[]) {
        if (hit(r.sender) || hit(r.recipient) || hit(toB64u(r.wire)) || hit(Buffer.from(r.wire).toString("latin1"))) dbHits++;
      }
      db.close();
    } catch {
      /* empty database */
    }
    places.push({ where: "Relay database (queued sealed messages)", found: dbHits > 0, detail: dbHits ? `${dbHits} queued messages` : "no match" });
    return { query: q, places };
  };
  sites.acme.routes = [
    ...clockRoutes,
    [
      "POST",
      /^\/api\/clock\/advance$/,
      async (req) => {
        const days = Number((await body(req)).days ?? 1);
        if (!Number.isInteger(days) || days < 1 || days > 30) throw new HttpError(400, "skip 1 to 30 days");
        await advanceDays(days);
        return { now: clock.now() };
      },
    ],
    ["GET", new RegExp(`^/groups/${GROUP_NAME}/log\\.json$`), async () => ({ __public: acme.log() })],
    [
      "GET",
      new RegExp(`^/groups/${GROUP_NAME}/snapshot/([0-9-]{10})\\.bin$`),
      async (_r, m) => {
        const s = acme.group.snapshot(m[1]);
        if (!s) throw new HttpError(404, "no snapshot for that epoch");
        return s;
      },
    ],
    [
      "GET",
      /^\/api\/acme$/,
      async () => ({
        org: ORG,
        label: GROUP_LABEL,
        did: acmeId.did,
        group: acme.groupId,
        today: epochOf(clock.now()),
        members: acme.members(),
        log: acme.log(),
        mirror: mirror.state(),
        cheating: cheating ? { target: cheating.target, name: names()[cheating.target], epoch: cheating.epoch } : null,
        relay: urls.relay,
      }),
    ],
    [
      "POST",
      /^\/api\/acme\/employees$/,
      async (req) => {
        const b = await body(req);
        const e = acme.addEmployee(String(b.name ?? ""), String(b.did ?? "").trim());
        save();
        log(`Acme HR: added ${e.name}`);
        return e;
      },
    ],
    [
      "POST",
      /^\/api\/acme\/remove$/,
      async (req) => {
        const did = String((await body(req)).did ?? "");
        acme.removeEmployee(did);
        save();
        log(`Acme HR: removed ${names()[did] ?? did}`);
        return { ok: true };
      },
    ],
    [
      "POST",
      /^\/api\/acme\/publish$/,
      async () => {
        try {
          const r = acme.publish();
          save();
          await mirror.refresh();
          log(`Acme: published the root for ${r.epoch} (${r.size} members)`);
          return r;
        } catch (e) {
          throw new HttpError(409, (e as Error).message);
        }
      },
    ],
    [
      "POST",
      /^\/api\/acme\/cheat$/,
      async (req) => {
        const did = String((await body(req)).did ?? "");
        const fork = acme.forkRoot(did);
        mirror.tamper(fork.root, fork.snapshot);
        cheating = { target: did, epoch: fork.root.epoch, root: fork.root };
        log(`Acme: signed a second root for ${fork.root.epoch} and put it on the outlet's mirror`);
        return { root: fork.root };
      },
    ],
    [
      "POST",
      /^\/api\/acme\/cheat\/stop$/,
      async () => {
        mirror.untamper();
        cheating = null;
        await mirror.refresh();
        return { ok: true };
      },
    ],
    [
      "GET",
      /^\/api\/relay$/,
      async () => {
        const n = names();
        return {
          url: urls.relay,
          messages: stored.slice(-300).map((m) => ({ ...m, fromName: n[m.from] ?? null, toName: n[m.to] ?? null })),
          queued: [...new Set(stored.map((m) => m.to))].map((to) => ({ to, toName: n[to] ?? null, n: relay.queued(to) })).filter((q) => q.n > 0),
        };
      },
    ],
    ["POST", /^\/api\/acme\/search$/, async (req) => search(String((await body(req)).q ?? ""))],
  ];

  log(`platform: data in ${dataDir}`);
  return {
    urls,
    acme,
    mirror,
    clock,
    relay,
    dataDir,
    advanceDays,
    close: async () => {
      clearInterval(mirrorTimer);
      clearInterval(publishTimer);
      acmeEndpoint.close();
      acmeTransport.stop();
      for (const s of servers) await s.close();
      await relay.close();
    },
  };
}
