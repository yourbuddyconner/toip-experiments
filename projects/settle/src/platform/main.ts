/**
 * Runs a Settle network and its web app.
 *
 *   npm run settle                                   # a local cluster, kept in projects/settle/.data/local
 *   npm run app --workspace @zk-toip/settle -- --static          # the built app (npm run build:web first)
 *   npm run app --workspace @zk-toip/settle -- --cluster devnet  # on Solana devnet (npm run deploy first)
 *   npm run app --workspace @zk-toip/settle -- --fresh           # forget everything and start a new network
 *
 * Environment: PORT, RELAY_PORT, RPC_PORT, HOST (default 127.0.0.1), PUBLIC_HOST, SETTLE_DATA, SETTLE_PROGRAM_ID.
 */
import { rmSync } from "node:fs";
import type { Address } from "@solana/kit";
import { startPlatform } from "./platform";
import { dataDirFor, flag, has } from "./main-args";

const port = (env: string, fallback: number) => Number(process.env[env] ?? fallback);
const cluster = flag("cluster") ?? process.env.SETTLE_CLUSTER ?? "local";
const dataDir = dataDirFor(cluster);
if (has("fresh")) rmSync(dataDir, { recursive: true, force: true });

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

let platform: Awaited<ReturnType<typeof startPlatform>>;
try {
  platform = await startPlatform({
    // Away from the ports the rest of this repository (8787) and a solana-test-validator (8899) use.
    port: port("PORT", 4300),
    relayPort: port("RELAY_PORT", 4301),
    rpcPort: port("RPC_PORT", 4302),
    host: process.env.HOST,
    publicHost: process.env.PUBLIC_HOST,
    web: has("static") ? "static" : "dev",
    dataDir,
    cluster,
    programId: process.env.SETTLE_PROGRAM_ID as Address | undefined,
    log: has("quiet") ? undefined : (l) => console.log(`${dim(new Date().toISOString().slice(11, 19))} ${l}`),
  });
} catch (e) {
  console.error(`\n  ${bold("Settle couldn't start")}: ${(e as Error).message}\n`);
  process.exit(1);
}

const setup = platform.operators.setupCode;
console.log(`
  ${bold("Settle is running")} on ${platform.config.cluster === "local" ? "a local cluster" : platform.config.cluster}

  App            ${platform.appUrl}
  Operator view  ${platform.appUrl}/console${setup ? `\n                 ${bold("First operator:")} open ${platform.appUrl}/console?setup=${setup}` : ""}
  Solana RPC     ${platform.config.rpcUrl}   (program ${platform.config.programId})
  TSP relay      ${platform.config.relayUrl}
  Data           ${platform.dataDir}${has("fresh") ? "  (started fresh)" : ""}

  Open the app in two browser windows (or one normal, one private) to be two different people.
`);

const stop = async () => {
  await platform.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
