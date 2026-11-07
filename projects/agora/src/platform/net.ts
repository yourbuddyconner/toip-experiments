/** HTTP plumbing shared by the host, the registrar and the web app's server. Node only. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { DemoClock } from "@zk-toip/trust-core";

export const MAX_BODY = 256 * 1024;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "tooLarge", "request too large");
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "malformed", "expected JSON");
  }
}

/** Public APIs: any origin may read, and write with signed JSON. No cookies are used, so no credentials. */
export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
  "access-control-allow-headers": "content-type",
  "cross-origin-resource-policy": "cross-origin",
};

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...CORS }).end(JSON.stringify(body));
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Listens on `port` (0 picks one). On a loopback host it also listens on [::1] at the same port, so
 * http://localhost reaches this server whichever address "localhost" resolves to. Passkeys need the
 * name "localhost", not an IP address.
 */
export async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void, port: number, host = "127.0.0.1"): Promise<{ port: number; close: () => Promise<void>; servers: Server[] }> {
  const main = createServer(handler);
  await new Promise<void>((resolve, reject) => main.once("error", reject).listen(port, host === "localhost" ? "127.0.0.1" : host, () => resolve()));
  const bound = (main.address() as { port: number }).port;
  const servers = [main];
  if (LOOPBACK.has(host) && host !== "::1") {
    const six = createServer(handler);
    const ok = await new Promise<boolean>((resolve) => six.once("error", () => resolve(false)).listen(bound, "::1", () => resolve(true)));
    if (ok) servers.push(six);
  }
  return {
    port: bound,
    servers,
    close: async () => {
      for (const s of servers) {
        s.closeAllConnections?.();
        await new Promise<void>((r) => s.close(() => r()));
      }
    },
  };
}

/** The dev clock (design §6.2): real time plus an offset that "Skip ahead" moves. Shared by every component. */
export class DevClock {
  private offset = 0;
  private readonly listeners = new Set<() => void>();

  constructor(offsetMs = 0) {
    this.offset = offsetMs;
  }

  now(): number {
    return Date.now() + this.offset;
  }
  iso(): string {
    return new Date(this.now()).toISOString();
  }
  date(): Date {
    return new Date(this.now());
  }
  get offsetMs(): number {
    return this.offset;
  }
  advance(ms: number): void {
    this.offset += ms;
    for (const fn of this.listeners) fn();
  }
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export type AdvanceableClock = DevClock | DemoClock;
