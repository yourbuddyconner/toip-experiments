/**
 * The host's HTTP API (design §7.7). Bodies are the signed documents themselves. Errors are
 * { code, message }. No request is logged, and no address or user agent is kept.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ForumPolicy, Gate, Moderation, NymPass, Poll, Post, ReportDoc, DeleteDoc, Vote } from "../protocol/documents";
import { CORS, HttpError, listen, readJson, sendJson, type AdvanceableClock } from "../platform/net";
import { ForumHost, HostError } from "./host";

export interface HostServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

const MAX_ADVANCE = 400 * 86400;

export async function serveHost(host: ForumHost, opts: { port?: number; hostname?: string; clock: AdvanceableClock; devClock?: boolean; onAdvance?: () => void | Promise<void>; log?: (l: string) => void }): Promise<HostServer> {
  const streams = new Set<ServerResponse>();
  type Route = (req: IncomingMessage, params: string[]) => Promise<unknown>;
  const routes: [string, RegExp, Route][] = [
    ["GET", /^\/info$/, async () => ({ did: host.identity.did, aid: host.aid, now: opts.clock.now(), devClock: !!opts.devClock })],
    ["GET", /^\/time$/, async () => ({ now: opts.clock.now() })],
    [
      "POST",
      /^\/dev\/advance$/,
      async (req) => {
        if (!opts.devClock) throw new HttpError(400, "malformed", "this host keeps real time");
        const seconds = Number((await readJson(req) as { seconds?: unknown })?.seconds);
        if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_ADVANCE) throw new HttpError(400, "malformed", "seconds must be between 0 and 400 days");
        opts.clock.advance(Math.floor(seconds) * 1000);
        await opts.onAdvance?.();
        opts.log?.(`dev clock: skipped ahead ${Math.round(seconds / 3600)} h, now ${opts.clock.iso()}`);
        return { now: opts.clock.now() };
      },
    ],
    ["GET", /^\/forums$/, async () => ({ forums: host.forumList() })],
    ["POST", /^\/forums$/, async (req) => host.createForum((await readJson(req)) as ForumPolicy)],
    ["GET", /^\/forums\/([^/]+)$/, async (_r, [id]) => host.forumInfo(id)],
    ["PUT", /^\/forums\/([^/]+)\/policy$/, async (req, [id]) => host.updatePolicy(id, (await readJson(req)) as ForumPolicy)],
    ["GET", /^\/forums\/([^/]+)\/feed$/, async (_r, [id]) => host.feed(id)],
    ["POST", /^\/forums\/([^/]+)\/passes$/, async (req, [id]) => host.submitPass(id, (await readJson(req)) as NymPass)],
    ["POST", /^\/forums\/([^/]+)\/posts$/, async (req, [id]) => host.submitPost(id, (await readJson(req)) as Post)],
    ["POST", /^\/forums\/([^/]+)\/deletes$/, async (req, [id]) => host.submitDelete(id, (await readJson(req)) as DeleteDoc)],
    ["POST", /^\/forums\/([^/]+)\/reports$/, async (req, [id]) => host.submitReport(id, (await readJson(req)) as ReportDoc)],
    ["POST", /^\/forums\/([^/]+)\/moderation$/, async (req, [id]) => host.moderate(id, (await readJson(req)) as Moderation)],
    ["POST", /^\/forums\/([^/]+)\/pin$/, async (req, [id]) => ({ pinned: await host.pinFor(id, ((await readJson(req)) as { gate: Gate }).gate) })],
    ["POST", /^\/forums\/([^/]+)\/polls$/, async (req, [id]) => host.openPoll(id, (await readJson(req)) as Poll)],
    ["GET", /^\/forums\/([^/]+)\/polls\/([^/]+)$/, async (_r, [id, pid]) => host.poll(id, pid)],
    ["POST", /^\/forums\/([^/]+)\/polls\/([^/]+)\/votes$/, async (req, [id, pid]) => host.vote(id, pid, (await readJson(req)) as Vote)],
  ];

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "OPTIONS") return void res.writeHead(204, CORS).end();
    const sse = url.pathname.match(/^\/forums\/([^/]+)\/events$/);
    if (sse && req.method === "GET") {
      let off: () => void;
      try {
        off = host.subscribe(decodeURIComponent(sse[1]), (seq) => res.write(`data: ${JSON.stringify({ seq })}\n\n`));
      } catch (e) {
        return sendJson(res, 404, { code: "notFound", message: (e as Error).message });
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", ...CORS });
      res.write(": hello\n\n");
      streams.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.on("close", () => {
        clearInterval(ping);
        off();
        streams.delete(res);
      });
      return;
    }
    try {
      for (const [method, re, fn] of routes) {
        const m = url.pathname.match(re);
        if (!m || req.method !== method) continue;
        if (method !== "GET" && !String(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "malformed", "send JSON");
        return sendJson(res, 200, await fn(req, m.slice(1).map(decodeURIComponent)));
      }
      throw new HttpError(404, "notFound", "no such endpoint");
    } catch (e) {
      if (e instanceof HostError || e instanceof HttpError) return sendJson(res, e.status, { code: e.code, message: e.message });
      opts.log?.(`host error on ${req.method} ${url.pathname}: ${(e as Error)?.stack ?? e}`);
      return sendJson(res, 500, { code: "internal", message: "the host failed; see its console" });
    }
  };
  const l = await listen((req, res) => void handler(req, res), opts.port ?? 0, opts.hostname ?? "127.0.0.1");
  return {
    url: `http://127.0.0.1:${l.port}`,
    port: l.port,
    close: async () => {
      for (const s of streams) s.end();
      await l.close();
    },
  };
}
