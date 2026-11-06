/**
 * The whole product, driven through a real browser: a business and a customer in two separate browser
 * profiles, over a local platform (chain, relay, processor, arbiter, verifier).
 *
 *   npm run e2e --workspace @zk-toip/settle             # Vite dev server
 *   npm run e2e --workspace @zk-toip/settle -- --static # the built app (npm run build:web first)
 *   add --headed to watch
 *
 * Screenshots land in web/e2e-shots/.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { startPlatform } from "../src/platform/platform";

const SHOTS = join(import.meta.dirname, "e2e-shots");
mkdirSync(SHOTS, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
const step = (s: string) => console.log(`  \x1b[2m·\x1b[0m ${s}`);

const platform = await startPlatform({ web: process.argv.includes("--static") ? "static" : "dev" });
const browser = await chromium.launch({ headless: !process.argv.includes("--headed") });
const failures: string[] = [];
const pages: Page[] = [];

async function account(page: Page, name: string) {
  await page.getByLabel("Your name or your business's name").fill(name);
  await page.getByRole("button", { name: "Create account" }).click();
}

try {
  const shopCtx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const custCtx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const shop = await shopCtx.newPage();
  const cust = await custCtx.newPage();
  pages.push(shop, cust);
  for (const [p, who] of [
    [shop, "shop"],
    [cust, "customer"],
  ] as const) {
    p.on("pageerror", (e) => failures.push(`${who} page error: ${e.message}`));
    p.on("console", (m) => m.type() === "error" && !/favicon/.test(m.text()) && failures.push(`${who} console: ${m.text()}`));
  }

  console.log("\nSettle in a browser\n");
  step("the business creates an account");
  await shop.goto(platform.url);
  await shot(shop, "01-welcome");
  await account(shop, "Joe's Plumbing");
  await shop.getByText("in your wallet").first().waitFor();
  await shot(shop, "02-home-new");

  step("and gets verified");
  await shop.getByRole("link", { name: "Profile", exact: true }).click();
  await shop.getByLabel("What you do").fill("Plumbing");
  await shop.getByRole("button", { name: "Get verified" }).click();
  await shop.getByText('Settle Verify vouches for "Joe\'s Plumbing"').waitFor();

  step("creates a payment link the customer confirms");
  await shop.getByRole("link", { name: "Payment links", exact: true }).click();
  await shop.getByLabel("What it's for").fill("Fix the kitchen sink, Unit 4B");
  await shop.getByLabel("Price (USDC)").fill("120");
  await shop.getByText("1.20 USDC").first().waitFor();
  await shop.getByRole("button", { name: "Create payment link" }).click();
  const url = await shop.getByLabel("Payment link").inputValue();
  await shot(shop, "03-link-created");

  step("the customer opens the link, makes an account, adds test money and pays");
  await cust.goto(url);
  await cust.getByText("Verified: Joe's Plumbing").waitFor();
  await shot(cust, "04-checkout");
  await account(cust, "Dana Whitfield");
  await cust.getByRole("button", { name: "Add 500 test USDC to pay" }).click();
  await cust.getByRole("button", { name: "Pay 121.20 USDC" }).click();
  await cust.getByText("Paid into escrow.").waitFor({ timeout: 20000 });
  await shot(cust, "05-paid-into-escrow");

  step("the business sees the money held in escrow");
  await shop.getByRole("link", { name: "Home", exact: true }).click();
  await shop.getByText("held in escrow").waitFor({ timeout: 10000 });
  await shot(shop, "06-shop-home-held");

  step("the customer confirms the work, and the escrow releases");
  await cust.getByRole("link", { name: "See the payment" }).click();
  await cust.getByRole("button", { name: "Confirm the work is done" }).click();
  await cust.locator(".chip", { hasText: "Released" }).waitFor({ timeout: 20000 });
  await shot(cust, "07-customer-released");

  step("the business is paid and moves it to its wallet");
  await shop.getByRole("link", { name: "Payments", exact: true }).click();
  await shop.getByRole("link", { name: /Fix the kitchen sink/ }).click();
  await shop.locator(".chip", { hasText: "Released" }).waitFor({ timeout: 10000 });
  await shot(shop, "08-shop-payment-released");
  await shop.getByRole("button", { name: "Move 120.00 to wallet" }).click();
  await shop.getByRole("link", { name: "Wallet", exact: true }).click();
  await shop.locator(".balance-figure", { hasText: "120.00" }).waitFor({ timeout: 10000 });

  step("a second job goes wrong: the customer disputes, and the arbiter splits it");
  await shop.getByRole("link", { name: "Payment links", exact: true }).click();
  await shop.getByLabel("What it's for").fill("Replace the water heater");
  await shop.getByLabel("Price (USDC)").fill("300");
  await shop.getByRole("button", { name: "Create payment link" }).click();
  const url2 = await shop.getByLabel("Payment link").inputValue();
  await cust.goto(url2);
  await cust.getByRole("button", { name: "Pay 303.00 USDC" }).click();
  await cust.getByText("Paid into escrow.").waitFor({ timeout: 20000 });
  await cust.getByRole("link", { name: "See the payment" }).click();
  await cust.getByRole("button", { name: "Report a problem" }).click();
  await cust.getByLabel("What's wrong?").fill("No hot water after the first day.");
  await cust.getByRole("button", { name: "Open dispute" }).click();
  await cust.locator(".chip", { hasText: "Disputed" }).waitFor();

  const ops = await shopCtx.newPage();
  ops.on("pageerror", (e) => failures.push(`console page error: ${e.message}`));
  await ops.goto(`${platform.url}/console`);
  await ops.getByText("No hot water after the first day.").waitFor({ timeout: 10000 });
  await ops.getByText(/held until/).first().waitFor({ timeout: 10000 }).catch(() => {});
  await ops.getByLabel(/To Joe's Plumbing/).fill("180");
  await ops.getByLabel("Reasons").fill("Installed, but the thermostat was faulty: 180 for the work done.");
  await shot(ops, "09-console-case");
  await ops.getByRole("button", { name: "Rule and sign" }).click();
  await ops.getByText(/Carried out on-chain/).waitFor({ timeout: 20000 });
  await cust.locator(".chip", { hasText: "Split by arbiter" }).waitFor({ timeout: 20000 });
  await shot(cust, "10-customer-split");

  step("the processor's books and log check out");
  await ops.getByRole("tab", { name: "Processor" }).click();
  await ops.getByText("The hash chain checks out").waitFor();
  await ops.getByText("4.20").first().waitFor();
  await shot(ops, "11-console-processor");

  step("the customer's home shows the refund ready to move");
  await cust.getByRole("link", { name: "Home", exact: true }).click();
  await shot(cust, "12-customer-home");

  step("a third job: a building manager confirms, with a 3-day dispute window");
  const mgrCtx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const mgr = await mgrCtx.newPage();
  pages.push(mgr);
  mgr.on("pageerror", (e) => failures.push(`manager page error: ${e.message}`));
  await mgr.goto(platform.url);
  await account(mgr, "Priya (building manager)");
  await mgr.getByText("in your wallet").first().waitFor();
  await shop.getByRole("link", { name: "Payment links", exact: true }).click();
  await shop.getByLabel("What it's for").fill("Repaint the stairwell");
  await shop.getByLabel("Price (USDC)").fill("50");
  await shop.getByText("Someone else").click();
  await shop.locator("select").first().locator("option", { hasText: "Priya (building manager)" }).waitFor({ state: "attached", timeout: 15000 });
  await shop.getByLabel("Confirmed by").selectOption({ label: "Priya (building manager)" });
  await shop.getByLabel("Dispute window").selectOption("3");
  await shop.getByRole("button", { name: "Create payment link" }).click();
  const url3 = await shop.getByLabel("Payment link").inputValue();
  await cust.goto(url3);
  await cust.getByText("It's released when Priya (building manager) confirms the work is done, after a 3-day window").waitFor();
  await cust.getByRole("button", { name: "Pay 50.50 USDC" }).click();
  await cust.getByText("Paid into escrow.").waitFor({ timeout: 20000 });
  await mgr.getByText("Confirm the work for someone else").waitFor({ timeout: 15000 });
  await shot(mgr, "14-manager-home");
  await mgr.getByRole("link", { name: /Confirm the work for someone else/ }).click();
  await mgr.getByRole("button", { name: "Confirm the work is done" }).click();
  await mgr.locator(".chip", { hasText: "You confirmed" }).waitFor({ timeout: 10000 });
  await cust.getByRole("link", { name: "See the payment" }).click();
  await cust.getByText("signs once the 3-day dispute window has passed").waitFor({ timeout: 15000 });
  await shot(cust, "15-customer-waiting-window");
  const [adv] = await Promise.all([cust.waitForResponse((r) => r.url().includes("/api/dev/advance")), cust.getByRole("button", { name: "7 days" }).click()]);
  if (!adv.ok()) throw new Error(`advancing the clock failed: ${await adv.text()}`);
  await cust.getByText(/Nov 1[3-9], 2026/).first().waitFor({ timeout: 10000 });
  await cust.locator(".chip", { hasText: "Released" }).waitFor({ timeout: 20000 });
  await shot(cust, "16-customer-released-after-window");
  await mgrCtx.close();

  step("a fourth job, refunded by the business");
  await shop.getByRole("link", { name: "Payment links", exact: true }).click();
  await shop.getByLabel("What it's for").fill("Inspect the boiler");
  await shop.getByLabel("Price (USDC)").fill("40");
  await shop.getByRole("radio").first().check();
  await shop.getByLabel("Dispute window").selectOption("0");
  await shop.getByRole("button", { name: "Create payment link" }).click();
  const url4 = await shop.getByLabel("Payment link").inputValue();
  await cust.goto(url4);
  // The customer's wallet is short now (the split's refund is still in its payment account), so it tops up first.
  await cust.getByRole("button", { name: "Add 500 test USDC to pay" }).click();
  await cust.getByRole("button", { name: "Pay 40.50 USDC" }).click();
  await cust.getByText("Paid into escrow.").waitFor({ timeout: 20000 });
  await shop.getByRole("link", { name: "Payments", exact: true }).click();
  await shop.getByRole("link", { name: /Inspect the boiler/ }).click();
  await shop.getByRole("button", { name: "Refund in full" }).waitFor({ timeout: 15000 });
  await shop.getByText("exactly as agreed").waitFor({ timeout: 15000 });
  await shop.getByRole("button", { name: "Refund in full" }).click();
  await shop.locator(".chip", { hasText: "Refunded" }).waitFor({ timeout: 20000 });

  step("a phone-sized checkout");
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const pp = await phone.newPage();
  await pp.goto(url);
  await pp.getByText("Verified: Joe's Plumbing").waitFor();
  await shot(pp, "13-checkout-phone");
  await phone.close();

  if (failures.length) throw new Error(failures.join("\n"));
  console.log("\n\x1b[32m✓ all steps passed\x1b[0m; screenshots in web/e2e-shots/\n");
} catch (e) {
  console.error(`\n\x1b[31m✗ ${String((e as Error)?.message ?? e)}\x1b[0m\n`);
  for (const [i, p] of pages.entries()) await shot(p, `failure-${i}`).catch(() => {});
  if (failures.length) console.error(failures.join("\n"));
  process.exitCode = 1;
} finally {
  await browser.close();
  await platform.close();
  process.exit(process.exitCode ?? 0);
}
