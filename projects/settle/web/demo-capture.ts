/**
 * Records the footage for a demo video: each person's browser window, on a real cluster, with markers saying
 * what happens when. A video editor (or a Remotion project) cuts the story from footage/*.webm and markers.json.
 *
 *   npm run build:web --workspace @toip-tools/settle
 *   npx tsx --conditions=@toip-tools/source web/demo-capture.ts --cluster devnet --out <dir>      # from projects/settle
 *
 * The cast: Joe's Plumbing (the business, payee), Dana (the customer, payer), and Sam at Settle (an operator,
 * who rules disputes as Settle Arbitration). Two jobs: one released when Dana confirms the work, one disputed
 * and split by the arbiter. The settlement is then opened on Solana Explorer from the app's own link.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { startPlatform } from "../src/platform/platform";
import { dataDirFor, flag } from "../src/platform/main-args";

const cluster = flag("cluster") ?? "devnet";
const out = flag("out") ?? join(import.meta.dirname, "demo-footage");
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "raw"), { recursive: true });

const T0 = Date.now();
const t = () => (Date.now() - T0) / 1000;
type Marker = { t: number; actor: string; label: string; data?: Record<string, unknown> };
const markers: Marker[] = [];
const pageStarts: Record<string, number> = {};
const mark = (actor: string, label: string, data?: Record<string, unknown>) => {
  markers.push({ t: t(), actor, label, data });
  console.log(`  ${t().toFixed(1).padStart(6)}s  ${actor.padEnd(9)} ${label}`);
};

/** A visible cursor and click ripple: video recordings don't show the real one. */
const CURSOR = `
addEventListener("DOMContentLoaded", () => {
  const c = document.createElement("div");
  c.style.cssText = "position:fixed;z-index:2147483647;width:22px;height:22px;margin:-3px 0 0 -3px;pointer-events:none;left:-40px;top:-40px;transition:left .25s ease,top .25s ease";
  c.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2 L3 18 L7.5 13.8 L10.6 20.4 L13.4 19.1 L10.4 12.6 L16.5 12.4 Z" fill="#13262b" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  document.body.appendChild(c);
  addEventListener("mousemove", (e) => { c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px"; }, true);
  addEventListener("mousedown", (e) => {
    const r = document.createElement("div");
    r.style.cssText = "position:fixed;z-index:2147483646;pointer-events:none;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:3px solid #b7791f;left:" + e.clientX + "px;top:" + e.clientY + "px;opacity:.9;transition:transform .45s ease-out,opacity .45s ease-out";
    document.body.appendChild(r);
    requestAnimationFrame(() => { r.style.transform = "scale(1.8)"; r.style.opacity = "0"; });
    setTimeout(() => r.remove(), 500);
  }, true);
});`;

const platform = await startPlatform({ web: "static", cluster, dataDir: dataDirFor(cluster), log: (l) => /error/i.test(l) && console.log(`  platform: ${l}`) });
const browser = await chromium.launch({ headless: !process.argv.includes("--headed") });
const VIEW = { width: 1280, height: 800 };
const contexts: BrowserContext[] = [];
/** Every recorded page, by who it belongs to ("business", "business-tab1" for the Explorer tab it opens, ...). */
const recorded: { id: string; page: Page }[] = [];

async function actor(name: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: VIEW, recordVideo: { dir: join(out, "raw", name), size: VIEW } });
  contexts.push(ctx);
  await ctx.addInitScript(CURSOR);
  let n = 0;
  ctx.on("page", (p) => {
    const id = n++ === 0 ? name : `${name}-tab${n - 1}`;
    pageStarts[id] = t();
    recorded.push({ id, page: p });
    p.on("pageerror", (e) => console.log(`  ${id} page error: ${e.message}`));
  });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  });
  return page;
}

const pause = (p: Page, ms = 900) => p.waitForTimeout(ms);
const type = async (p: Page, label: string | RegExp, text: string) => {
  const f = p.getByLabel(label);
  await f.click();
  await f.fill("");
  await f.pressSequentially(text, { delay: 35 });
};
const LONG = { timeout: 240_000 };

let lastLink = "";
async function createLink(p: Page): Promise<string> {
  await p.getByRole("button", { name: "Create payment link" }).click();
  for (const end = Date.now() + 30_000; Date.now() < end; await p.waitForTimeout(100)) {
    const v = await p.getByLabel("Payment link").inputValue().catch(() => "");
    if (v && v !== lastLink) return (lastLink = v);
  }
  throw new Error("the payment link never appeared");
}

let operatorDid: string | undefined;
try {
  console.log(`\nRecording the Settle demo on ${cluster}\n`);
  const shop = await actor("business");
  const cust = await actor("customer");

  // ------------------------------------------------------------ the business sets up
  mark("business", "opens Settle");
  await shop.goto(platform.appUrl);
  await pause(shop, 1500);
  await type(shop, "Your name or your business's name", "Joe's Plumbing");
  await pause(shop, 500);
  mark("business", "creates an account with a passkey");
  await shop.getByRole("button", { name: "Create account with a passkey" }).click();
  await shop.getByText("in your wallet").first().waitFor(LONG);
  mark("business", "account ready");
  await pause(shop, 1500);
  await shop.getByRole("link", { name: "Profile", exact: true }).click();
  await pause(shop);
  await type(shop, "What you do", "Plumbing");
  mark("business", "gets verified");
  await shop.getByRole("button", { name: "Get verified" }).click();
  await shop.getByText('Settle Verify vouches for "Joe\'s Plumbing"').waitFor(LONG);
  await pause(shop, 1500);
  await shop.getByRole("link", { name: "Payment links", exact: true }).click();
  await pause(shop);
  mark("business", "makes a payment link");
  await type(shop, "What it's for", "Fix the kitchen sink, Unit 4B");
  await type(shop, "Price (USDC)", "120");
  await pause(shop, 800);
  const url1 = await createLink(shop);
  mark("business", "link ready");
  await pause(shop, 2500);

  // ------------------------------------------------------------ the customer pays
  mark("customer", "opens the link");
  await cust.goto(url1);
  await cust.getByText("Verified: Joe's Plumbing").waitFor(LONG);
  await pause(cust, 2500);
  await type(cust, "Your name or your business's name", "Dana Whitfield");
  mark("customer", "creates an account with a passkey");
  await cust.getByRole("button", { name: "Create account with a passkey" }).click();
  await cust.getByRole("button", { name: "Add 500 test USDC to pay" }).waitFor(LONG);
  await pause(cust);
  mark("customer", "adds test USDC");
  await cust.getByRole("button", { name: "Add 500 test USDC to pay" }).click();
  await cust.getByRole("button", { name: "Pay 121.20 USDC" }).waitFor(LONG);
  await pause(cust);
  mark("customer", "pays");
  await cust.getByRole("button", { name: "Pay 121.20 USDC" }).click();
  await cust.getByText("Paid into escrow.").waitFor(LONG);
  mark("customer", "paid into escrow");
  await pause(cust, 2500);

  // ------------------------------------------------------------ the business sees it held
  await shop.getByRole("link", { name: "Home", exact: true }).click();
  await shop.getByText("held in escrow").waitFor(LONG);
  mark("business", "sees the money held in escrow");
  await pause(shop, 2500);
  await shop.getByRole("link", { name: /Fix the kitchen sink/ }).first().click();
  await shop.getByText("exactly as agreed").waitFor(LONG);
  mark("business", "payment page: escrow checked on chain");
  await pause(shop, 3000);

  // ------------------------------------------------------------ the customer confirms
  await cust.getByRole("link", { name: "See the payment" }).click();
  await pause(cust, 2000);
  mark("customer", "confirms the work is done");
  await cust.getByRole("button", { name: "Confirm the work is done" }).click();
  await cust.locator(".chip", { hasText: "Released" }).waitFor(LONG);
  mark("customer", "released");
  await shop.locator(".chip", { hasText: "Released" }).waitFor(LONG);
  mark("business", "released");
  await shop.getByRole("link", { name: "See the settlement on Solana Explorer" }).waitFor(LONG);
  await pause(shop, 3000);
  const explorerHref = await shop.getByRole("link", { name: "See the settlement on Solana Explorer" }).getAttribute("href");
  mark("business", "settlement link", { href: explorerHref });

  // ------------------------------------------------------------ a second job goes wrong
  await shop.getByRole("link", { name: "Payment links", exact: true }).click();
  await pause(shop);
  mark("business", "makes a second link");
  await type(shop, "What it's for", "Replace the water heater");
  await type(shop, "Price (USDC)", "300");
  const url2 = await createLink(shop);
  await pause(shop, 1500);
  mark("customer", "opens the second link");
  await cust.goto(url2);
  await pause(cust, 1500);
  mark("customer", "unlocks with the passkey");
  await cust.getByRole("button", { name: "Unlock Dana Whitfield" }).click();
  await cust.getByRole("button", { name: "Pay 303.00 USDC" }).waitFor(LONG);
  await pause(cust);
  mark("customer", "pays the second job");
  await cust.getByRole("button", { name: "Pay 303.00 USDC" }).click();
  await cust.getByText("Paid into escrow.").waitFor(LONG);
  mark("customer", "second payment in escrow");
  await pause(cust, 1500);
  await cust.getByRole("link", { name: "See the payment" }).click();
  await pause(cust, 1500);
  mark("customer", "reports a problem");
  await cust.getByRole("button", { name: "Report a problem" }).click();
  await type(cust, "What's wrong?", "No hot water after the first day.");
  await cust.getByRole("button", { name: "Open dispute" }).click();
  await cust.locator(".chip", { hasText: "Disputed" }).waitFor(LONG);
  mark("customer", "disputed");
  await pause(cust, 2000);

  // ------------------------------------------------------------ the operator rules
  const ops = await actor("operator");
  mark("operator", "makes an account");
  await ops.goto(platform.appUrl);
  await type(ops, "Your name or your business's name", "Sam at Settle");
  await ops.getByRole("button", { name: "Create account with a passkey" }).click();
  await ops.getByText("in your wallet").first().waitFor(LONG);
  operatorDid = await ops.evaluate(() => JSON.parse(localStorage.getItem("settle.accounts") ?? "[]")[0]?.did);
  if (!platform.operators.setupCode) {
    // This platform already has an operator from an earlier recording: add this one for the take.
    platform.operators.add(operatorDid!);
    await ops.goto(`${platform.appUrl}/console`);
  } else {
    await ops.goto(`${platform.appUrl}/console?setup=${platform.operators.setupCode}`);
  }
  await pause(ops, 1500);
  mark("operator", "signs in to the operator view");
  await ops.getByRole("button", { name: "Sam at Settle" }).click();
  await ops.getByText("No hot water after the first day.").waitFor(LONG);
  await ops.getByText(/held until/).first().waitFor(LONG);
  mark("operator", "sees the case, escrow held");
  await pause(ops, 3000);
  // This demo's case, even on a platform that has others open.
  const kase = ops.locator("li.case", { hasText: "No hot water after the first day." }).last();
  await kase.scrollIntoViewIfNeeded();
  await kase.getByLabel(/To Joe's Plumbing/).fill("");
  await kase.getByLabel(/To Joe's Plumbing/).pressSequentially("180", { delay: 35 });
  await kase.getByLabel("Reasons").pressSequentially("Installed, but the thermostat was faulty: 180 for the work done.", { delay: 35 });
  await pause(ops, 1000);
  mark("operator", "rules a split");
  await kase.getByRole("button", { name: "Rule and sign" }).click();
  await kase.getByText(/Carried out on-chain/).waitFor(LONG);
  mark("operator", "ruling carried out on chain");
  await pause(ops, 2500);
  await cust.locator(".chip", { hasText: "Split by arbiter" }).waitFor(LONG);
  mark("customer", "split by arbiter");
  await pause(cust, 2500);
  await ops.getByRole("tab", { name: "Processor" }).click();
  await ops.getByText("The hash chain checks out").waitFor(LONG);
  mark("operator", "processor log checks out");
  await pause(ops, 3500);

  // ------------------------------------------------------------ proof on Solana Explorer
  await shop.getByRole("link", { name: "Payments", exact: true }).click();
  await shop.getByRole("link", { name: /Fix the kitchen sink/ }).first().click();
  await pause(shop, 1500);
  mark("business", "opens the settlement on Solana Explorer");
  const [explorer] = await Promise.all([shop.context().waitForEvent("page"), shop.getByRole("link", { name: "See the settlement on Solana Explorer" }).click()]);
  await explorer.waitForLoadState("domcontentloaded");
  await explorer.getByText(/Success|Finalized/).first().waitFor({ timeout: 90_000 });
  await pause(explorer, 1500);
  mark("explorer", "transaction overview");
  await pause(explorer, 4000);
  const balances = explorer.getByText("Token Balances", { exact: false }).first();
  await balances.scrollIntoViewIfNeeded().catch(() => {});
  await explorer.mouse.wheel(0, -120);
  mark("explorer", "token balances");
  await pause(explorer, 6000);
  const logs = explorer.getByText(/Program Instruction Logs|Instruction Logs/).first();
  await logs.scrollIntoViewIfNeeded().catch(() => {});
  mark("explorer", "program logs");
  await pause(explorer, 4000);
  mark("explorer", "done");
  await explorer.screenshot({ path: join(out, "explorer.png"), fullPage: true });

  console.log("\n  all steps recorded\n");
} catch (e) {
  console.error(`\n  ✗ ${String((e as Error)?.message ?? e)}\n`);
  process.exitCode = 1;
} finally {
  // Recordings are written when their context closes.
  for (const ctx of contexts) await ctx.close();
  const videos: Record<string, string> = {};
  for (const { id, page } of recorded) {
    const v = page.video();
    if (!v) continue;
    const to = join(out, `${id}.webm`);
    renameSync(await v.path(), to);
    videos[id] = to;
  }
  // The demo operator's key went with its browser: take it off the list, so the platform offers a setup link again.
  if (operatorDid && platform.operators.dids.includes(operatorDid)) platform.operators.remove(operatorDid, "the recording");
  writeFileSync(join(out, "markers.json"), JSON.stringify({ cluster, pageStarts, markers, videos }, null, 1));
  await browser.close();
  await platform.close();
  process.exit(process.exitCode ?? 0);
}
