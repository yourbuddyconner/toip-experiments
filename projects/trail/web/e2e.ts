/**
 * The explorer, driven through a real browser over the ten demo steps, against a local Trail service.
 *
 *   npm run e2e --workspace @toip-tools/trail             # Vite dev server
 *   npm run e2e --workspace @toip-tools/trail -- --static # the built explorer (npm run build:web first)
 *   add --headed to watch
 *
 * Screenshots land in web/e2e-shots/.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { startService } from "../src/service";

const SHOTS = join(import.meta.dirname, "e2e-shots");
mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, name: string) => (await page.waitForTimeout(300), page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }));
const step = (s: string) => console.log(`  \x1b[2m·\x1b[0m ${s}`);

const service = await startService({ port: 0, web: process.argv.includes("--static") ? "static" : "dev" });
const browser = await chromium.launch({ headless: !process.argv.includes("--headed") });
const failures: string[] = [];
let ok = false;

async function runStep(page: Page, n: number, title: string, done: RegExp) {
  await page.goto(`${service.appUrl}/#/demo`);
  await page.getByRole("button", { name: `Run step ${n}: ${title}` }).click();
  await page.getByLabel(`What happened in step ${n}`).getByText(done).first().waitFor({ timeout: 30000 });
}

async function openScout(page: Page) {
  await page.getByRole("navigation", { name: "Identifiers and witnesses" }).or(page.getByRole("complementary", { name: "Identifiers and witnesses" })).getByRole("link", { name: /Scout/ }).click();
  await page.getByRole("heading", { name: "Key state over time" }).waitFor();
  await page.locator(".ledger.trail").waitFor();
}

try {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => failures.push(`page error: ${e.message}`));
  // a witness answers 404 when it holds no head for a log: that is the protocol, not a failure
  page.on("console", (m) => m.type() === "error" && !/favicon|Failed to load resource/.test(m.text()) && failures.push(`console: ${m.text()}`));
  page.on("response", (r) => r.status() >= 400 && !(r.status() === 404 && /\/w\/\d\/head\//.test(r.url())) && failures.push(`HTTP ${r.status()} ${r.url()}`));

  console.log("\nTrail explorer in a browser\n");
  step("the explorer opens on the demo, with no identifiers yet");
  await page.goto(service.appUrl);
  await page.getByRole("heading", { name: "The demo" }).waitFor();
  await page.getByText("None yet. Run step 1 of the demo.").waitFor();
  await shot(page, "01-demo-start");

  step("1. birth: Scout's KEL has 3/3 receipts and a valid DID binding");
  await runStep(page, 1, "Birth", /checks out both ways/);
  await page.getByRole("link", { name: "See Scout's KEL" }).click();
  await page.getByRole("heading", { name: "Key state over time" }).waitFor();
  await page.getByText("binding valid").waitFor();
  if ((await page.locator(".ledger.kel .stamp", { hasText: "valid 3/3" }).count()) !== 2) throw new Error("the KEL should show two events with 3/3 receipts");
  await shot(page, "02-birth-kel");

  step("2. work: seven entries valid 3/3; an entry sheet lists every check");
  await runStep(page, 2, "Work", /valid 3\/3/);
  await page.getByRole("link", { name: "See Scout's trail" }).click();
  await page.locator(".ledger.trail").waitFor();
  const valid = await page.locator(".ledger.trail .stamp", { hasText: "valid 3/3" }).count();
  if (valid !== 8) throw new Error(`expected 8 trail messages valid 3/3, saw ${valid}`);
  await page.getByRole("button", { name: /Entry 7, agent\/payment-intent/ }).click();
  const sheet = page.getByRole("complementary", { name: /Entry 7/ });
  await sheet.getByText("The disclosed body hashes to the header's digest.").waitFor();
  await sheet.getByText('"amount": "340.00"').waitFor();
  await shot(page, "03-work-entry-sheet");
  // keyboard: close the sheet, and open another entry with the keyboard alone
  await sheet.getByRole("button", { name: "Close the entry" }).click();
  await page.getByRole("button", { name: /Entry 6, agent\/approval-granted/ }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("complementary", { name: /Entry 6/ }).getByText(/Ada signed this entry/).waitFor();

  step("3. Ada reviews: the disclosed bundle verifies in the page, witness-checked");
  await runStep(page, 3, "Ada reviews", /witness-checked/);
  await page.getByRole("link", { name: "Verify the bundle yourself" }).click();
  await page.getByRole("button", { name: "Scout's bundle, as disclosed to Ada" }).click();
  await page.locator(".result .stamp", { hasText: "verified" }).waitFor({ timeout: 20000 });
  await page.locator(".result").getByText("Compared with the witnesses.").waitFor();

  step("4. tamper: each layer fails a different check, with its explanation");
  await runStep(page, 4, "Tamper", /sealMismatch/);
  await shot(page, "04-tamper-report");
  await page.getByRole("link", { name: "Verify the tampered copies" }).click();
  for (const [layer, code] of [
    [1, "bodyMismatch"],
    [2, "saidMismatch"],
    [3, "signatureInvalid"],
    [4, "sealMismatch"],
  ] as const) {
    await page.getByRole("button", { name: `Tampered, layer ${layer}` }).click();
    await page.locator(".result .stamp", { hasText: "failed" }).waitFor({ timeout: 20000 });
    await page.locator(".result > .problems").getByText(code, { exact: true }).first().waitFor();
    if (layer === 3) await shot(page, "05-verify-tampered");
  }

  step("5. fork: the evidence page shows both versions of entry 6, proven");
  await runStep(page, 5, "Fork", /proves itself/);
  await page.getByRole("link", { name: "See the evidence" }).click();
  const fork = page.getByRole("region", { name: "controller duplicity at entry 6" });
  await fork.getByText("Controller duplicity: Scout, entry 6").waitFor({ timeout: 20000 });
  await fork.locator(".stamp", { hasText: "proven" }).waitFor();
  await fork.getByText(/Quarry's watcher/).first().waitFor();
  await shot(page, "06-evidence-fork");

  step("6. rogue witness: witness 3 convicted, then rotated out by Ada");
  await runStep(page, 6, "Rogue witness", /removes Witness 3/);
  await page.goto(`${service.appUrl}/#/evidence`);
  await page.getByText("Witness duplicity: Witness 3, entry 8").waitFor({ timeout: 20000 });
  await page.getByText("rogue, removed").waitFor();
  await openScout(page);
  await page.locator(".ledger.kel").getByText(/removes Witness 3; adds Witness 4/).waitFor();
  await shot(page, "07-rogue-rotation");

  step("7. key theft: the thief's entries 9 and 10 are struck through, cut by recovery at KEL 4");
  await runStep(page, 7, "Key theft and recovery", /cut by recovery at KEL 4/);
  await page.getByRole("link", { name: "See the cut entries" }).click();
  await page.locator(".ledger.trail").waitFor();
  const cut = await page.locator(".ledger.trail tr.struck .stamp", { hasText: "cut" }).count();
  if (cut !== 2) throw new Error(`expected 2 cut entries, saw ${cut}`);
  await page.locator(".ledger.kel .stamp", { hasText: "superseded" }).waitFor();
  await page.getByRole("button", { name: /Entry 10, agent\/tool-call, cut/ }).click();
  await page.getByRole("complementary", { name: /Entry 10/ }).getByText(/cut by recovery/).first().waitFor();
  await shot(page, "08-recovery-cut");

  step("8. the old key, later: Mallory's bundle fails once compared with the witnesses");
  await runStep(page, 8, "The old key, later", /is cut/);
  await page.getByRole("link", { name: "Verify Mallory's bundle" }).click();
  await page.getByRole("button", { name: "Mallory's bundle for Bram" }).click();
  await page.locator(".result .stamp", { hasText: "failed" }).waitFor({ timeout: 20000 });
  await page.locator(".result > .problems").getByText("truncated", { exact: true }).first().waitFor();

  step("9. camera: photos A and B anchored across the rotation; photo C in amber");
  await runStep(page, 9, "A camera across rotations", /not anchored before retirement/);
  await page.getByRole("link", { name: "See the captures" }).click();
  await page.locator(".capture-warn .stamp", { hasText: "retired key" }).waitFor({ timeout: 20000 });
  if ((await page.locator(".capture-valid").count()) !== 2) throw new Error("photos A and B should be anchored");
  await shot(page, "09-captures");

  step("10. interop: KERIpy's key state, or a clear skip");
  await runStep(page, 10, "Interop with KERIpy", /same key state as ours|skipped/);
  const keri = await page.getByLabel("What happened in step 10").innerText();
  console.log(`    ${keri.split("\n").slice(-1)[0]}`);
  await shot(page, "10-demo-finished");

  step("on a phone-sized screen, the trail still reads");
  await page.setViewportSize({ width: 420, height: 900 });
  await openScout(page);
  await shot(page, "11-narrow-trail");

  if (failures.length) throw new Error(failures.join("\n"));
  ok = true;
  console.log("\n  \x1b[32m✓ the explorer works through all ten steps\x1b[0m\n");
} catch (e) {
  console.error(`\n  \x1b[31m✗ ${(e as Error).message}\x1b[0m\n`);
  if (failures.length) console.error(failures.join("\n"));
} finally {
  await browser.close();
  await service.close();
}
process.exit(ok ? 0 : 1);
