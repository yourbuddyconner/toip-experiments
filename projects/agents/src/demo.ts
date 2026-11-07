/**
 * The demo, narrated in the terminal (design §14.3): about three minutes with live models, less scripted.
 *
 *   npm run demo --workspace @zk-toip/agents            # scripted models, no API key needed
 *   npm run demo --workspace @zk-toip/agents -- --live  # Claude, if credentials work; scripted otherwise
 *
 * Ports: 0 (free ports), so it never disturbs a running app.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorld, type World } from "./world";
import { usdc } from "./config";
import { checkCredentials, MODELS } from "./loop/anthropic";
import { ERRANDS_TASK_2 } from "./roles/prompts";
import { runStory } from "./story";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const colors: Record<string, string> = {
  "Conner Swann": "\x1b[33m",
  "Ops agent": "\x1b[36m",
  "Errands agent": "\x1b[35m",
  "Coder agent": "\x1b[34m",
  "Dana Ruiz": "\x1b[32m",
  "Demo CI": "\x1b[92m",
  QuickFix: "\x1b[31m",
};
const started = Date.now();
const clock = () => {
  const s = Math.floor((Date.now() - started) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const say = (who: string, text: string) => console.log(`  ${dim(clock().padStart(5))}  ${colors[who] ?? ""}${who.padEnd(14)}\x1b[0m ${text}`);
const step = (s: string) => console.log(`\n${bold("▸")} ${bold(s)}`);
const line = (s: string) => console.log(`    ${s}`);

let mode: "scripted" | "live" = "scripted";
if (process.argv.includes("--live")) {
  const c = await checkCredentials(MODELS.ops);
  if (c.ok) mode = "live";
  else console.log(`\n  ${bold("Live models aren't available")}: ${c.reason}. Using the scripted models instead.`);
}

console.log(bold("\nAgents: passports, mandates and audit trails, hiring on Settle"));
console.log(dim(`A local Settle network (LiteSVM), a TSP relay, the hub and its witness, the principal's console, CI, Dana, QuickFix, and three agents (${mode === "live" ? `Claude: ${MODELS.ops}, ${MODELS.coder}, ${MODELS.errands}` : "scripted models"}).`));

let world: World | undefined;
try {
  world = await createWorld({
    ports: { app: 0, hub: 0, settle: 0, relay: 0, rpc: 0 },
    mode,
    courier: "auto",
    log: (who, text) => say(who, text),
    onTurn: (who, t) => {
      for (const c of t.tools) if (c.name !== "inbox" || (Array.isArray(c.result) && c.result.length)) say(who, dim(`${c.name}(${brief(c.input)}) → ${brief(c.result)}`));
    },
  });
  await runStory(world, { step, line, say, errandsTask: ERRANDS_TASK_2 });

  step("3:00 · The end");
  const dir = mkdtempSync(join(tmpdir(), "agents-export-"));
  for (const a of [world.ops, world.errands, world.coder]) {
    const head = a.sink.trail.head();
    const receipts = await a.sink.controller.receiptCount({ logId: a.sink.trailId, s: head.s, d: head.d });
    const file = join(dir, `${a.name.replace(/\s/g, "-").toLowerCase()}.bundle.json`);
    writeFileSync(file, JSON.stringify(await a.sink.bundle(), null, 2));
    line(`${a.name.padEnd(14)} trail head #${head.s} ${dim(head.d.slice(0, 20) + "…")}, ${receipts} witness receipt(s) on the head`);
  }
  line(`Export bundles, verifiable offline: ${dir}`);
  line(dim(`Conner's wallet ${usdc(await world.conner.walletBalance())}; Ops agent ${usdc(await world.ops.party.walletBalance())}; Errands agent ${usdc(await world.errands.party.walletBalance())}.`));
  console.log(`\n${dim("Every payment above went through the guard, was decided against the whole mandate chain, witnessed before it moved, and checked again by the worker.")}\n`);
} catch (e) {
  console.error(`\n  ${bold("The demo stopped")}: ${(e as Error).stack ?? e}\n`);
  process.exitCode = 1;
} finally {
  await world?.close();
  process.exit(process.exitCode ?? 0);
}

function brief(v: unknown): string {
  const s = JSON.stringify(v) ?? "";
  return s.length > 110 ? `${s.slice(0, 107)}…` : s;
}
