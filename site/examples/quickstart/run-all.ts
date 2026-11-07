// Runs the four quickstart steps in order. From site/: npm run quickstart
import { QUICKSTART, runExample } from "../../build/run-example";

for (const step of QUICKSTART) {
  console.log(`\n── ${step} ──`);
  const r = runExample(`examples/quickstart/${step}.ts`);
  process.stdout.write(r.stdout);
  if (!r.ok) {
    process.stderr.write(r.stderr);
    process.exit(1);
  }
}
