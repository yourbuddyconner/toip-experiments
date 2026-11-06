/**
 * A whole Settle network in one process (design §17, §18): the TSP relay, the processor and the arbiter,
 * a verification issuer, a test-money faucet, a gas station, operator sign-in, and the web app. The chain
 * is either the platform's own local cluster or a real one such as devnet (cluster.ts).
 *
 * Nothing here can move anyone's money: the browser parties hold their own keys and sign for themselves.
 * The platform pays network fees (the processor), arbitrates when asked (the arbiter), and runs the
 * conveniences a development network needs: test USDC, SOL for rent, a phone book of display names, and,
 * on a local cluster, time travel.
 *
 * Everything it knows is kept in its data directory (state.ts), so it picks up where it left off.
 */
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { startRelay, type Relay } from "@zk-toip/relay";
import { issueCredential, SystemClock, verifyDocument, type Clock, type Identity } from "@zk-toip/trust-core";
import type { Address, KeyPairSigner } from "@solana/kit";
import type { Chain } from "../chain/chain";
import { STATE } from "../chain/escrow";
import { verifyLog } from "../protocol/log";
import { loadPolicy } from "../protocol/policyFile";
import { Arbiter, Processor, type ArbiterSnapshot, type ProcessorSnapshot } from "../agents/roles";
import type { AgentEvent, Directory } from "../agents/base";
import { LAMPORTS_PER_SOL, openCluster, type Cluster } from "./cluster";
import { autosave, DataDir, identityOf, signerOf } from "./state";
import { OperatorError, Operators, sessionCookie, SESSION_TTL_MS, type OperatorProof } from "./operators";

export const WEB_DIR = join(import.meta.dirname, "..", "..", "web");

export interface PlatformOptions {
  /** The web app and API. 0 picks a free port. */
  port?: number;
  /** The local cluster's RPC port (unused on a real cluster). */
  rpcPort?: number;
  relayPort?: number;
  /** Where the servers listen. Defaults to this machine only (127.0.0.1); "0.0.0.0" serves the network. */
  host?: string;
  /** The host name browsers use to reach the relay and the local cluster, when it isn't `host`. */
  publicHost?: string;
  /** How to serve the web app: Vite with hot reload, the built files in web/dist, or not at all. */
  web?: "dev" | "static" | "none";
  /** Where the platform keeps everything between runs. Defaults to a fresh temporary directory. */
  dataDir?: string;
  /** "local" (default), "devnet", "localnet", or an RPC URL. */
  cluster?: string;
  /** The deployed Settle program on a real cluster; defaults to the development program id. */
  programId?: Address;
  log?: (line: string) => void;
}

export interface PlatformConfig {
  /** The same for as long as the platform keeps its data directory. Browsers keep payments per network id. */
  networkId: string;
  /** "local", "devnet", or an RPC URL. */
  cluster: string;
  /** Whether the chain's clock can be moved forward (only a local cluster's can). */
  devClock: boolean;
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
  /** The API, at the address the platform listens on. */
  url: string;
  /** The web app, for people: http://localhost:<port> on this machine. */
  appUrl: string;
  config: PlatformConfig;
  chain: Chain;
  cluster: Cluster;
  dataDir: string;
  relay: Relay;
  operators: Operators;
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
/** The gas station gives at most this much SOL at a time, and only to addresses holding less than GAS_CEILING. */
const MAX_GAS_LAMPORTS = 5_000_000n;
const GAS_CEILING = 10_000_000n;
/** What the processor's fee payer keeps on hand, and what the treasury needs to start on a real cluster. */
const FEE_PAYER_FLOAT = { local: 100n * LAMPORTS_PER_SOL, remote: LAMPORTS_PER_SOL / 10n };
const TREASURY_MINIMUM = LAMPORTS_PER_SOL / 5n;

/** Requests per client address per minute, for the endpoints anyone can call. */
class RateLimit {
  private readonly hits = new Map<string, { n: number; since: number }>();
  constructor(private readonly perMinute: number) {}
  take(who: string): void {
    const now = Date.now();
    const h = this.hits.get(who);
    if (!h || now - h.since > 60_000) {
      if (this.hits.size > 10_000) this.hits.clear();
      this.hits.set(who, { n: 1, since: now });
      return;
    }
    if (++h.n > this.perMinute) throw new HttpError(429, "too many requests; wait a minute");
  }
}

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
  const host = opts.host ?? "127.0.0.1";
  const loopbackOnly = host === "127.0.0.1" || host === "::1" || host === "localhost";
  const publicHost = opts.publicHost ?? (loopbackOnly || host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host);
  const data = new DataDir(opts.dataDir ?? mkdtempSync(join(tmpdir(), "settle-platform-")));

  const hadSecrets = existsSync(data.path("platform.json"));
  const emptyChain = (opts.cluster ?? "local") === "local" && !existsSync(data.path("chain.bin"));
  const cluster = await openCluster({ cluster: opts.cluster, programId: opts.programId, rpcPort: opts.rpcPort, host, snapshot: data.path("chain.bin") });
  const chain = cluster.chain;
  const secrets = data.secrets({ rpcUrl: cluster.local ? "local" : cluster.rpcUrl, programId: chain.programId });
  // A kept platform over a local chain that's gone: it's a new network, so browsers drop payments that no longer exist.
  const newNetwork = hadSecrets && emptyChain;
  if (newNetwork) {
    secrets.networkId = crypto.randomUUID();
    data.saveSecrets(secrets);
  }
  const relay = await startRelay({ port: opts.relayPort ?? 0, host, dbPath: data.path("relay.db") });
  const relayUrl = relay.url.replace(`//${host}:`, `//${publicHost}:`);
  const rpcUrl = cluster.local ? cluster.rpcUrl.replace(`//${host}:`, `//${publicHost}:`) : cluster.rpcUrl;
  const policy = await loadPolicy();

  // ---------------------------------------------------------------- keys, money for fees, the test-USDC mint
  const treasury = await signerOf(secrets.keys.treasury);
  const lamportsOf = (a: Address) => chain.lamports(a);
  if (cluster.local) {
    if ((await lamportsOf(treasury.address)) < 100n * LAMPORTS_PER_SOL) await cluster.fund(treasury, treasury.address, 1000n * LAMPORTS_PER_SOL);
  } else if ((await lamportsOf(treasury.address)) < TREASURY_MINIMUM) {
    await chain.airdrop(treasury.address, 1n).catch(() => {});
    if ((await lamportsOf(treasury.address)) < TREASURY_MINIMUM) {
      throw new Error(
        `the platform's treasury needs SOL on ${cluster.name}: send at least ${Number(TREASURY_MINIMUM) / 1e9} SOL to ${treasury.address} ` +
          `(on devnet, https://faucet.solana.com), then start again. Its key is in ${data.path("platform.json")}.`,
      );
    }
  }
  const mintKey = await signerOf(secrets.keys.mint);
  const mint = (await chain.exists(mintKey.address)) ? mintKey.address : await chain.createMint(treasury, mintKey, treasury.address);
  const processorKeys = { feePayer: await signerOf(secrets.keys.feePayer), feeOwner: await signerOf(secrets.keys.feeOwner), feeAccount: await signerOf(secrets.keys.feeAccount) };
  const feePayerFloat = cluster.local ? FEE_PAYER_FLOAT.local : FEE_PAYER_FLOAT.remote;
  /** Keeps the processor able to pay network fees and escrow rent. */
  const topUpFeePayer = async () => {
    const have = await lamportsOf(processorKeys.feePayer.address);
    if (have < feePayerFloat / 2n) await cluster.fund(treasury, processorKeys.feePayer.address, feePayerFloat - have);
  };
  await topUpFeePayer();

  // ---------------------------------------------------------------- the network's services
  const ids = { processor: identityOf(secrets.seeds.processor), arbiter: identityOf(secrets.seeds.arbiter), verifier: identityOf(secrets.seeds.verifier) };
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
  const common = { relayUrl, clock, chain, policy, onEvent };
  const processor = new Processor({ ...common, name: "Settle Processor", identity: ids.processor, directory: directory() });
  const arbiter = new Arbiter({ ...common, name: "Settle Arbitration", identity: ids.arbiter, directory: directory() });
  await processor.setup(mint, processorKeys);
  processor.directory.fee = { bps: processor.feeBps, minUnits: processor.minFeeUnits.toString() };
  arbiter.directory.processorFeeAccount = processor.feeAccount;
  const saved = newNetwork ? undefined : data.read<{ processor: ProcessorSnapshot; arbiter: ArbiterSnapshot }>("agents.json");
  if (saved) {
    processor.restore(saved.processor);
    arbiter.restore(saved.arbiter);
  }
  await Promise.all([processor.start(), arbiter.start()]);
  const agentsSaver = autosave(
    () => ({ processor: processor.snapshot(), arbiter: arbiter.snapshot() }),
    (json) => data.writeText("agents.json", json),
  );
  const feePayerTimer = setInterval(() => void topUpFeePayer().catch((e) => log(`couldn't top up the fee payer: ${String(e?.message ?? e)}`)), 60_000);
  feePayerTimer.unref();

  const operators = new Operators(secrets.operators, secrets.networkId, clock, () => data.saveSecrets(secrets));

  /** The phone book: display names people chose for themselves, and which ones Settle Verify vouched for. */
  type Person = { did: string; name: string; verified?: string };
  const people = new Map<string, Person>((data.read<Person[]>("directory.json") ?? []).map((p) => [p.did, p]));
  for (const p of people.values()) names[p.did] = p.name;
  const peopleSaver = autosave(
    () => [...people.values()],
    (json) => data.writeText("directory.json", json),
  );

  const config: PlatformConfig = {
    networkId: secrets.networkId,
    cluster: cluster.name,
    devClock: !!cluster.advance,
    rpcUrl,
    relayUrl,
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

  interface Ctx {
    /** The client's address, for rate limits. */
    ip: string;
    /** The signed-in operator, if any. */
    operator: string | null;
    setCookie(c: string): void;
  }
  const mustBeOperator = (ctx: Ctx): string => {
    if (!ctx.operator) throw new HttpError(401, "sign in as an operator first");
    return ctx.operator;
  };
  const limits = { faucet: new RateLimit(cluster.local ? 600 : 20), gas: new RateLimit(cluster.local ? 600 : 30), open: new RateLimit(600) };
  const secure = false; // served over plain HTTP here; behind TLS the proxy should set Secure

  const routes: Record<string, (req: IncomingMessage, ctx: Ctx) => Promise<unknown>> = {
    "GET /api/config": async () => config,
    "GET /api/directory": async () => ({ people: [...people.values()] }),
    "POST /api/directory": async (req, ctx) => {
      limits.open.take(ctx.ip);
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
    "POST /api/faucet": async (req, ctx) => {
      limits.faucet.take(ctx.ip);
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
      const r = await chain.mintTo(mint, to, treasury, units);
      if (!r.ok) throw new HttpError(502, `couldn't mint: ${r.error.split("\n")[0]}`);
      log(`faucet: ${Number(units) / 1e6} test USDC to ${to}`);
      return { ok: true, balance: (await chain.balance(to)).toString() };
    },
    /** SOL for the rent and network fees of a party's own accounts (its wallet and payment accounts). */
    "POST /api/gas": async (req, ctx) => {
      limits.gas.take(ctx.ip);
      const b = await body(req);
      const to = String(b.address ?? "");
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(to)) throw new HttpError(400, "not a Solana address");
      let lamports: bigint;
      try {
        lamports = BigInt(String(b.lamports ?? "0"));
      } catch {
        throw new HttpError(400, "lamports must be a whole number");
      }
      if (lamports <= 0n || lamports > MAX_GAS_LAMPORTS) throw new HttpError(400, `ask for between 0 and ${MAX_GAS_LAMPORTS} lamports`);
      if ((await lamportsOf(to as Address)) >= GAS_CEILING) throw new HttpError(400, "that address has enough SOL already");
      await cluster.fund(treasury, to as Address, lamports);
      return { ok: true };
    },
    "POST /api/verify": async (req, ctx) => {
      limits.open.take(ctx.ip);
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
    "POST /api/dev/advance": async (req, ctx) => {
      if (!cluster.advance) throw new HttpError(400, `${cluster.name}'s clock can't be moved: it keeps real time`);
      // Anyone at this machine may move a local cluster's clock; on a shared host, only an operator.
      if (!loopbackOnly) mustBeOperator(ctx);
      const seconds = Number((await body(req)).seconds);
      if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_ADVANCE_SECONDS) throw new HttpError(400, "seconds must be between 0 and 400 days");
      await cluster.advance(Math.floor(seconds));
      return { now: Number(await chain.now()) };
    },
    /** The processor's transparency log, which anyone may check (design §9). */
    "GET /api/log": async () => {
      const snap = processor.log.snapshot();
      return { did: ids.processor.did, log: snap, check: await verifyLog(snap.entries, snap.head, ids.processor.did, clock) };
    },

    // ------------------------------------------------------------ operators
    "GET /api/operator": async (_req, ctx) => ({ operator: ctx.operator, setupNeeded: !!operators.setupCode, operators: ctx.operator ? [...operators.dids] : undefined }),
    "POST /api/operator/challenge": async (_req, ctx) => {
      limits.open.take(ctx.ip);
      return operators.challenge();
    },
    "POST /api/operator/login": async (req, ctx) => {
      limits.open.take(ctx.ip);
      const b = await body(req);
      const r = await operators.login(b.proof as OperatorProof, b.setupCode === undefined ? undefined : String(b.setupCode));
      ctx.setCookie(sessionCookie(r.session, SESSION_TTL_MS, secure));
      log(`operator signed in: ${r.did}`);
      return { operator: r.did, expires: new Date(r.expires).toISOString() };
    },
    "POST /api/operator/logout": async (req, ctx) => {
      operators.logout(req.headers.cookie);
      ctx.setCookie(sessionCookie("", 0, secure));
      return { ok: true };
    },
    "POST /api/operator/add": async (req, ctx) => {
      mustBeOperator(ctx);
      operators.add(String((await body(req)).did ?? "").trim());
      return { operators: [...operators.dids] };
    },
    "POST /api/operator/remove": async (req, ctx) => {
      const me = mustBeOperator(ctx);
      operators.remove(String((await body(req)).did ?? ""), me);
      return { operators: [...operators.dids] };
    },

    "GET /api/processor": async (_req, ctx) => {
      mustBeOperator(ctx);
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
    "GET /api/arbiter": async (_req, ctx) => {
      mustBeOperator(ctx);
      const list = cases();
      const withEscrow = list.filter((c) => c.escrow);
      const read = await chain.escrows(withEscrow.map((c) => c.escrow!));
      const byEscrow = new Map(withEscrow.map((c, i) => [c.escrow, read[i]]));
      const states = list.map((c) => (c.escrow ? (byEscrow.get(c.escrow) ?? null) : null));
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
    "POST /api/arbiter/rule": async (req, ctx) => {
      const by = mustBeOperator(ctx);
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
      log(`ruling on ${id} by operator ${by}`);
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
      const headers: Record<string, string | string[]> = { "content-type": "application/json", "cache-control": "no-store" };
      try {
        if (!route) throw new HttpError(404, "no such endpoint");
        if (req.method === "POST") {
          // No cross-site requests: a form on another site can't send JSON, and a script there sends its Origin.
          if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "send JSON");
          const origin = req.headers.origin;
          const sameSite = (() => {
            try {
              return new URL(String(origin)).host === req.headers.host;
            } catch {
              return false;
            }
          })();
          if (origin && !sameSite) throw new HttpError(403, "cross-site request refused");
        }
        const ctx: Ctx = { ip: req.socket.remoteAddress ?? "?", operator: operators.whoIs(req.headers.cookie), setCookie: (c) => (headers["set-cookie"] = c) };
        const out = await route(req, ctx);
        res.writeHead(200, headers).end(JSON.stringify(out));
      } catch (e) {
        const status = e instanceof HttpError ? e.status : e instanceof OperatorError ? 403 : 500;
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
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(opts.port ?? 0, host, () => resolve()));
  const port = (server.address() as { port: number }).port;
  // Passkeys need a domain, not an IP address, so the app is used at http://localhost. On this machine only,
  // "localhost" can mean ::1 as well as 127.0.0.1: answer on both, so it never reaches another server.
  let server6: Server | undefined;
  if (loopbackOnly && host !== "::1") {
    const s6 = createServer((req, res) => server.emit("request", req, res));
    s6.on("upgrade", (...a) => server.emit("upgrade", ...a));
    const ok = await new Promise<boolean>((resolve) => s6.once("error", () => resolve(false)).listen(port, "::1", () => resolve(true)));
    if (ok) server6 = s6;
    else log(`couldn't also listen on [::1]:${port}; if http://localhost:${port} doesn't open Settle, use http://127.0.0.1:${port} (passkeys won't work there)`);
  }
  const appUrl = loopbackOnly ? `http://localhost:${port}` : `http://${publicHost}:${port}`;

  return {
    // The API's address. The app's (for people, and for passkeys) is appUrl.
    url: `http://${host.includes(":") ? `[${host}]` : host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`,
    appUrl,
    config,
    chain,
    cluster,
    dataDir: data.dir,
    relay,
    operators,
    processor,
    arbiter,
    verifier: ids.verifier,
    mintTo: async (to, units) => {
      const r = await chain.mintTo(mint, to, treasury, units);
      if (!r.ok) throw new Error(r.error);
    },
    close: async () => {
      clearInterval(feePayerTimer);
      processor.stop();
      arbiter.stop();
      agentsSaver.stop();
      peopleSaver.stop();
      await vite?.close();
      for (const s of [server, server6]) {
        if (!s) continue;
        await new Promise<void>((resolve) => s.close(() => resolve()));
        s.closeAllConnections?.();
      }
      await cluster.close();
      await relay.close();
    },
  };
}
