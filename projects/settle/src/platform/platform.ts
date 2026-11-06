/**
 * A whole Settle network on one machine (design §17): a local Solana cluster running the escrow program,
 * the TSP relay, the processor and the arbiter, a verification issuer, a test-money faucet, and the web app.
 *
 * Nothing here can move anyone's money: the browser parties hold their own keys and sign for themselves.
 * The platform pays network fees (the processor), arbitrates when asked (the arbiter), and runs the
 * conveniences a development network needs: test USDC, a phone book of display names, time travel.
 */
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { startRelay, type Relay } from "@zk-toip/relay";
import { identityFromSeed, issueCredential, SystemClock, verifyDocument, type Clock, type Identity } from "@zk-toip/trust-core";
import type { Address, KeyPairSigner } from "@solana/kit";
import { Chain } from "../chain/chain";
import { STATE } from "../chain/escrow";
import { startChainServer, type ChainServer } from "../chain/rpcServer";
import { verifyLog } from "../protocol/log";
import { loadPolicy } from "../protocol/policyFile";
import { Arbiter, Processor } from "../agents/roles";
import type { AgentEvent, Directory } from "../agents/base";

export const WEB_DIR = join(import.meta.dirname, "..", "..", "web");

export interface PlatformOptions {
  /** The web app and API. 0 picks a free port. */
  port?: number;
  rpcPort?: number;
  relayPort?: number;
  /** How to serve the web app: Vite with hot reload, the built files in web/dist, or not at all. */
  web?: "dev" | "static" | "none";
  dataDir?: string;
  log?: (line: string) => void;
}

export interface PlatformConfig {
  /** Changes every time the platform starts: the local chain starts empty, so browsers drop old payments. */
  networkId: string;
  rpcUrl: string;
  relayUrl: string;
  programId: Address;
  mint: Address;
  processor: { did: string; feePayer: Address; feeAccount: Address; fee: { bps: number; minUnits: string } };
  arbiter: { did: string; key: Address };
  verifier: string;
  names: Record<string, string>;
}

export interface Platform {
  url: string;
  config: PlatformConfig;
  chain: Chain;
  chainServer: ChainServer;
  relay: Relay;
  processor: Processor;
  arbiter: Arbiter;
  verifier: Identity;
  /** Test USDC, from the faucet's mint authority. */
  mintTo(tokenAccount: Address, units: bigint): Promise<void>;
  close(): Promise<void>;
}

const MAX_BODY = 256 * 1024;
const MAX_FAUCET_UNITS = 10_000n * 1_000_000n;
const MAX_ADVANCE_SECONDS = 400 * 86400;

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

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".json": "application/json" };

export async function startPlatform(opts: PlatformOptions = {}): Promise<Platform> {
  const log = opts.log ?? (() => {});
  const clock: Clock = new SystemClock();
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), "settle-platform-"));
  const relay = await startRelay({ port: opts.relayPort ?? 0, dbPath: join(dataDir, `relay-${Date.now()}.db`) });
  const chainServer = await startChainServer({ port: opts.rpcPort ?? 0 });
  const chain = await Chain.connect(chainServer.url);
  const net = chainServer.net;
  const policy = await loadPolicy();

  const faucet: KeyPairSigner = await net.funded();
  const mint = await net.createMint(faucet);
  const fresh = (): Identity => identityFromSeed(crypto.getRandomValues(new Uint8Array(32)));
  const ids = { processor: fresh(), arbiter: fresh(), verifier: fresh() };
  const arbiterKey = await Arbiter.keyFor(ids.arbiter);
  const names: Record<string, string> = {
    [ids.processor.did]: "Settle Processor",
    [ids.arbiter.did]: "Settle Arbitration",
    [ids.verifier.did]: "Settle Verify",
  };
  const directory = (): Directory => ({
    names,
    processor: ids.processor.did,
    arbiter: { did: ids.arbiter.did, key: arbiterKey.address },
    licensingBoard: ids.verifier.did,
    mint,
  });
  const onEvent = (e: AgentEvent) => log(`${e.who}: ${e.text}`);
  const common = { relayUrl: relay.url, clock, chain, policy, onEvent };
  const processor = new Processor({ ...common, name: "Settle Processor", identity: ids.processor, directory: directory() });
  const arbiter = new Arbiter({ ...common, name: "Settle Arbitration", identity: ids.arbiter, directory: directory() });
  await processor.setup(mint);
  processor.directory.fee = { bps: processor.feeBps, minUnits: processor.minFeeUnits.toString() };
  arbiter.directory.processorFeeAccount = processor.feeAccount;
  await Promise.all([processor.start(), arbiter.start()]);

  /** The phone book: display names people chose for themselves, and which ones Settle Verify vouched for. */
  const people = new Map<string, { did: string; name: string; verified?: string }>();

  const config: PlatformConfig = {
    networkId: crypto.randomUUID(),
    rpcUrl: chainServer.url,
    relayUrl: relay.url,
    programId: chain.programId,
    mint,
    processor: { did: ids.processor.did, feePayer: processor.feePayer.address, feeAccount: processor.feeAccount, fee: { bps: processor.feeBps, minUnits: processor.minFeeUnits.toString() } },
    arbiter: { did: ids.arbiter.did, key: arbiterKey.address },
    verifier: ids.verifier.did,
    names,
  };

  const nameOf = (did: string) => names[did] ?? `${did.slice(0, 16)}…`;

  async function isTokenAccountOfMint(a: Address): Promise<boolean> {
    const r = await chain.rpc.getAccountInfo(a, { encoding: "base64" }).send();
    if (!r.value || r.value.owner !== "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") return false;
    const d = Uint8Array.from(atob(r.value.data[0]), (c) => c.charCodeAt(0));
    const { bytesAddress } = await import("../chain/escrow");
    return d.length >= 165 && bytesAddress(d.slice(0, 32)) === mint;
  }

  function cases() {
    return [...arbiter.payments.values()]
      .filter((p) => p.terms)
      .map((p) => {
        const t = p.terms!;
        return {
          id: p.id,
          purpose: t.purpose,
          escrow: p.escrow,
          payer: { did: t.payer.did, name: nameOf(t.payer.did) },
          payee: { did: t.payee.did, name: nameOf(t.payee.did) },
          attester: { did: t.conditions.attester, name: nameOf(t.conditions.attester) },
          units: t.amount.units,
          fee: t.fee.units,
          disputeWindowDays: t.conditions.disputeWindowSeconds / 86400,
          attestations: p.attestations.map((a) => ({ by: nameOf(a.issuer), claim: a.claim, note: a.note, at: a.at })),
          disputes: p.disputes.map((d) => ({ by: nameOf(d.issuer), role: d.issuer === t.payer.did ? "payer" : "payee", reason: d.reason, at: d.at })),
          ruling: p.ruling ? { payeeUnits: p.ruling.payeeUnits, reasons: p.ruling.reasons, at: p.ruling.at } : null,
        };
      });
  }

  const routes: Record<string, (req: IncomingMessage) => Promise<unknown>> = {
    "GET /api/config": async () => config,
    "GET /api/directory": async () => ({ people: [...people.values()] }),
    "POST /api/directory": async (req) => {
      const { profile } = (await body(req)) as { profile?: { type?: string; issuer?: string; name?: string } };
      if (profile?.type !== "settle/profile" || typeof profile.issuer !== "string" || typeof profile.name !== "string" || !profile.name.trim()) throw new HttpError(400, "expected a signed settle/profile");
      if (!(await verifyDocument(profile, clock)).valid) throw new HttpError(400, "the profile's signature doesn't check out");
      if (names[profile.issuer] && [ids.processor.did, ids.arbiter.did, ids.verifier.did].includes(profile.issuer)) throw new HttpError(400, "reserved");
      const name = profile.name.trim().slice(0, 80);
      const prev = people.get(profile.issuer);
      people.set(profile.issuer, { did: profile.issuer, name, verified: prev?.verified });
      names[profile.issuer] = name;
      for (const a of [processor, arbiter]) a.directory.names[profile.issuer] = name;
      return { ok: true };
    },
    "POST /api/faucet": async (req) => {
      const b = await body(req);
      const to = String(b.tokenAccount ?? "") as Address;
      let units: bigint;
      try {
        units = BigInt(String(b.units ?? "0"));
      } catch {
        throw new HttpError(400, "units must be a whole number of micro-USDC");
      }
      if (units <= 0n || units > MAX_FAUCET_UNITS) throw new HttpError(400, "ask for between 0 and 10,000 test USDC");
      if (!(await isTokenAccountOfMint(to))) throw new HttpError(400, "not a test-USDC account on this network");
      await net.mintTo(mint, to, faucet, units);
      log(`faucet: ${Number(units) / 1e6} test USDC to ${to}`);
      return { ok: true, balance: (await chain.balance(to)).toString() };
    },
    "POST /api/verify": async (req) => {
      const { request } = (await body(req)) as { request?: { type?: string; issuer?: string; businessName?: string; category?: string } };
      if (request?.type !== "settle/verify-request" || typeof request.issuer !== "string" || typeof request.businessName !== "string" || !request.businessName.trim()) {
        throw new HttpError(400, "expected a signed settle/verify-request");
      }
      if (!(await verifyDocument(request, clock)).valid) throw new HttpError(400, "the request's signature doesn't check out");
      const name = request.businessName.trim().slice(0, 80);
      // A development verifier: it vouches for whatever name you give it. A real one would check documents first.
      const credential = issueCredential(ids.verifier, clock, {
        type: ["VerifiableCredential", "VerifiedBusiness"],
        credentialSubject: { id: request.issuer, name, category: String(request.category ?? "").slice(0, 60) },
        validUntil: new Date(clock.now() + 365 * 86400_000).toISOString(),
      });
      const p = people.get(request.issuer);
      if (p) p.verified = name;
      log(`Settle Verify: vouched for "${name}"`);
      return { credential };
    },
    "GET /api/time": async () => ({ now: Number(await chain.now()) }),
    "POST /api/dev/advance": async (req) => {
      const seconds = Number((await body(req)).seconds);
      if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_ADVANCE_SECONDS) throw new HttpError(400, "seconds must be between 0 and 400 days");
      await chain.advanceClock(Math.floor(seconds));
      return { now: Number(await chain.now()) };
    },
    "GET /api/processor": async () => {
      const snap = processor.log.snapshot();
      return {
        did: ids.processor.did,
        fee: config.processor.fee,
        feeAccount: processor.feeAccount,
        feeBalance: (await chain.balance(processor.feeAccount)).toString(),
        feePayer: processor.feePayer.address,
        feePayerLamports: (await chain.lamports(processor.feePayer.address)).toString(),
        escrows: processor.escrows,
        log: snap,
        check: await verifyLog(snap.entries, snap.head, ids.processor.did, clock),
        events: processor.events.slice(-80),
      };
    },
    "GET /api/arbiter": async () => {
      const list = cases();
      const states = await Promise.all(list.map(async (c) => (c.escrow ? await chain.escrow(c.escrow) : null)));
      return {
        did: ids.arbiter.did,
        key: arbiterKey.address,
        now: Number(await chain.now()),
        cases: list.map((c, i) => ({
          ...c,
          state: states[i]?.state === STATE.resolved ? "resolved" : states[i]?.state === STATE.reclaimed ? "reclaimed" : "funded",
          payeePaid: states[i]?.payeePaid.toString() ?? null,
          refundAfter: states[i] ? Number(states[i]!.refundAfter) : null,
        })),
      };
    },
    "POST /api/arbiter/rule": async (req) => {
      const b = await body(req);
      const id = String(b.paymentId ?? "");
      const p = arbiter.payments.get(id);
      if (!p?.terms) throw new HttpError(404, "no such case");
      if (!p.disputes.length) throw new HttpError(400, "nobody has disputed this payment");
      if (p.ruling) throw new HttpError(400, "already ruled");
      let payeeUnits: bigint;
      try {
        payeeUnits = BigInt(String(b.payeeUnits));
      } catch {
        throw new HttpError(400, "payeeUnits must be a whole number");
      }
      if (payeeUnits < 0n || payeeUnits > BigInt(p.terms.amount.units)) throw new HttpError(400, "the ruling must pay the payee between nothing and the full price");
      const reasons = String(b.reasons ?? "").trim();
      if (!reasons) throw new HttpError(400, "give reasons");
      const r = await arbiter.rule(id, payeeUnits, reasons.slice(0, 1000));
      return { ruling: r };
    },
  };

  // ---------------------------------------------------------------- web app
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
      const route = routes[`${req.method} ${url.pathname}`];
      try {
        if (!route) throw new HttpError(404, "no such endpoint");
        const out = await route(req);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 500;
        if (status === 500) log(`error on ${url.pathname}: ${String((e as Error)?.stack ?? e)}`);
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: String((e as Error)?.message ?? e) }));
      }
      return;
    }
    if (vite) return vite.middlewares(req, res, () => res.writeHead(404).end());
    if (opts.web === "static") return serveStatic(req, res);
    res.writeHead(404).end("no web app on this platform");
  });

  if (opts.web === "dev") {
    const { createServer: createVite } = await import("vite");
    vite = await createVite({ root: WEB_DIR, configFile: join(WEB_DIR, "vite.config.ts"), appType: "spa", server: { middlewareMode: true, hmr: { server } }, logLevel: "warn" });
  } else if (opts.web === "static" && !existsSync(join(distDir, "index.html"))) {
    throw new Error("the web app isn't built: run `npm run build:web --workspace @zk-toip/settle`");
  }
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  return {
    // The address it actually listens on: "localhost" can resolve to another server on ::1.
    url: `http://127.0.0.1:${port}`,
    config,
    chain,
    chainServer,
    relay,
    processor,
    arbiter,
    verifier: ids.verifier,
    mintTo: (to, units) => net.mintTo(mint, to, faucet, units),
    close: async () => {
      processor.stop();
      arbiter.stop();
      await vite?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
      await chainServer.close();
      await relay.close();
    },
  };
}
