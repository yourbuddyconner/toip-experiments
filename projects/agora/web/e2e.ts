/**
 * The demo script (design §12.3, steps 1 to 10) in real browsers: Ana, Ben and Cal (members, and Cal
 * not an RN), Dee (owner and moderator), Ana's second device, and a reader with no account. Each
 * browser profile has a virtual passkey authenticator with PRF, so accounts are sealed with passkeys.
 * Proofs are real, made in each page's Web Worker.
 *
 *   npm run e2e --workspace @toip-tools/agora              # builds the web app, then runs
 *   add --headed to watch
 *
 * Screenshots land in web/e2e-shots/. Proof times go to results/e2e-times.json.
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { startPlatform } from "../src/platform/platform";

const ROOT = join(import.meta.dirname, "..");
const SHOTS = join(import.meta.dirname, "e2e-shots");
mkdirSync(SHOTS, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
const step = (s: string) => console.log(`  \x1b[2m·\x1b[0m ${s}`);

console.log("\nAgora in a browser\n");
step("building the web app");
execSync("npx vite build --config web/vite.config.ts --logLevel error", { cwd: ROOT, stdio: "inherit" });
const platform = await startPlatform({ web: "static" });
const browser = await chromium.launch({ headless: !process.argv.includes("--headed") });
const failures: string[] = [];
const pages: Page[] = [];
const times: Record<string, number> = {};

async function person(label: string, opts: { viewport?: { width: number; height: number } } = {}): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: opts.viewport ?? { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  });
  page.on("pageerror", (e) => failures.push(`${label} page error: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) failures.push(`${label} console: ${m.text()}`);
  });
  pages.push(page);
  return { ctx, page };
}

async function createAccount(page: Page, name: string) {
  await page.goto(`${platform.appUrl}/account`);
  await page.getByLabel("Your name").fill(name);
  await page.getByRole("button", { name: "Create account with a passkey" }).click();
  await page.getByRole("heading", { name: "Wallet" }).waitFor();
}

async function ask(page: Page, issuer: string, fields: Record<string, string> = {}) {
  const form = page.getByRole("form", { name: `Ask ${issuer}` });
  for (const [label, value] of Object.entries(fields)) await form.getByLabel(label).selectOption(value);
  await form.getByRole("button", { name: `Ask ${issuer}` }).click();
  await page.getByText(`${issuer} issued your credential.`).waitFor({ timeout: 20_000 });
}

async function joinGroup(page: Page, group: string) {
  await page.getByRole("button", { name: `Join ${group}` }).click();
  await page.getByText(`Joined ${group}.`).waitFor({ timeout: 20_000 });
}

/** A full page load locks the account: the tab remembers it, and one click unlocks it with the passkey. */
async function open(page: Page, url: string) {
  await page.goto(url);
  const who = page.locator(".who");
  const unlock = who.getByRole("button", { name: /^Unlock / });
  await unlock.or(who.getByRole("button", { name: "Lock", exact: true })).waitFor({ timeout: 20_000 });
  if (await unlock.isVisible()) {
    await unlock.click();
    await page.getByRole("button", { name: "Lock", exact: true }).waitFor({ timeout: 20_000 });
  }
}

async function skip(page: Page, label: string) {
  const [res] = await Promise.all([page.waitForResponse((r) => r.url().includes("/dev/advance")), page.getByRole("button", { name: label, exact: true }).click()]);
  if (!res.ok()) throw new Error(`skipping ahead failed: ${await res.text()}`);
}

/** Posts from the open composer and waits for the post to appear. Records how long the pass took. */
async function post(page: Page, body: string, title?: string, key?: string) {
  const leak = page.getByRole("button", { name: "I understand" });
  if (await leak.isVisible().catch(() => false)) await leak.click();
  if (title) await page.getByLabel("Title").fill(title);
  await page.getByLabel(title ? "Your post" : "Your reply").fill(body);
  const t0 = Date.now();
  await page.getByRole("button", { name: "Post", exact: true }).click();
  await page.locator(".post-body", { hasText: body }).waitFor({ timeout: 60_000 });
  if (key) times[key] = Date.now() - t0;
}

try {
  const ana = await person("ana");
  const ben = await person("ben");
  const cal = await person("cal");
  const dee = await person("dee");

  step("1. everyone makes an account, sealed with a passkey, and asks for credentials");
  await ana.page.goto(platform.appUrl);
  await ana.page.getByRole("heading", { name: "Speak as a member, not as a name." }).waitFor();
  await shot(ana.page, "01-home-empty");
  await createAccount(ana.page, "Ana");
  const sealed = await ana.page.evaluate(() => localStorage.getItem("agora.accounts") ?? "");
  if (!sealed.includes('"kind":"passkey"')) throw new Error("Ana's account isn't sealed with a passkey");
  await ask(ana.page, "Cascade Board of Nursing", { "License type": "RN" });
  await ask(ana.page, "City of Riverton", { District: "7" });
  await createAccount(ben.page, "Ben");
  await ask(ben.page, "Pine Valley Board of Nursing", { "License type": "RN" });
  await createAccount(cal.page, "Cal");
  await ask(cal.page, "Cascade Board of Nursing", { "License type": "LPN" });
  await ask(cal.page, "City of Riverton", { District: "3" });
  await createAccount(dee.page, "Dee");

  step("2. they join their groups; each group has 40 simulated members");
  await joinGroup(ana.page, "Cascade Board of Nursing");
  await joinGroup(ana.page, "City of Riverton");
  await joinGroup(ben.page, "Pine Valley Board of Nursing");
  await joinGroup(cal.page, "Cascade Board of Nursing");
  await joinGroup(cal.page, "City of Riverton");
  await shot(ana.page, "02-wallet");

  step("3. Dee creates Night Shift (RNs from Cascade or Pine Valley, 7 days) and Town Square");
  await dee.page.getByRole("link", { name: "New forum" }).click();
  await dee.page.getByLabel("Name").fill("Night Shift");
  await dee.page.getByLabel("What it's for").fill("For RNs on nights. Be kind.");
  await dee.page.getByLabel(/Cascade Board of Nursing/).check();
  await dee.page.getByLabel(/Pine Valley Board of Nursing/).check();
  await dee.page.getByLabel("license type", { exact: true }).selectOption("eq");
  await dee.page.getByLabel("license type value").fill("RN");
  await dee.page.getByLabel("Days in the group before posting").fill("7");
  await dee.page.getByLabel("Rules, one per line").fill("No names of patients or colleagues.\nNo doxxing.");
  await dee.page.getByText("Posting will need a nursing license with license type RN").waitFor();
  await shot(dee.page, "03-new-forum");
  await dee.page.getByRole("button", { name: "Sign and create forum" }).click();
  await dee.page.getByRole("heading", { name: "Night Shift" }).waitFor();
  const nightShift = dee.page.url();
  await dee.page.getByRole("link", { name: "New forum" }).click();
  await dee.page.getByLabel("Name").fill("Riverton Town Square");
  await dee.page.getByLabel(/City of Riverton/).check();
  await dee.page.getByLabel("Days in the group before posting").fill("0");
  await dee.page.getByRole("button", { name: "Sign and create forum" }).click();
  await dee.page.getByRole("heading", { name: "Riverton Town Square" }).waitFor();
  const townSquare = dee.page.url();

  await open(ana.page, nightShift);
  await ana.page.getByText(/needs a membership held for 7 days/).waitFor({ timeout: 20_000 });
  await skip(ana.page, "8 days");

  step("4. Ana posts in Night Shift under her pseudonym; Ben replies under another");
  await open(ana.page, nightShift);
  const anaName = (await ana.page.getByTestId("my-nym").textContent({ timeout: 20_000 }))!;
  await ana.page.getByText(/out of about \d+ people/).waitFor();
  await shot(ana.page, "04-forum-ana");
  await post(ana.page, "Is anyone else being floated to 4 West every shift?", "Float pool on 4 West?", "firstPassAndPostMs");
  await ana.page.locator(".post .nymname", { hasText: anaName }).first().waitFor();
  await ana.page.getByText("Verified member").first().waitFor();
  const thread = ana.page.url();
  await open(ben.page, thread);
  const benName = (await ben.page.getByTestId("my-nym").textContent({ timeout: 20_000 }))!;
  if (benName === anaName) throw new Error("Ana and Ben have the same pseudonym");
  await post(ben.page, "Every other shift for me.", undefined, "benPassAndPostMs");
  await ana.page.locator(".post-body", { hasText: "Every other shift for me." }).waitFor({ timeout: 20_000 });
  const t1 = Date.now();
  await post(ana.page, "Thanks. Good to know it's not just me.");
  times.postWithLivePassMs = Date.now() - t1;
  await shot(ana.page, "05-thread");

  step("5. Cal, an LPN, is told why before any proof");
  await open(cal.page, nightShift);
  await cal.page.getByText("This forum is for license type RN; yours is LPN.").waitFor({ timeout: 20_000 });
  if (await cal.page.getByRole("button", { name: "Post", exact: true }).count()) throw new Error("Cal can see a Post button");
  await shot(cal.page, "06-cal-refused");

  step("6. Ana's laptop: restored from her backup code, she's the same pseudonym");
  await open(ana.page, `${platform.appUrl}/account`);
  await ana.page.getByRole("button", { name: "Show backup code" }).click();
  const code = await ana.page.getByLabel("Backup code").inputValue();
  const laptop = await person("ana-laptop");
  await laptop.page.goto(`${platform.appUrl}/account`);
  await laptop.page.getByLabel("Backup code").fill(code);
  await laptop.page.getByLabel("A name for it in this browser").fill("Ana (laptop)");
  await laptop.page.getByRole("button", { name: "Restore account" }).click();
  await laptop.page.getByText(/Found your memberships in 2 groups/).waitFor({ timeout: 30_000 });
  await open(laptop.page, thread);
  const laptopName = await laptop.page.getByTestId("my-nym").textContent({ timeout: 20_000 });
  if (laptopName !== anaName) throw new Error(`Ana's laptop is ${laptopName}, not ${anaName}`);
  await post(laptop.page, "Posting from my laptop now.");
  await laptop.page.locator(".post-mine .post-body", { hasText: "Posting from my laptop now." }).waitFor();

  step("7. Town Square: Ana gets a different pseudonym there");
  await open(ana.page, townSquare);
  const anaTs = await ana.page.getByTestId("my-nym").textContent({ timeout: 20_000 });
  if (anaTs === anaName) throw new Error("Ana has the same pseudonym in two forums");
  await post(ana.page, "Should we close Elm St to cars on Sundays?", "Elm St on Sundays");

  step("9. moderation: Ben breaks rule 1, Ana reports, Dee hides it and bans his pseudonym for 7 days");
  await open(ben.page, thread);
  await post(ben.page, "Patient J. Doe in 4W was a nightmare last night.");
  await open(ana.page, thread);
  const bad = ana.page.locator(".post", { hasText: "Patient J. Doe" });
  await bad.getByRole("button", { name: "Report" }).click();
  await bad.getByLabel("Why are you reporting this?").fill("Names a patient (rule 1).");
  await bad.getByRole("button", { name: "Send report" }).click();
  await ana.page.getByText("Reported. The moderators will see it.").waitFor({ timeout: 20_000 });
  await open(dee.page, nightShift);
  await dee.page.getByRole("link", { name: "Moderate this forum" }).click();
  await dee.page.getByText('"Names a patient (rule 1)."').waitFor({ timeout: 20_000 });
  await dee.page.getByRole("button", { name: "Rule 1" }).click();
  await dee.page.getByRole("button", { name: "Hide post" }).click();
  await dee.page.getByText("Done. The action is signed and in the public log.").waitFor();
  await dee.page.getByRole("button", { name: "Ban for 7 days" }).click();
  await dee.page.locator(".badge", { hasText: /Banned until/ }).waitFor({ timeout: 20_000 });
  await shot(dee.page, "07-moderate");
  await ana.page.getByText("Removed by a moderator: No names of patients or colleagues.").waitFor({ timeout: 20_000 });
  await shot(ana.page, "08-removed");
  await open(ben.page, thread);
  await ben.page.getByLabel("Your reply").fill("Why was that removed?");
  await ben.page.getByRole("button", { name: "Post", exact: true }).click();
  await ben.page.getByText(/this nym is banned until/).waitFor({ timeout: 20_000 });
  await shot(ben.page, "09-ben-banned");

  step("10. a poll for district 7 in Town Square; Ana votes and sends it now; Cal is told why not");
  await open(dee.page, townSquare);
  await dee.page.getByRole("link", { name: "Moderate this forum" }).click();
  await dee.page.getByLabel("Question").fill("Close Elm St to cars on Sundays?");
  await dee.page.getByLabel("Only for").selectOption("district");
  await dee.page.getByLabel("equal to").fill("7");
  await dee.page.getByRole("button", { name: "Open poll" }).click();
  await dee.page.getByText("Poll opened.").waitFor({ timeout: 20_000 });
  await open(ana.page, townSquare);
  const poll = ana.page.getByRole("article", { name: "Close Elm St to cars on Sundays?" });
  await poll.getByLabel("Yes").check();
  const t2 = Date.now();
  await poll.getByRole("button", { name: "Prove my vote" }).click();
  await poll.getByText(/Vote ready, sending within/).waitFor({ timeout: 60_000 });
  times.voteProofMs = Date.now() - t2;
  await shot(ana.page, "10-vote-ready");
  await poll.getByRole("button", { name: "Send now" }).click();
  await poll.getByText("Vote counted.").waitFor({ timeout: 20_000 });
  await poll.locator(".tally li", { hasText: "Yes" }).locator(".tally-n", { hasText: "1" }).waitFor({ timeout: 20_000 });
  await poll.getByLabel("Yes").check();
  await poll.getByRole("button", { name: "Prove my vote" }).click();
  await poll.getByRole("button", { name: "Send now" }).click();
  await poll.getByText("you already voted for this choice").waitFor({ timeout: 30_000 });
  await poll.getByLabel("No", { exact: true }).check();
  await poll.getByRole("button", { name: "Prove my vote" }).click();
  await poll.getByRole("button", { name: "Send now" }).click();
  await poll.getByText("Vote changed. Your earlier vote no longer counts.").waitFor({ timeout: 30_000 });
  await poll.locator(".tally li", { hasText: "No" }).locator(".tally-n", { hasText: "1" }).waitFor({ timeout: 20_000 });
  await shot(ana.page, "11-poll");
  await open(cal.page, townSquare);
  await cal.page.getByTestId("poll-ineligible").getByText("This poll is for district 7; yours is 3.").waitFor({ timeout: 20_000 });
  await shot(cal.page, "12-cal-poll");

  step("anyone can read, with no account, and every post checks out in their browser");
  const reader = await person("reader");
  await reader.page.goto(nightShift);
  await reader.page.getByText(/Checked in this browser: \d+ signed entries/).waitFor({ timeout: 30_000 });
  await reader.page.getByRole("link", { name: "Float pool on 4 West?" }).click();
  await reader.page.getByText("Verified member").first().waitFor();
  await reader.page.getByText("Removed by a moderator").waitFor();
  await shot(reader.page, "13-public-reader");

  step("a phone-sized forum page");
  const phone = await person("phone", { viewport: { width: 390, height: 844 } });
  await phone.page.goto(townSquare);
  await phone.page.getByText(/Checked in this browser/).waitFor({ timeout: 30_000 });
  await shot(phone.page, "14-phone");

  step("the host's database holds none of the members' wallet DIDs");
  const dids = await Promise.all([ana, ben, cal].map((p) => p.page.evaluate(() => (JSON.parse(localStorage.getItem("agora.accounts") ?? "[]") as { did: string }[])[0]?.did)));
  const store = JSON.stringify((platform.world.store as unknown as { dump(): unknown }).dump());
  for (const d of dids) if (!d || store.includes(d)) throw new Error(`a member's DID is in the host's store: ${d}`);

  if (failures.length) throw new Error(failures.join("\n"));
  mkdirSync(join(ROOT, "results"), { recursive: true });
  writeFileSync(join(ROOT, "results", "e2e-times.json"), JSON.stringify({ at: new Date().toISOString(), times }, null, 2));
  console.log(`\n  times: ${Object.entries(times).map(([k, v]) => `${k} ${v} ms`).join(", ")}`);
  console.log("\n\x1b[32m✓ all steps passed\x1b[0m; screenshots in web/e2e-shots/\n");
} catch (e) {
  console.error(`\n\x1b[31m✗ ${String((e as Error)?.stack ?? e)}\x1b[0m\n`);
  for (const [i, p] of pages.entries()) await shot(p, `failure-${i}`).catch(() => {});
  if (failures.length) console.error(failures.join("\n"));
  process.exitCode = 1;
} finally {
  await browser.close();
  await platform.close();
  process.exit(process.exitCode ?? 0);
}
