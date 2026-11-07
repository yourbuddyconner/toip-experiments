/**
 * The chain a platform runs on: its own local cluster (LiteSVM behind JSON-RPC, kept in the data
 * directory), or a real Solana cluster such as devnet, reached at an RPC URL.
 *
 * On a real cluster nothing is free: the platform's treasury key must hold SOL. It pays for setup (the
 * test-USDC mint, the processor's fee account), tops up the processor's fee payer, and runs the gas
 * station that gives parties the little SOL their own accounts need.
 */
import { createKeyPairSignerFromBytes, type Address, type KeyPairSigner } from "@solana/kit";
import { readFileSync } from "node:fs";
import { Chain } from "../chain/chain";
import { PROGRAM_KEYPAIR } from "../chain/simnet";
import { startChainServer, type ChainServer } from "../chain/rpcServer";

export const LAMPORTS_PER_SOL = 1_000_000_000n;
/** On a real cluster, a reading of the chain's clock is reused for this long (it moves with the wall clock). */
export const REAL_CLOCK_CACHE_MS = 3000;

export const CLUSTERS: Record<string, string> = {
  devnet: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
  localnet: "http://127.0.0.1:8899",
};

export interface ClusterOptions {
  /** "local" (the default) runs a cluster in-process; anything else is an RPC URL or a cluster name (devnet, localnet). */
  cluster?: string;
  /** The deployed Settle program; defaults to the address of the development keypair in program/keys. */
  programId?: Address;
  rpcPort?: number;
  host?: string;
  /** Where the local cluster keeps its state. */
  snapshot?: string;
}

export interface Cluster {
  /** "local", "devnet", or the RPC URL. */
  name: string;
  local: boolean;
  rpcUrl: string;
  chain: Chain;
  /** Sends SOL from the treasury (on a local cluster, from thin air). */
  fund(treasury: KeyPairSigner, to: Address, lamports: bigint): Promise<void>;
  /** Moves the clock forward. Only a local cluster can. */
  advance?(seconds: number): Promise<void>;
  close(): Promise<void>;
}

export async function developmentProgramId(): Promise<Address> {
  return (await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(PROGRAM_KEYPAIR, "utf8"))))).address;
}

export async function openCluster(o: ClusterOptions): Promise<Cluster> {
  const which = o.cluster ?? "local";
  if (which === "local") {
    const server: ChainServer = await startChainServer({ port: o.rpcPort ?? 0, host: o.host, snapshot: o.snapshot, realTime: true });
    const chain = await Chain.connect(server.url);
    return {
      name: "local",
      local: true,
      rpcUrl: server.url,
      chain,
      fund: (_treasury, to, lamports) => chain.airdropLamports(to, lamports),
      advance: (seconds) => chain.advanceClock(seconds),
      close: () => server.close(),
    };
  }
  const rpcUrl = CLUSTERS[which] ?? which;
  if (!/^https?:\/\//.test(rpcUrl)) throw new Error(`unknown cluster "${which}": use local, devnet, localnet or an RPC URL`);
  const programId = o.programId ?? (await developmentProgramId());
  const chain = await Chain.connect(rpcUrl, programId, { clockCacheMs: REAL_CLOCK_CACHE_MS });
  const program = await chain.rpc.getAccountInfo(programId, { encoding: "base64", commitment: "confirmed" }).send();
  if (!program.value?.executable) {
    throw new Error(`the Settle program isn't deployed on ${which} at ${programId}. Deploy it with: npm run deploy --workspace @toip-tools/settle -- --cluster ${which}`);
  }
  return {
    name: CLUSTERS[which] ? which : rpcUrl,
    local: false,
    rpcUrl,
    chain,
    fund: async (treasury, to, lamports) => {
      const r = await chain.transferSol(treasury, to, lamports);
      if (!r.ok) throw new Error(`the treasury couldn't send SOL: ${r.error.split("\n")[0]}`);
    },
    close: async () => {},
  };
}
