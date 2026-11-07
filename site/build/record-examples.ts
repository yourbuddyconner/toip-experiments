// Runs the quickstart and the runnable snippets, and writes their real output next to them
// (examples/*/output/), where the pages read it. Run it after changing an example: npm run examples:record
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SITE_DIR } from "./config";
import { QUICKSTART, RUNNABLE_SNIPPETS, runExample } from "./run-example";

let failed = false;
function record(dir: string, name: string) {
  const outDir = join(SITE_DIR, "examples", dir, "output");
  mkdirSync(outDir, { recursive: true });
  const r = runExample(`examples/${dir}/${name}.ts`);
  if (!r.ok) {
    failed = true;
    console.error(`✗ ${dir}/${name}\n${r.stderr}`);
    return;
  }
  writeFileSync(join(outDir, `${name}.txt`), r.stdout);
  console.log(`✓ ${dir}/${name} (${r.ms} ms)`);
}

for (const step of QUICKSTART) record("quickstart", step);
for (const s of RUNNABLE_SNIPPETS) record("snippets", s);
if (failed) process.exit(1);
