/**
 * A local Solana cluster: LiteSVM behind a subset of the standard Solana JSON-RPC API, so the same
 * client code talks to it, to devnet, or to mainnet by changing a URL. Node only.
 *
 * Standard methods: getLatestBlockhash, sendTransaction, simulateTransaction, getAccountInfo,
 * getSignatureStatuses, getBalance, getSlot, getBlockTime, getMinimumBalanceForRentExemption, requestAirdrop, getHealth, getVersion.
 * Development methods: settle_info (program id), settle_advanceClock (move chain time forward).
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { getBase58Decoder, getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder, lamports, type Address, type Transaction } from "@solana/kit";
import { FailedTransactionMetadata, LiteSVM } from "litesvm";
import { Simnet } from "./simnet";

export interface ChainServer {
  url: string;
  net: Simnet;
  close(): Promise<void>;
}

type RpcError = { code: number; message: string; data?: unknown };
const toB64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

export interface ChainServerOptions {
  port: number;
  host?: string;
  /** A file to keep the chain in: loaded at start if it exists, saved as it changes and on close. */
  snapshot?: string;
  /** Where the clock starts (ms), for a chain that doesn't follow real time. */
  startTime?: number;
  /** The clock follows real time, as on a real cluster, plus however far it's been skipped ahead. */
  realTime?: boolean;
}

export async function startChainServer(opts: ChainServerOptions): Promise<ChainServer> {
  const svm = opts.snapshot && existsSync(opts.snapshot) ? LiteSVM.loadFromFile(opts.snapshot) : undefined;
  const metaFile = opts.snapshot ? `${opts.snapshot}.json` : undefined;
  const meta: { offset: number } = metaFile && svm && existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, "utf8")) : { offset: 0 };
  // Blockhashes behave as on a real cluster: a new one every ~400 ms, any of the last 150 accepted.
  // LiteSVM itself accepts only the latest, so the server checks recency and LiteSVM's check is off.
  const net = await Simnet.create({ svm, blockhashCheck: false });
  const recent: string[] = [net.svm.latestBlockhash()];
  let lastAdvance = Date.now();
  const advanceBlockhash = () => {
    net.svm.expireBlockhash();
    recent.push(net.svm.latestBlockhash());
    if (recent.length > 150) recent.shift();
    lastAdvance = Date.now();
  };
  const currentBlockhash = () => {
    if (Date.now() - lastAdvance > 400) advanceBlockhash();
    return recent.at(-1)!;
  };
  if (!svm) net.setNow(BigInt(Math.floor((opts.startTime ?? Date.now()) / 1000)));
  /** Real-time clock: chain time is wall time plus `meta.offset` seconds, and never goes backwards. */
  const tickClock = () => {
    if (!opts.realTime) return;
    const target = BigInt(Math.floor(Date.now() / 1000) + meta.offset);
    if (target > net.now()) net.setNow(target);
  };
  tickClock();
  let dirty = false;
  const save = () => {
    if (opts.snapshot && dirty) {
      net.svm.saveToFile(`${opts.snapshot}.tmp`);
      renameSync(`${opts.snapshot}.tmp`, opts.snapshot);
      writeFileSync(metaFile!, JSON.stringify(meta));
      dirty = false;
    }
  };
  const saver = setInterval(save, 2000);
  saver.unref();
  /** Signatures this node has processed, so clients can confirm them as on a real cluster. Everything here is final at once. */
  const seen = new Map<string, number>();
  const remember = (sig: string) => {
    seen.set(sig, Number(net.svm.getClock().slot));
    if (seen.size > 20_000) seen.delete(seen.keys().next().value!);
    return sig;
  };

  const methods: Record<string, (params: unknown[]) => unknown> = {
    getHealth: () => "ok",
    getVersion: () => ({ "solana-core": "settle-simnet (LiteSVM)", "feature-set": 0 }),
    settle_info: () => ({ programId: net.programId }),
    getSlot: () => Number(net.svm.getClock().slot),
    getBlockTime: () => Number(net.svm.getClock().unixTimestamp),
    getLatestBlockhash: () => {
      const slot = Number(net.svm.getClock().slot);
      return { context: { slot }, value: { blockhash: currentBlockhash(), lastValidBlockHeight: slot + 150 } };
    },
    getMinimumBalanceForRentExemption: ([len]) => Number(net.svm.minimumBalanceForRentExemption(BigInt(Number(len)))),
    getBalance: ([addr]) => {
      const a = net.svm.getAccount(addr as Address);
      return { context: { slot: Number(net.svm.getClock().slot) }, value: a.exists ? Number(a.lamports) : 0 };
    },
    getAccountInfo: ([addr]) => {
      const a = net.svm.getAccount(addr as Address);
      const slot = Number(net.svm.getClock().slot);
      if (!a.exists) return { context: { slot }, value: null };
      return {
        context: { slot },
        value: { data: [toB64(a.data), "base64"], executable: a.executable, lamports: Number(a.lamports), owner: a.programAddress, rentEpoch: 0, space: a.data.length },
      };
    },
    requestAirdrop: ([addr, amount]) => {
      // LiteSVM airdrops are transactions: the same one twice under one blockhash is refused as already
      // processed. Move the blockhash on and try again, and never report an airdrop that didn't happen.
      let r = net.svm.airdrop(addr as Address, lamports(BigInt(Number(amount))));
      if (r instanceof FailedTransactionMetadata) {
        advanceBlockhash();
        r = net.svm.airdrop(addr as Address, lamports(BigInt(Number(amount))));
      }
      if (r instanceof FailedTransactionMetadata || r === null) throw { code: -32603, message: `airdrop failed: ${r?.toString() ?? "unknown"}` } satisfies RpcError;
      dirty = true;
      return remember(`airdrop-${crypto.randomUUID()}`);
    },
    settle_advanceClock: ([seconds]) => {
      meta.offset += Number(seconds);
      net.setNow(net.now() + BigInt(Number(seconds)));
      advanceBlockhash();
      dirty = true;
      return { unixTimestamp: Number(net.now()) };
    },
    getSignatureStatuses: ([sigs]) => ({
      context: { slot: Number(net.svm.getClock().slot) },
      value: (sigs as string[]).map((s) => (seen.has(s) ? { slot: seen.get(s)!, confirmations: null, err: null, status: { Ok: null }, confirmationStatus: "finalized" } : null)),
    }),
    sendTransaction: ([wire]) => submit(String(wire), false),
    simulateTransaction: ([wire]) => submit(String(wire), true),
  };

  function submit(wire: string, simulate: boolean): unknown {
    let tx: Transaction;
    try {
      tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire)) as Transaction;
    } catch {
      throw { code: -32602, message: "invalid transaction encoding" } satisfies RpcError;
    }
    const lifetime = (getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as { lifetimeToken: string }).lifetimeToken;
    if (!recent.includes(lifetime)) throw { code: -32002, message: "Transaction failed: BlockhashNotFound" } satisfies RpcError;
    if (simulate) {
      const r = net.svm.simulateTransaction(tx as Parameters<LiteSVM["simulateTransaction"]>[0]);
      const failed = r instanceof FailedTransactionMetadata;
      return { context: { slot: 0 }, value: { err: failed ? r.toString() : null, logs: failed ? r.meta().logs() : r.meta().logs() } };
    }
    const r = net.svm.sendTransaction(tx as Parameters<LiteSVM["sendTransaction"]>[0]);
    if (r instanceof FailedTransactionMetadata) {
      throw { code: -32002, message: `Transaction failed: ${r.toString()}`, data: { logs: r.meta().logs(), err: r.toString() } } satisfies RpcError;
    }
    dirty = true;
    return remember(getBase58Decoder().decode(r.signature()));
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type, solana-client");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    if (req.method === "OPTIONS") return void res.writeHead(204).end();
    if (req.method !== "POST") return void res.writeHead(405).end();
    let body = "";
    for await (const chunk of req) body += chunk;
    tickClock();
    const handle = (call: { id?: unknown; method?: string; params?: unknown[] }) => {
      const fn = methods[call.method ?? ""];
      if (!fn) return { jsonrpc: "2.0", id: call.id ?? null, error: { code: -32601, message: `method not found: ${call.method}` } };
      try {
        return { jsonrpc: "2.0", id: call.id ?? null, result: fn(call.params ?? []) };
      } catch (e) {
        const err = (e as RpcError).code ? (e as RpcError) : { code: -32603, message: String((e as Error)?.message ?? e) };
        return { jsonrpc: "2.0", id: call.id ?? null, error: err };
      }
    };
    let out: unknown;
    try {
      const parsed = JSON.parse(body);
      out = Array.isArray(parsed) ? parsed.map(handle) : handle(parsed);
    } catch {
      out = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } };
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
  });
  await new Promise<void>((resolve) => server.listen(opts.port, opts.host ?? "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://${opts.host ?? "127.0.0.1"}:${port}`,
    net,
    close: async () => {
      clearInterval(saver);
      save();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
