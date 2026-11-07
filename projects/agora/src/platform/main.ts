/**
 * Runs Agora locally: npm run agora (from the repository root).
 *
 *   npm run app --workspace @zk-toip/agora                # Vite dev server for the web app
 *   npm run app --workspace @zk-toip/agora -- --static    # the built app (npm run build:web first)
 *   npm run app --workspace @zk-toip/agora -- --fresh     # forget everything and start again
 *
 * Environment: AGORA_WEB_PORT (4320), AGORA_HOST_PORT (4321), AGORA_REGISTRAR_PORT (4322),
 * AGORA_RELAY_PORT (4323), AGORA_DATA (projects/agora/.data/local).
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { startPlatform, type Platform } from "./platform";

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(`--${f}`);
const port = (env: string, fallback: number) => Number(process.env[env] ?? fallback);
const dataDir = process.env.AGORA_DATA ?? join(import.meta.dirname, "..", "..", ".data", "local");
if (has("fresh")) rmSync(dataDir, { recursive: true, force: true });

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

let platform: Platform;
try {
  platform = await startPlatform({
    webPort: port("AGORA_WEB_PORT", 4320),
    hostPort: port("AGORA_HOST_PORT", 4321),
    registrarPort: port("AGORA_REGISTRAR_PORT", 4322),
    relayPort: port("AGORA_RELAY_PORT", 4323),
    web: has("static") ? "static" : "dev",
    dataDir,
    log: has("quiet") ? undefined : (l) => console.log(`${dim(new Date().toISOString().slice(11, 19))} ${l}`),
  });
} catch (e) {
  console.error(`\n  ${bold("Agora couldn't start")}: ${(e as Error).message}\n`);
  process.exit(1);
}

const w = platform.world;
console.log(`
  ${bold("Agora is running")}

  Web app        ${platform.appUrl}
  Forum host     ${platform.hostUrl}   ${dim(w.host.identity.did)}
  Registrars     ${platform.registrarUrl}
${w.issuers.map((i) => `                 ${i.kind.title.padEnd(30)} ${dim(i.did)}`).join("\n")}
  TSP relay      ${platform.relayUrl}
  Data           ${platform.dataDir}

  Open the web app in separate browser profiles (or private windows) to be different people.
`);

const stop = async () => {
  await platform.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
