/**
 * The demo, driven through a real browser (design §15, e2e): the principal's console and Dana's courier view,
 * over a whole world with scripted models. Conner issues, funds and tasks Ops agent, tests the guard with
 * QuickFix's quote, approves Errands agent's payment to Dana, confirms the delivery, reviews the trails and
 * revokes the sub-agent. Dana quotes and delivers in her own window.
 *
 *   npm run e2e --workspace @toip-tools/agents             # Vite dev server
 *   npm run e2e --workspace @toip-tools/agents -- --static # the built pages (npm run build:web first)
 *   add --headed to watch
 *
 * Screenshots land in web/e2e-shots/.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { createWorld, type World } from "../src/world";
import { startApp } from "../src/app/server";

const SHOTS = join(import.meta.dirname, "e2e-shots");
mkdirSync(SHOTS, { recursive: true });
let n = 0;
const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `${String(++n).padStart(2, "0")}-${name}.png`), fullPage: true });
const started = Date.now();
const step = (s: string) => console.log(`  \x1b[2m${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s ·\x1b[0m ${s}`);

async function until<T>(what: string, cond: () => T | undefined | null | false | Promise<T | undefined | null | false>, ms = 120_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
function expect(ok: unknown, what: string): void {
  if (!ok) throw new Error(`expected ${what}`);
}

let world: World | undefined;
let app: Awaited<ReturnType<typeof startApp>> | undefined;
let browser: Browser | undefined;
const failures: string[] = [];

try {
  step("starting the world: Settle on a local cluster, the hub, Conner's device, CI, Dana, QuickFix and three scripted agents");
  world = await createWorld({ ports: { app: 0, hub: 0, settle: 0, relay: 0, rpc: 0 }, mode: "scripted", courier: "manual" });
  app = await startApp(world, { port: 0, web: process.argv.includes("--static") ? "static" : "dev" });
  const w = world;
  browser = await chromium.launch({ headless: !process.argv.includes("--headed") });
  const ctxA = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const ctxB = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const con = await ctxA.newPage();
  const cou = await ctxB.newPage();
  for (const [p, who] of [
    [con, "console"],
    [cou, "courier"],
  ] as const) {
    p.on("pageerror", (e) => failures.push(`${who} page error: ${e.message}`));
    p.on("console", (m) => m.type() === "error" && !/favicon/.test(m.text()) && failures.push(`${who} console: ${m.text()}`));
  }
  await con.goto(`${app.url}/`);
  await cou.goto(`${app.url}/courier`);
  await con.getByRole("heading", { name: "Conner Swann's agents" }).waitFor();
  await cou.getByRole("heading", { name: "Dana Ruiz, courier" }).waitFor();
  await shot(con, "console-start");
  await shot(cou, "courier-empty");

  step("1. Conner issues Ops agent's mandate, funds it, and gives it the task");
  await con.getByRole("button", { name: "Issue mandate" }).click();
  await con.getByRole("button", { name: "Mandate issued" }).waitFor();
  await con.getByText("Up to 30.00 USDC per payment; 100.00 USDC per day; 200.00 USDC in total.").first().waitFor();
  await con.getByRole("button", { name: "Fund 150 USDC" }).click();
  await con.getByRole("button", { name: "Funded" }).waitFor({ timeout: 30_000 });
  await con.locator(".setup").getByRole("button", { name: "Send task" }).click();
  await con.getByRole("button", { name: "Task sent" }).waitFor();
  await shot(con, "mandate-issued");

  step("2. Ops agent hires Coder agent, paid when CI passes");
  await con.getByText(/Hired Coder agent to fix CI/).waitFor({ timeout: 120_000 });
  await shot(con, "coder-hired");

  step("3. The injected quote, sent straight to the guard: refused, and no approval request");
  const inject = con.getByRole("button", { name: "Send QuickFix's quote straight to the guard" });
  await until("QuickFix's quote", () => inject.isEnabled());
  await inject.click();
  await con.getByRole("heading", { name: "The guard: refused" }).waitFor();
  await con.getByText("No approval request was sent to you: one of the reasons can't be approved.").waitFor();
  await con.getByText(/isn't one Conner Swann allowed Ops agent/).first().waitFor();
  expect(w.principal.approvals.size === 0, "no approval request after the injection");
  await shot(con, "injection-refused");

  step("4. CI clones, runs node --test, attests; the escrow pays Coder agent");
  await until(
    "Coder agent's payment to settle",
    () => {
      const job = [...w.ops.guard.jobs.values()].find((j) => j.workerName === "Coder agent");
      const c = job?.checkout ? w.ops.party.checkouts.get(job.checkout) : undefined;
      return c?.paymentId && w.ops.party.payments.get(c.paymentId)?.settled;
    },
    240_000,
  );
  expect(w.ci.runs.some((r) => r.passed), "a green CI run");

  step("5. Errands agent offers Dana the parcel job; she sees the verified chain and quotes 45");
  await cou.getByRole("heading", { name: "Bring the parcel from the Main St post office" }).waitFor({ timeout: 120_000 });
  await cou.getByText("Mandate verified").waitFor();
  await cou.getByText("Ops agent → Errands agent").waitFor();
  await shot(cou, "offer");
  await cou.getByLabel("Your price (USDC)").fill("45");
  await cou.getByRole("button", { name: "Send quote" }).click();
  await cou.getByText(/You quoted/).waitFor();

  step("6. Escalation: 45.50 is over Errands agent's 30 a payment. Conner approves, with the keyboard");
  const card = con.locator("article.approval");
  await card.waitFor({ timeout: 120_000 });
  await card.getByRole("heading", { name: /Errands agent asks to pay Dana Ruiz/ }).waitFor();
  const text = await card.innerText();
  expect(text.includes("45.00 USDC + 0.50 USDC fee = 45.50 USDC"), `the amount and fee on the approval card (got: ${text.slice(0, 400)})`);
  expect(text.includes("In the agent's words"), "the justification labeled as the agent's words");
  expect(text.includes("VerifiedBusiness from Settle Verify"), "Dana's verified credential on the card");
  expect(/30\.00 USDC per payment/.test(text), "the reason in plain words");
  await shot(con, "approval-request");
  await card.getByRole("button", { name: "Deny" }).focus();
  await con.keyboard.press("Shift+Tab");
  const focused = await con.evaluate(() => document.activeElement?.textContent ?? "");
  expect(focused.startsWith("Approve"), `focus on Approve after Shift+Tab (got "${focused}")`);
  await con.keyboard.press("Enter");
  await card.waitFor({ state: "detached", timeout: 30_000 });

  step("7. Dana's view: paid into escrow, and who stands behind it. She delivers");
  await cou.getByText(/Chain of 2 verified, approval by Conner Swann, root verified/).waitFor({ timeout: 60_000 });
  await shot(cou, "paid");
  await cou.getByRole("button", { name: "Mark delivered" }).click();
  await cou.getByText(/Delivered:/).waitFor();

  step("8. Conner confirms: Package received. Dana is paid");
  await con.getByRole("button", { name: "Package received" }).click({ timeout: 60_000 });
  await cou.getByText(/You were paid/).waitFor({ timeout: 60_000 });
  await shot(cou, "dana-paid");

  step("9. Review: the trails verify, receipted by Conner's witness and the hub");
  for (const name of ["Errands agent", "Ops agent"]) {
    await con.getByRole("button", { name: `Review ${name}'s trail` }).click();
    const banner = con.locator(".banner", { hasText: name });
    await banner.waitFor({ timeout: 30_000 });
    const b = await banner.innerText();
    expect(b.includes("chain intact"), `${name}'s trail intact (got: ${b})`);
    step(`   ${b}`);
  }
  await con.getByLabel("Show").selectOption("decisions");
  await shot(con, "activity");

  step("10. Revoke Errands agent's mandate; another errand is refused by its guard");
  await con.getByRole("button", { name: "Revoke Errands agent's mandate" }).click();
  await con.getByRole("button", { name: "Confirm revoke" }).click();
  await until("Errands agent to learn of the revocation", () => w.errands.guard.revoked, 30_000);
  const strip = con.getByRole("listitem", { name: "Errands agent" });
  await strip.getByText("Give Errands agent a task").click();
  await strip.getByLabel("Task for Errands agent").fill("Another errand: pick up dry cleaning on Elm St and bring it to me.");
  await strip.getByRole("button", { name: "Send task" }).click();
  const refused = con.getByText(/I couldn't take the errand/);
  await refused.waitFor({ timeout: 120_000 });
  const r = await refused.innerText();
  expect(/revoked/.test(r), `the refusal names the revocation (got: ${r})`);
  step(`   Errands agent reported: "${r}"`);
  await shot(con, "revoked");

  if (failures.length) throw new Error(failures.join("\n"));
  console.log(`\n  \x1b[32m✓ the console and the courier view, through the whole demo, in ${((Date.now() - started) / 1000).toFixed(0)}s\x1b[0m (screenshots in ${SHOTS})\n`);
} catch (e) {
  console.error(`\n  \x1b[31m✗ ${(e as Error).message}\x1b[0m`);
  if (failures.length) console.error(failures.join("\n"));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  await app?.close().catch(() => undefined);
  await world?.close().catch(() => undefined);
  process.exit(process.exitCode ?? 0);
}
