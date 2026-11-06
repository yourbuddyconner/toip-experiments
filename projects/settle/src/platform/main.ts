/**
 * Runs a local Settle network and its web app.
 *
 *   npm run app --workspace @zk-toip/settle            # with hot reload
 *   npm run app --workspace @zk-toip/settle -- --static # the built app (npm run build:web first)
 */
import { startPlatform } from "./platform";

const arg = (name: string) => process.argv.includes(`--${name}`);
const port = (env: string, fallback: number) => Number(process.env[env] ?? fallback);

const platform = await startPlatform({
  // Away from the ports the rest of this repository (8787) and a solana-test-validator (8899) use.
  port: port("PORT", 4300),
  relayPort: port("RELAY_PORT", 4301),
  rpcPort: port("RPC_PORT", 4302),
  web: arg("static") ? "static" : "dev",
  log: arg("quiet") ? undefined : (l) => console.log(`\x1b[2m${new Date().toISOString().slice(11, 19)}\x1b[0m ${l}`),
});

console.log(`
  \x1b[1mSettle is running\x1b[0m

  App            ${platform.url}
  Operator view  ${platform.url}/console
  Solana RPC     ${platform.config.rpcUrl}   (local cluster, program ${platform.config.programId})
  TSP relay      ${platform.config.relayUrl}

  Open the app in two browser windows (or one normal, one private) to be two different people.
`);

const stop = async () => {
  await platform.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
