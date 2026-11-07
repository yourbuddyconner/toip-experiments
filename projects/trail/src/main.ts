/**
 * Runs the Trail service and its explorer.
 *
 *   npm run trail                                         # from the repository root
 *   npm run app --workspace @zk-toip/trail -- --fresh     # forget everything and start the demo over
 *   npm run app --workspace @zk-toip/trail -- --static    # the built explorer (npm run build:web first)
 *
 * Environment: TRAIL_PORT (default 4340), TRAIL_WITNESS_PORT (witness 1; the others follow, default 4341-4344),
 * HOST (default 127.0.0.1), TRAIL_DATA (default projects/trail/.data).
 */
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startService } from "./service";

const has = (f: string) => process.argv.includes(`--${f}`);
const port = Number(process.env.TRAIL_PORT ?? 4340);
const w1 = Number(process.env.TRAIL_WITNESS_PORT ?? port + 1);
const dataDir = process.env.TRAIL_DATA ?? fileURLToPath(new URL("../.data", import.meta.url));
if (has("fresh")) rmSync(dataDir, { recursive: true, force: true });

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

let service: Awaited<ReturnType<typeof startService>>;
try {
  service = await startService({
    port,
    host: process.env.HOST,
    witnessPorts: [w1, w1 + 1, w1 + 2, w1 + 3],
    dataDir,
    web: has("static") ? "static" : "dev",
    log: has("quiet") ? undefined : (l) => console.log(`${dim(new Date().toISOString().slice(11, 19))} ${l}`),
  });
} catch (e) {
  console.error(`\n  ${bold("Trail couldn't start")}: ${(e as Error).message}\n`);
  process.exit(1);
}

const world = service.world();
console.log(`
  ${bold("Trail is running")}

  Explorer     ${service.appUrl}
  API          ${service.url}/api/state
${world.witnesses.map((w) => `  ${w.name}    ${w.url}   (also ${service.appUrl}/w/${w.n})${w.n === 4 ? "  joins at step 6" : ""}`).join("\n")}
  Data         ${dataDir}${has("fresh") ? "  (started fresh)" : ""}

  The demo is at step ${world.state.progress} of 10. Run the steps from the explorer's Demo page.
`);

const stop = async () => {
  await service.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
