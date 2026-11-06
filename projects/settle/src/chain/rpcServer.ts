/**
 * A local Solana cluster: LiteSVM behind a subset of the standard Solana JSON-RPC API, so the same
 * client code talks to it, to devnet, or to mainnet by changing a URL. Node only.
 *
 * Standard methods: getLatestBlockhash, sendTransaction, simulateTransaction, getAccountInfo,
 * getBalance, getSlot, getBlockTime, getMinimumBalanceForRentExemption, requestAirdrop, getHealth, getVersion.
 * Development methods: settle_info (program id), settle_advanceClock (move chain time forward).
 */
import { existsSync } from "node:fs";
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

export async function startChainServer(opts: { port: number; host?: string; snapshot?: string; startTime?: number }): Promise<ChainServer> {
  const svm = opts.snapshot && existsSync(opts.snapshot) ? LiteSVM.loadFromFile(opts.snapshot) : undefined;
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
  let dirty = false;
  const save = () => {
    if (opts.snapshot && dirty) {
      net.svm.saveToFile(opts.snapshot);
      dirty = false;
    }
  };
  const saver = setInterval(save, 2000);
  saver.unref();

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
      net.svm.airdrop(addr as Address, lamports(BigInt(Number(amount))));
      dirty = true;
      return `airdrop${Date.now()}`;
    },
    settle_advanceClock: ([seconds]) => {
      net.setNow(net.now() + BigInt(Number(seconds)));
      advanceBlockhash();
      dirty = true;
      return { unixTimestamp: Number(net.now()) };
    },
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
    return getBase58Decoder().decode(r.signature());
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type, solana-client");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    if (req.method === "OPTIONS") return void res.writeHead(204).end();
    if (req.method !== "POST") return void res.writeHead(405).end();
    let body = "";
    for await (const chunk of req) body += chunk;
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
