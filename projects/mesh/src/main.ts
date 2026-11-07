/**
 * Starts the visualizer.
 *
 *   npm run app --workspace @zk-toip/mesh              # Vite, with hot reload
 *   npm run app --workspace @zk-toip/mesh -- --static  # the built app (npm run build:web first)
 *
 * Environment: PORT (default 4360), HOST (default 127.0.0.1).
 */
import { startApp } from "./server";

const has = (f: string) => process.argv.includes(`--${f}`);
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

try {
  const app = await startApp({
    port: Number(process.env.PORT ?? 4360),
    host: process.env.HOST,
    web: has("static") ? "static" : "dev",
    log: (l) => console.log(`\x1b[2m${new Date().toISOString().slice(11, 19)}\x1b[0m ${l}`),
  });
  console.log(`\n  ${bold("Mesh field simulator")}  ${app.appUrl}\n\n  Run an act from the page. Ctrl-C stops the server.\n`);
  const stop = async () => {
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} catch (e) {
  console.error(`\n  ${bold("The visualizer couldn't start")}: ${(e as Error).message}\n`);
  process.exit(1);
}
