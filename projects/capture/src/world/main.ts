/**
 * npm run app --workspace @toip-tools/capture   (or npm run capture at the repository root)
 *
 * Environment:
 *   CAPTURE_PORT=4350        the web app and API; the witnesses use the next three ports
 *   CAPTURE_HOST=127.0.0.1   where to listen (0.0.0.0 serves the network, for a tunnel)
 *   CAPTURE_DATA=…           where the world keeps its state (default projects/capture/.data)
 *   CAPTURE_DRAND=live|dev   public drand quicknet (default; falls back to dev when offline) or a local beacon
 *   CAPTURE_WEB=dev|static   Vite with hot reload (default), or the built app in web/dist
 *   CAPTURE_SENSOR_MS=5000   the built-in sensors' reading interval
 */
import { join } from "node:path";
import { startWorld } from "./world";

const env = process.env;
const world = await startWorld({
  port: Number(env.CAPTURE_PORT ?? 4350),
  host: env.CAPTURE_HOST ?? "127.0.0.1",
  dataDir: env.CAPTURE_DATA ?? join(import.meta.dirname, "..", "..", ".data"),
  drand: env.CAPTURE_DRAND === "dev" ? "dev" : "live",
  web: env.CAPTURE_WEB === "static" ? "static" : "dev",
  sensorIntervalMs: Number(env.CAPTURE_SENSOR_MS ?? 5000),
  log: (l) => console.log(`  \x1b[2m${new Date().toISOString().slice(11, 19)}\x1b[0m ${l}`),
});

const u = world.appUrl;
console.log(`
  \x1b[1mCapture\x1b[0m is running. Open these in a browser on this machine:

    Camera          ${u}/camera
    Editor          ${u}/edit
    Verifier        ${u}/verify
    Sensors         ${u}/sensors
    Owner           ${u}/owner

  Witnesses       ${world.witnessUrls.join("  ")}
  Time beacon     ${world.drand.mode === "live" ? "drand quicknet (public)" : "local development beacon (offline)"}
  Data            ${world.dataDir}

  Another sensor: npm run sensor --workspace @toip-tools/capture -- --name "Harbor 1"
  Stop with Ctrl-C.
`);

const stop = async () => {
  await world.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
