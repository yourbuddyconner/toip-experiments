/**
 * Trail, narrated: the ten steps of the design's demo (§15) in the terminal, over real HTTP witnesses.
 *
 *   npm run demo --workspace @zk-toip/trail
 *
 * Step 10 runs KERIpy when KERIPY_PYTHON (or ~/.cache/zk-toip-keripy/venv) has it, and says so when it doesn't.
 */
import { STEPS, runNext } from "./steps";
import { World } from "./world";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const TONE: Record<string, string> = { ok: "\x1b[32m", bad: "\x1b[31m", warn: "\x1b[33m", info: "", dim: "\x1b[2m" };
const MARK: Record<string, string> = { ok: "✓", bad: "✗", warn: "!", info: " ", dim: " " };

const world = await World.open();
let failed = false;
try {
  console.log(`\n${bold("Trail")}: verifiable audit trails on KERI key event logs`);
  console.log(dim(`Witnesses 1-4 at ${world.witnesses.map((w) => w.url).join(", ")}; Scout uses 1, 2 and 3 at first.`));
  for (const def of STEPS) {
    const r = await runNext(world);
    const title = `${r.n}. ${r.title}${r.redTeam ? "  [red team]" : ""}`;
    console.log(`\n${bold(title)}\n${dim(def.summary)}`);
    for (const l of r.lines) {
      const tone = l.tone ?? "info";
      console.log(`  ${TONE[tone]}${MARK[tone]}\x1b[0m ${bold(l.who.padEnd(20))} ${TONE[tone]}${l.text}\x1b[0m`);
    }
  }
  console.log(`\n${dim("Run the explorer to see the same story: npm run trail")}\n`);
} catch (e) {
  failed = true;
  console.error(`\n\x1b[31mThe demo stopped: ${(e as Error).stack ?? e}\x1b[0m\n`);
} finally {
  await world.close();
}
process.exit(failed ? 1 : 0);
