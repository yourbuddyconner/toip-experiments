/**
 * Runs the Tipline demo: npm run tipline (or npm run app --workspace @toip-tools/tipline).
 *
 *   --no-build   serve web/dist as it is, without building it first
 *   --keep       keep state in projects/tipline/.data between runs (default: a fresh start each time)
 *
 * Environment: OUTLET_PORT (4310), INBOX_PORT (4311), ACME_PORT (4312), WALLET_PORT (4313),
 * RELAY_PORT (4314), TIPLINE_DATA (a data directory; implies --keep).
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { startPlatform, WEB_DIR } from "./platform";

const has = (f: string) => process.argv.includes(`--${f}`);
const port = (env: string, fallback: number) => Number(process.env[env] ?? fallback);
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

if (!has("no-build")) {
  console.log(dim("  building the web apps…"));
  const r = spawnSync("npx", ["vite", "build", "--config", join(WEB_DIR, "vite.config.ts"), "--logLevel", "warn"], { stdio: "inherit", cwd: join(WEB_DIR, "..") });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const dataDir = process.env.TIPLINE_DATA ?? (has("keep") ? join(import.meta.dirname, "..", "..", ".data") : undefined);
let platform: Awaited<ReturnType<typeof startPlatform>>;
try {
  platform = await startPlatform({
    ports: { outlet: port("OUTLET_PORT", 4310), inbox: port("INBOX_PORT", 4311), acme: port("ACME_PORT", 4312), wallet: port("WALLET_PORT", 4313), relay: port("RELAY_PORT", 4314) },
    dataDir,
    log: (l) => console.log(`${dim(new Date().toISOString().slice(11, 19))} ${l}`),
  });
} catch (e) {
  console.error(`\n  ${bold("Tipline couldn't start")}: ${(e as Error).message}\n`);
  process.exit(1);
}

const u = platform.urls;
console.log(`
  ${bold("Tipline is running")}  (a demo: Acme Chemicals, The Ledger, and the people between them)

  Acme HR console     ${u.acme}          roster, daily roots, the relay panel, Skip ahead
  Employee wallet     ${u.wallet}          make a wallet, enroll with Acme, get a membership code
  Sam's inbox         ${u.inbox}          set up the drop box, open a story, read tips, reply
  The Ledger          ${u.outlet}          the source app is at /tip/<drop box>; open it in a private window
  TSP relay           ${u.relay}     operated by Acme in this demo
  Data                ${platform.dataDir}

  Each app is its own origin, so one browser can play every part.
`);

const stop = async () => {
  await platform.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
