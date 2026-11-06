/**
 * Settle, narrated: the repair job twice on a local Solana chain (LiteSVM) and a real TSP relay.
 *
 *   npm run demo --workspace @zk-toip/settle
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelay } from "@zk-toip/relay";
import { STATE } from "./chain/escrow";
import { verifyLog, type LogEntry, type LogHead } from "./protocol/log";
import { PROCESSOR_LOG } from "./protocol/specs";
import { createWorld, USDC, type World } from "./world";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const colors: Record<string, string> = {
  Landlord: "\x1b[33m",
  "Joe (plumber)": "\x1b[36m",
  "Alice (tenant)": "\x1b[35m",
  "Settle Arbitration": "\x1b[31m",
  "Settle Processor": "\x1b[32m",
};
const usdc = (u: bigint) => `${(Number(u) / 1e6).toFixed(2)} USDC`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const pause = (ms = 120) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 10000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 15));
  }
};
function heading(s: string) {
  console.log(`\n${bold(s)}\n${dim("─".repeat(Math.min(s.length, 80)))}`);
}
function step(s: string) {
  console.log(`\n${bold("▸")} ${s}`);
}

async function run(title: string, play: (w: World, id: string) => Promise<void>) {
  heading(title);
  const relay = await startRelay({ port: 0, dbPath: join(mkdtempSync(join(tmpdir(), "settle-demo-")), "relay.db") });
  const w = await createWorld({
    relayUrl: relay.url,
    onEvent: (e) => console.log(`  ${dim(e.at.slice(5, 16).replace("T", " "))}  ${colors[e.who] ?? ""}${e.who.padEnd(19)}\x1b[0m ${e.text}`),
  });
  try {
    step("Joe sends the landlord an invoice, with his contractor license as a credential");
    const id = await w.joe.request(w.landlord.did, "Fix kitchen sink leak, Unit 4B", USDC(340));
    await until(() => w.landlord.requests.has(id));
    await pause();

    step("The landlord agrees terms: Alice attests, 7-day dispute window, Settle arbitrates, 1% processor fee");
    await w.landlord.proposeTerms(id, { attester: w.alice.did, disputeWindowDays: 7, feeBps: 100, feeAccount: w.processor.feeAccount, refundAfterDays: 30 });
    await w.landlord.fund(id, w.wallet);
    await until(() => !!w.joe.payments.get(id)?.escrow && !!w.alice.payments.get(id));
    await pause();
    await play(w, id);

    const escrow = w.landlord.payments.get(id)!.escrow!;
    const s = w.net.escrow(escrow)!;
    step("On-chain");
    console.log(`  escrow ${short(escrow)}  state ${s.state === STATE.resolved ? "resolved" : s.state === STATE.reclaimed ? "reclaimed" : "funded"}`);
    console.log(`  Joe's payment account       ${usdc(w.net.balance(w.joe.payments.get(id)!.terms!.payee.tokenAccount))}`);
    console.log(`  landlord's payment account  ${usdc(w.net.balance(w.landlord.tokenAccount(id)!))}`);
    console.log(`  processor's fee account     ${usdc(w.net.balance(w.processor.feeAccount))}`);

    step("What anyone watching the chain could see");
    console.log(`  payer key ${short(s.payer)}, payee key ${short(s.payee)}, arbiter key ${short(s.arbiter)}, ${usdc(s.amount)}, terms hash ${Buffer.from(s.termsHash).toString("hex").slice(0, 12)}…`);
    console.log(`  ${dim("No DIDs, names, purpose or evidence: those travelled only over TSP, sealed to the parties.")}`);

    step("Alice asks the processor for its transparency log, and checks it");
    const res = await w.alice.endpoint.request<Record<string, never>, { entries: LogEntry[]; head: LogHead }>(w.processor.did, PROCESSOR_LOG, {});
    for (const e of res.payload.entries) console.log(`  #${e.seq} ${e.kind.padEnd(9)} ${dim(e.hash.slice(0, 16) + "…")}`);
    const v = await verifyLog(res.payload.entries, res.payload.head, w.processor.did, w.clock);
    console.log(`  ${v.ok ? "\x1b[32m✓ hash chain intact, head signed by the processor\x1b[0m" : `\x1b[31m✗ ${v.problem}\x1b[0m`}`);
  } finally {
    w.stop();
    await relay.close();
  }
}

console.log(bold("\nSettle: conditional payments between parties who don't trust each other"));
console.log(dim("Local Solana chain (LiteSVM) running the real escrow program, real TSP over a local relay, test USDC."));

await run("1 · The job gets done", async (w, id) => {
  step("Joe fixes the leak. Alice, the tenant, attests it's done");
  await w.alice.attest(id, "complete", "Fixed. Dry under the sink for a day.");
  await pause();
  step("Joe asks to be paid straight away; the landlord's policy says wait");
  await w.joe.requestRelease(id);
  await until(() => w.landlord.events.some((e) => e.text.includes("not signing")));
  await pause();
  step("Eight days later: no dispute. Joe asks again");
  w.advance(8 * 86400);
  w.joe.payments.get(id)!.signed = [];
  await w.joe.requestRelease(id);
  await until(() => w.landlord.receipts.length === 1);
  await pause(200);
});

await run("2 · The job isn't done right", async (w, id) => {
  step("Alice reports it's still dripping; the landlord disputes");
  await w.alice.attest(id, "not-complete", "Still dripping under the sink.");
  await w.landlord.dispute(id, "Tenant reports the leak isn't fixed");
  await until(() => w.arbiter.payments.get(id)!.disputes.length === 1);
  await pause();
  step("Settle Arbitration reviews the signed evidence and rules a split");
  await w.arbiter.rule(id, USDC(200), "Pipe replaced, but the seal was left loose: 200 for the work done.");
  await until(() => w.landlord.payments.get(id)!.settled !== undefined);
  await pause(200);
});

console.log(`\n${dim("Neither the processor nor the arbiter could move the money alone: every payout above needed two of the three keys.")}\n`);
process.exit(0);
