/**
 * Runs the whole world and the app: the principal's console and Dana's courier view.
 *
 *   npm run agents                                        # at the repository root
 *   npm run app --workspace @toip-tools/agents -- --live     # Claude, if credentials work
 *   npm run app --workspace @toip-tools/agents -- --static   # the built pages (npm run build:web first)
 *
 * Environment: AGENTS_PORT (4330), AGENTS_HUB_PORT (4331), AGENTS_SETTLE_PORT (4332), AGENTS_RELAY_PORT (4333),
 * AGENTS_RPC_PORT (4334), HOST (default 127.0.0.1).
 */
import { DEFAULT_PORTS } from "../config";
import { checkCredentials, MODELS } from "../loop/anthropic";
import { createWorld } from "../world";
import { startApp } from "./server";

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const port = (env: string, fallback: number) => Number(process.env[env] ?? fallback);
const has = (f: string) => process.argv.includes(`--${f}`);

let mode: "scripted" | "live" = "scripted";
let note = "scripted models (no API key needed)";
if (has("live")) {
  const c = await checkCredentials(MODELS.ops);
  if (c.ok) {
    mode = "live";
    note = `Claude: ${MODELS.ops} (Ops), ${MODELS.coder} (Coder), ${MODELS.errands} (Errands)`;
  } else note = `scripted models (live models unavailable: ${c.reason})`;
}

const ports = {
  app: port("AGENTS_PORT", DEFAULT_PORTS.app),
  hub: port("AGENTS_HUB_PORT", DEFAULT_PORTS.hub),
  settle: port("AGENTS_SETTLE_PORT", DEFAULT_PORTS.settle),
  relay: port("AGENTS_RELAY_PORT", DEFAULT_PORTS.relay),
  rpc: port("AGENTS_RPC_PORT", DEFAULT_PORTS.rpc),
};
const log = has("quiet") ? undefined : (who: string, text: string) => console.log(`${dim(new Date().toISOString().slice(11, 19))} ${who}: ${text}`);

let world: Awaited<ReturnType<typeof createWorld>>;
let app: Awaited<ReturnType<typeof startApp>>;
try {
  world = await createWorld({ ports, host: process.env.HOST, mode, courier: has("auto-courier") ? "auto" : "manual", ...(log ? { log } : {}) });
  app = await startApp(world, { port: ports.app, host: process.env.HOST, web: has("static") ? "static" : "dev" });
} catch (e) {
  console.error(`\n  ${bold("The agents app couldn't start")}: ${(e as Error).message}\n`);
  process.exit(1);
}

console.log(`
  ${bold("Agents is running")} with ${note}

  Principal's console   ${app.url}/
  Dana's courier view   ${app.url}/courier
  Hub                   ${world.hub.url}
  Settle API            ${world.platform.url}   (local cluster; relay ${world.platform.config.relayUrl})

  In the console: issue Ops agent's mandate, fund it, and give it the task. Open the courier view in a second
  window to be Dana. Everything is in memory: stopping the app starts a fresh world next time.
`);

const stop = async () => {
  await app.close();
  await world.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
