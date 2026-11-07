/** Serves a fetch-style handler with node:http. Node only. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export async function serveHttp(
  handler: (req: Request) => Promise<Response>,
  opts: { port?: number; host?: string } = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  const host = opts.host ?? "127.0.0.1";
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(`http://${host}${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, ...(body && req.method !== "GET" ? { body } : {}) });
    const response = await handler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, host, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${host}:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
