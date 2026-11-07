/**
 * The hub (design §5): signed status lists, a worker directory, agents' passports, and a witness for agents'
 * trails. Every document on it is signed by its subject: the hub can withhold, but it can't forge, and a
 * verifier that can't get a list fails closed.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { ed25519Signer, MemoryStore, Witness, witnessHttpHandler } from "@zk-toip/eventlog";
import { SystemClock, verifyCredential, verifyDocument, type Clock, type Credential, type StatusListDoc } from "@zk-toip/trust-core";
import { verifyProfile, type WorkerProfile } from "./client";

export interface Hub {
  url: string;
  witness: Witness;
  close(): Promise<void>;
}

const MAX_BODY = 512 * 1024;

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
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "request too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function startHub(o: { port?: number; host?: string; witnessSeed: Uint8Array; clock?: Clock }): Promise<Hub> {
  const clock = o.clock ?? new SystemClock();
  const host = o.host ?? "127.0.0.1";
  const witness = new Witness({ signer: ed25519Signer(o.witnessSeed), store: new MemoryStore(), clock });
  const witnessHandler = witnessHttpHandler(witness);
  const lists = new Map<string, StatusListDoc>();
  const workers = new Map<string, WorkerProfile>();
  const passports = new Map<string, Credential>();

  const json = async (req: IncomingMessage) => {
    try {
      const v = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      if (!v || typeof v !== "object") throw new Error();
      return v as Record<string, any>;
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, "expected a JSON object");
    }
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://hub");
    const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" }).end(JSON.stringify(body));
    try {
      if (url.pathname.startsWith("/witness/")) {
        const body = req.method === "GET" ? undefined : (await readBody(req)).toString("utf8");
        const r = await witnessHandler(new Request(`http://hub${url.pathname}${url.search}`, { method: req.method, ...(body ? { body } : {}) }));
        res.writeHead(r.status, Object.fromEntries(r.headers)).end(Buffer.from(await r.arrayBuffer()));
        return;
      }
      const m = /^\/api\/(status|passports)\/(.+)$/.exec(url.pathname);
      if (req.method === "GET" && m) {
        const did = decodeURIComponent(m[2]);
        const doc = m[1] === "status" ? lists.get(did) : passports.get(did);
        return doc ? send(200, doc) : send(404, { error: "none" });
      }
      if (req.method === "PUT" && url.pathname === "/api/status") {
        const { list } = await json(req);
        if (list?.type !== "status-list" || typeof list.issuer !== "string" || list.id !== `${list.issuer}#status`) throw new HttpError(400, "expected a signed status list");
        if (!(await verifyDocument(list, clock).catch(() => ({ valid: false }))).valid) throw new HttpError(400, "the list's signature doesn't check out");
        const old = lists.get(list.issuer);
        if (!old || Date.parse(list.issuedAt) >= Date.parse(old.issuedAt)) lists.set(list.issuer, list);
        return send(200, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/api/workers") return send(200, { workers: [...workers.values()] });
      if (req.method === "POST" && url.pathname === "/api/workers") {
        const { profile } = await json(req);
        if (!(await verifyProfile(profile, clock))) throw new HttpError(400, "expected a signed worker profile");
        workers.set(profile.issuer, profile);
        return send(200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/passports") {
        const { passport } = await json(req);
        if (!passport?.type?.includes?.("AgentPassport") || !(await verifyCredential(passport, clock)).ok) throw new HttpError(400, "expected a signed passport");
        passports.set(passport.credentialSubject.id, passport);
        return send(200, { ok: true });
      }
      send(404, { error: "no such endpoint" });
    } catch (e) {
      send(e instanceof HttpError ? e.status : 500, { error: String((e as Error)?.message ?? e) });
    }
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(o.port ?? 0, host, () => resolve()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://${host}:${port}`,
    witness,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
