/**
 * The registrars' public reads (design §7.7), for every demo issuer on one server: group descriptors,
 * signed root logs, the snapshot behind each root, and each issuer's signed status list. Joining is not
 * here: it goes over TSP from the member's DID.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { toB64u } from "@toip-tools/trust-core";
import type { DemoIssuer } from "../issuers/issuers";
import { CORS, HttpError, listen, sendJson } from "../platform/net";

export async function serveRegistrars(issuers: DemoIssuer[], opts: { port?: number; hostname?: string; log?: (l: string) => void } = {}) {
  // `issuers` may still be filling when the server starts: look up on each request.
  const byGroup = { get: (id: string) => issuers.find((i) => i.registrar.groupId === id) };
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "OPTIONS") return void res.writeHead(204, CORS).end();
    try {
      if (req.method !== "GET") throw new HttpError(405, "malformed", "read only");
      const p = url.pathname;
      if (p === "/groups") return sendJson(res, 200, { groups: issuers.map((i) => i.registrar.descriptor) });
      if (p === "/issuers") return sendJson(res, 200, { issuers: issuers.map((i) => i.info()) });
      let m = p.match(/^\/status\/([^/]+)$/);
      if (m) {
        const i = issuers.find((x) => x.did === decodeURIComponent(m![1]));
        if (!i) throw new HttpError(404, "notFound", "no such issuer");
        return sendJson(res, 200, i.statusList());
      }
      m = p.match(/^\/groups\/([^/]+)(\/roots|\/snapshot)?$/);
      const issuer = m && byGroup.get(decodeURIComponent(m[1]));
      if (!m || !issuer) throw new HttpError(404, "notFound", "no such group");
      const r = issuer.registrar;
      if (!m[2]) return sendJson(res, 200, r.descriptor);
      if (m[2] === "/roots") return sendJson(res, 200, { roots: r.roots() });
      const epoch = url.searchParams.get("epoch") ?? r.roots().at(-1)?.epoch;
      const snap = epoch ? r.snapshot(epoch) : undefined;
      if (!snap) throw new HttpError(404, "notFound", "no snapshot for that epoch");
      return sendJson(res, 200, { epoch, snapshot: toB64u(snap) });
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { code: e.code, message: e.message });
      opts.log?.(`registrar error: ${(e as Error)?.stack ?? e}`);
      return sendJson(res, 500, { code: "internal", message: "the registrar failed" });
    }
  };
  const l = await listen(handler, opts.port ?? 0, opts.hostname ?? "127.0.0.1");
  return { url: `http://127.0.0.1:${l.port}`, port: l.port, close: l.close };
}
