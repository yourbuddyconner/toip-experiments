// Starts the relay and the Shared To-Do web app together, and stops both on Ctrl-C.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";

mkdirSync(".data", { recursive: true });
const procs = [
  ["relay", ["run", "start", "--workspace", "@toip-tools/relay"], { RELAY_DB: `${process.cwd()}/.data/relay.db`, PORT: process.env.RELAY_PORT ?? "8787" }],
  ["web", ["run", "dev", "--workspace", "@toip-tools/shared-todo"], {}],
].map(([name, args, env]) => {
  const p = spawn("npm", args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const tag = (chunk) =>
    String(chunk)
      .split("\n")
      .filter((l) => l.trim() && !l.includes("ExperimentalWarning") && !l.includes("--trace-warnings"))
      .forEach((l) => console.log(`[${name}] ${l}`));
  p.stdout.on("data", tag);
  p.stderr.on("data", tag);
  p.on("exit", (code) => {
    console.log(`[${name}] exited (${code})`);
    stop();
  });
  return p;
});
function stop() {
  for (const p of procs) if (p.exitCode === null) p.kill("SIGTERM");
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
