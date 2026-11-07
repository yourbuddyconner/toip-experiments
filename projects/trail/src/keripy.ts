/**
 * Step 10: hand our KELs to KERIpy and compare the key state it computes with ours.
 * Uses KERIPY_PYTHON, or the venv the library's interop tests use. Skips, and says so, when neither has KERIpy.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { toStream, verifyKel, type SignedMessage } from "@toip-tools/eventlog";
import type { KeripyOutcome } from "./world";

export const KERIPY_SCRIPT = fileURLToPath(new URL("../../../packages/eventlog/interop/keripy_check.py", import.meta.url));
const DEFAULT_VENV = join(homedir(), ".cache", "zk-toip-keripy", "venv", "bin", "python");

export function findKeripy(env: NodeJS.ProcessEnv = process.env): { python?: string; reason?: string } {
  const candidates = [env.KERIPY_PYTHON, DEFAULT_VENV].filter((x): x is string => !!x);
  for (const python of candidates) {
    if (!existsSync(python)) continue;
    const r = spawnSync(python, ["-I", "-c", "import keri, sys; sys.stdout.write(keri.__version__)"], { encoding: "utf8" });
    if (r.status === 0) return { python: `${python} (keri ${r.stdout.trim()})` };
  }
  return { reason: `no Python with KERIpy found (set KERIPY_PYTHON, or create ${DEFAULT_VENV} with keri 1.3.x)` };
}

export async function checkWithKeripy(logs: { label: string; messages: SignedMessage[] }[], env: NodeJS.ProcessEnv = process.env): Promise<KeripyOutcome> {
  const found = findKeripy(env);
  if (!found.python) return { ran: false, reason: found.reason };
  const python = found.python.replace(/ \(keri .*\)$/, "");
  const stream = logs.map((l) => toStream(l.messages)).join("");
  const r = spawnSync(python, ["-I", KERIPY_SCRIPT], { input: stream, encoding: "utf8" });
  if (r.status !== 0) return { ran: false, python: found.python, reason: `keripy_check.py failed: ${r.stderr.trim().split("\n").pop()}` };
  const theirsAll = JSON.parse(r.stdout.trim().split("\n").pop()!) as Record<string, Record<string, unknown>>;
  const matches: NonNullable<KeripyOutcome["matches"]> = [];
  for (const l of logs) {
    const kel = await verifyKel(l.messages);
    const st = kel.latest;
    const ours = { i: kel.aid, s: st.sn, d: st.said, kt: st.kt.toString(16), k: st.keys, nt: st.nt.toString(16), n: st.next, bt: st.bt.toString(16), b: st.witnesses };
    const theirs = theirsAll[kel.aid];
    const differences: string[] = [];
    if (!theirs) differences.push("KERIpy did not accept this KEL");
    else for (const [k, v] of Object.entries(ours)) if (JSON.stringify(theirs[k]) !== JSON.stringify(v)) differences.push(k);
    matches.push({ aid: kel.aid, label: l.label, ok: differences.length === 0, ours, ...(theirs ? { theirs } : {}), differences });
  }
  return { ran: true, python: found.python, matches };
}
