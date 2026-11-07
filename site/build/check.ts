// npm run check: typechecks every example and snippet against the real packages, runs the quickstart
// and the runnable snippets, builds the site strictly (every spec documented, every design heading found)
// and checks its links.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { SITE_DIR } from "./config";
import { QUICKSTART, RUNNABLE_SNIPPETS, runExample } from "./run-example";

let failed = false;
const bin = (n: string) => join(SITE_DIR, "node_modules", ".bin", n);
const step = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` ${detail}` : ""}`);
  if (!ok) failed = true;
};

const tsc = spawnSync(bin("tsc"), ["-p", "tsconfig.json"], { cwd: SITE_DIR, encoding: "utf8" });
step("typecheck: examples, snippets and build scripts", tsc.status === 0);
if (tsc.status !== 0) console.log(tsc.stdout + tsc.stderr);

for (const s of QUICKSTART) {
  const r = runExample(`examples/quickstart/${s}.ts`);
  step(`quickstart ${s}`, r.ok, `(${r.ms} ms)`);
  if (!r.ok) console.log(r.stdout + r.stderr);
}
for (const s of RUNNABLE_SNIPPETS) {
  const r = runExample(`examples/snippets/${s}.ts`);
  step(`snippet ${s}`, r.ok, `(${r.ms} ms)`);
  if (!r.ok) console.log(r.stdout + r.stderr);
}

const build = spawnSync(bin("tsx"), ["build/build.ts"], { cwd: SITE_DIR, encoding: "utf8", env: { ...process.env, STRICT: "1" } });
step("build (strict)", build.status === 0);
if (build.status !== 0 || build.stderr) console.log(build.stdout + build.stderr);

const links = spawnSync(bin("tsx"), ["build/links.ts"], { cwd: SITE_DIR, encoding: "utf8" });
step("links", links.status === 0, links.stdout.split("\n")[0]);
if (links.status !== 0) console.log(links.stdout + links.stderr);

if (failed) process.exit(1);
console.log("\nAll checks passed.");
