// Runs one example file the way a reader would (tsx with the site's tsconfig paths), and captures its output.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { SITE_DIR } from "./config";

export const QUICKSTART = ["01-identities", "02-trust-task", "03-relay", "04-credentials"];
/** Snippets that run quickly and need nothing but Node. The others are typechecked only. */
export const RUNNABLE_SNIPPETS = ["trust-core", "relay", "cose", "mandates", "eventlog", "anon-membership"];

export function runExample(relPath: string): { ok: boolean; stdout: string; stderr: string; ms: number } {
  const t0 = Date.now();
  const tsx = join(SITE_DIR, "node_modules", ".bin", "tsx");
  const r = spawnSync(tsx, ["--tsconfig", join(SITE_DIR, "tsconfig.json"), join(SITE_DIR, relPath)], {
    cwd: SITE_DIR,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: (r.stderr ?? "") + (r.error ? String(r.error) : ""), ms: Date.now() - t0 };
}
