/**
 * The demo script (design §11), driven through real browsers over a local platform. Every person
 * has their own browser profile; sources use a fresh one each time, as a private window would be.
 * Passkeys come from virtual authenticators with PRF, as in Settle's e2e.
 *
 *   npm run e2e --workspace @zk-toip/tipline              # builds the web apps first
 *   npm run e2e --workspace @zk-toip/tipline -- --no-build
 *   add --headed to watch
 *
 * Screenshots land in web/e2e-shots/; timings in results/e2e.json.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { encodeMembershipCode } from "@zk-toip/anon-membership";
import { startPlatform } from "../src/platform/platform";
import { withExif } from "../tests/fixtures/images";

const HERE = import.meta.dirname;
const SHOTS = join(HERE, "e2e-shots");
mkdirSync(SHOTS, { recursive: true });
const step = (s: string) => console.log(`  \x1b[2m·\x1b[0m ${s}`);
const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });

if (!process.argv.includes("--no-build")) {
  const r = spawnSync("npx", ["vite", "build", "--config", join(HERE, "vite.config.ts"), "--logLevel", "warn"], { stdio: "inherit", cwd: join(HERE, "..") });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const platform = await startPlatform({ ports: { outlet: 0, inbox: 0, acme: 0, wallet: 0, relay: 0 }, web: "static", seed: 58 });
const U = platform.urls;
const browser: Browser = await chromium.launch({ headless: !process.argv.includes("--headed") });
const failures: string[] = [];
const timings: Record<string, number[]> = { proveSeconds: [] };

function watch(page: Page, who: string) {
  page.on("pageerror", (e) => failures.push(`${who} page error: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) failures.push(`${who} console: ${m.text()}`);
  });
}

async function person(who: string, passkey = true): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
  const page = await ctx.newPage();
  if (passkey) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
    });
  }
  watch(page, who);
  return { ctx, page };
}

/** A source's private window: a fresh profile, every request recorded. */
async function privateWindow(who: string) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const requests: string[] = [];
  ctx.on("request", (r) => requests.push(r.url()));
  const page = await ctx.newPage();
  page.on("websocket", (ws) => requests.push(ws.url()));
  watch(page, who);
  return { ctx, page, requests };
}

const value = (page: Page, label: string) => page.getByLabel(label, { exact: true }).first().getAttribute("data-value").then((v) => v ?? "");

async function storageLeft(page: Page) {
  return page.evaluate(async () => ({
    localStorage: localStorage.length,
    sessionStorage: sessionStorage.length,
    indexedDB: (await indexedDB.databases()).map((d) => d.name),
    caches: (await caches.keys()).length,
    cookies: document.cookie,
    serviceWorkers: (await navigator.serviceWorker?.getRegistrations?.())?.length ?? 0,
  }));
}

function checkAllowlist(who: string, requests: string[]) {
  const allowed = [U.outlet, U.relay, U.acme].map((u) => new URL(u));
  for (const r of requests) {
    if (r.startsWith("data:") || r.startsWith("blob:")) continue;
    const u = new URL(r);
    if (!allowed.some((a) => a.host === u.host)) failures.push(`${who} made a request outside its allowlist: ${r}`);
    if (/aztec|crs\./i.test(r)) failures.push(`${who} fetched setup data: ${r}`);
  }
}

async function wallet(name: string, passkey: boolean) {
  const { ctx, page } = await person(`${name}'s wallet`, passkey);
  await page.goto(U.wallet);
  await page.getByLabel("Your name").fill(name);
  if (passkey) await page.getByRole("button", { name: "Make wallet with a passkey" }).click();
  else {
    await page.getByRole("button", { name: "Use a passphrase instead" }).click();
    await page.getByLabel("Passphrase").fill("correct horse battery staple");
    await page.getByRole("button", { name: "Make wallet", exact: true }).click();
  }
  await page.getByLabel("Wallet ID").waitFor();
  return { ctx, page, did: await value(page, "Wallet ID") };
}

async function addEmployee(hr: Page, name: string, did: string) {
  await hr.getByRole("button", { name: "Employees" }).click();
  await hr.getByLabel("Name", { exact: true }).fill(name);
  await hr.getByLabel("Wallet ID").fill(did);
  await hr.getByRole("button", { name: "Add employee" }).click();
  await hr.locator(`tr[data-name="${name}"]`).waitFor();
}

async function joinAndGetCode(page: Page) {
  await page.getByRole("button", { name: "Join Acme Chemicals employees" }).click();
  await page.getByTestId("joined").waitFor();
}

async function membershipCodeOf(page: Page) {
  await page.getByRole("button", { name: "Check my membership" }).click();
  await page.getByTestId("in-root").waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Show membership code" }).click();
  return value(page, "Membership code");
}

/** A tip from a fresh private window. Returns the tip code. */
async function sendTip(o: { who: string; code: string; subject: string; text: string; photo?: Buffer; shots?: string }) {
  const w = await privateWindow(o.who);
  const { page } = w;
  await page.goto(`${U.outlet}/tip/ledger-sam`);
  await page.getByRole("button", { name: "Send a new tip" }).click();
  await page.getByTestId("group-ok").waitFor({ timeout: 15000 });
  await page.getByLabel("Membership code", { exact: true }).fill(o.code);
  await page.getByRole("button", { name: "Check code" }).click();
  await page.getByTestId("member-ok").waitFor();
  await page.getByLabel("Subject", { exact: true }).fill(o.subject);
  await page.getByLabel("What you know").fill(o.text);
  if (o.photo) {
    await page.getByLabel("Files", { exact: true }).setInputFiles({ name: "IMG_20261105_0712.jpg", mimeType: "image/jpeg", buffer: o.photo });
    await page.getByTestId("cleaned-1").waitFor();
    const cleaned = await page.getByTestId("cleaned-1").innerText();
    if (!cleaned.startsWith("Cleaned")) failures.push(`the photo wasn't cleaned: ${cleaned}`);
    for (const t of ["GPS position", "Camera model: Pixel 8"]) if (!(await page.getByText(t).count())) failures.push(`the source app didn't show "${t}" in the photo`);
    if (o.shots) await shot(page, `${o.shots}-photo-cleaned`);
  }
  await page.getByLabel("I've checked my tip and files for these.").check();
  await page.getByRole("button", { name: "Get my tip code" }).click();
  const tipCode = (await page.getByTestId("tip-code").getAttribute("data-value"))!;
  if (o.shots) await shot(page, `${o.shots}-tip-code`);
  await page.getByRole("button", { name: "I've written it down. Send my tip" }).click();
  await page.getByText("Your tip is on its way").waitFor({ timeout: 60000 });
  const proved = await page.getByText(/Proved membership in [\d.]+ s/).innerText();
  timings.proveSeconds.push(Number(/in ([\d.]+) s/.exec(proved)![1]));
  if (o.shots) await shot(page, `${o.shots}-sent`);
  await page.getByRole("button", { name: "I'm done" }).click();
  await page.getByText("You can close this window now").waitFor();
  const left = await storageLeft(page);
  if (left.localStorage || left.sessionStorage || left.indexedDB.length || left.caches || left.cookies || left.serviceWorkers) failures.push(`${o.who} left storage behind: ${JSON.stringify(left)}`);
  checkAllowlist(o.who, w.requests);
  await w.ctx.close();
  return tipCode;
}

/** A photo of a valve log, drawn in a browser, then given EXIF a phone would write: model, serial, GPS. */
async function valvePhoto(page: Page): Promise<Buffer> {
  const b64 = await page.evaluate(async () => {
    const c = new OffscreenCanvas(900, 600);
    const g = c.getContext("2d")!;
    g.fillStyle = "#f3efe2";
    g.fillRect(0, 0, 900, 600);
    g.fillStyle = "#222";
    g.font = "bold 34px serif";
    g.fillText("RIVERSIDE PLANT  VALVE PRESSURE LOG", 40, 70);
    g.font = "24px monospace";
    const rows = [
      ["DATE", "VALVE", "PSI", "INIT"],
      ["11-02", "V-7", "412", "MB"],
      ["11-03", "V-7", "455", "MB"],
      ["11-04", "V-7", "498", "PR"],
      ["11-05", "V-7", "  -", "  "],
    ];
    rows.forEach((r, i) => r.forEach((cell, j) => g.fillText(cell, 60 + j * 200, 150 + i * 60)));
    g.strokeStyle = "#b03030";
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(250, 370);
    g.lineTo(600, 395);
    g.stroke();
    const blob = await c.convertToBlob({ type: "image/jpeg", quality: 0.9 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (const x of bytes) s += String.fromCharCode(x);
    return btoa(s);
  });
  return Buffer.from(withExif(Buffer.from(b64, "base64"), { make: "Google", model: "Pixel 8", serial: "38251FDJH00A7Q", lat: 29.7194, lon: -95.2005 }));
}

async function openTip(inbox: Page, subject: string) {
  await inbox.getByRole("button", { name: new RegExp(subject) }).first().waitFor({ timeout: 30000 });
  await inbox.getByRole("button", { name: new RegExp(subject) }).first().click();
  await inbox.getByTestId("verified").waitFor();
}

try {
  console.log("\nTipline in a browser\n");

  step("1. Acme's HR console shows its group, seeded with 58 enrolled employees");
  const { page: hr } = await person("HR", false);
  await hr.goto(U.acme);
  await hr.getByText("58").first().waitFor();
  await shot(hr, "01-acme-roster");

  step("2. Priya and Marcus make wallets, HR adds them, and they enroll");
  const priya = await wallet("Priya Raman", true);
  const marcus = await wallet("Marcus Bell", false);
  const sealed = await priya.page.evaluate(() => localStorage.getItem("wallet.accounts") ?? "");
  if (!sealed.includes('"kind":"passkey"')) failures.push("Priya's wallet key isn't sealed with a passkey");
  await addEmployee(hr, "Priya Raman", priya.did);
  await addEmployee(hr, "Marcus Bell", marcus.did);
  await joinAndGetCode(priya.page);
  await joinAndGetCode(marcus.page);
  await hr.reload();
  await hr.getByText(/60\s*of 60 employees/).waitFor();
  await hr.locator('tr[data-name="Priya Raman"]').getByText("Enrolled").waitFor();
  await shot(hr, "02-acme-priya-enrolled");

  step("   Acme publishes today's signed list: 60 members");
  await hr.getByRole("button", { name: "Member lists" }).click();
  await hr.getByRole("button", { name: "Publish today's list" }).click();
  await hr.getByRole("button", { name: "Today's list is published" }).waitFor();
  await hr.getByRole("button", { name: "Show signed document" }).first().click();
  const doc = JSON.parse(await hr.getByTestId("root-doc").innerText());
  if (doc.size !== 60 || !doc.proof || !doc.snapshotHash) failures.push(`the root document isn't what the demo says: ${JSON.stringify(doc).slice(0, 200)}`);
  await shot(hr, "03-acme-root-published");
  const priyaCode = await membershipCodeOf(priya.page);
  const marcusCode = await membershipCodeOf(marcus.page);
  await shot(priya.page, "04-wallet-membership-code");

  step("3. Sam sets up a drop box with a passkey and opens a story for Acme's employees");
  const { page: inbox } = await person("Sam");
  await inbox.goto(U.inbox);
  await inbox.getByRole("button", { name: "Create drop box with a passkey" }).click();
  await inbox.getByRole("heading", { name: "Open a story" }).waitFor({ timeout: 20000 });
  await shot(inbox, "05-inbox-open-story");
  await inbox.getByRole("button", { name: "Sign and publish" }).click();
  await inbox.getByTestId("source-count").waitFor();
  await shot(inbox, "06-inbox-story-open");

  step("4. Priya tips from a private window: checks the group, proves, attaches a photo that gets cleaned");
  const photo = await valvePhoto(hr);
  const tipCode = await sendTip({
    who: "Priya (first tip)",
    code: priyaCode,
    subject: "Valve 7 pressure log was rewritten",
    text: "The log for valve V-7 showed pressure rising for three days before the 5 November release. The 11-05 entry was blanked and the sheet re-filed. Photo of the original attached.",
    photo,
    shots: "07-source",
  });

  step("5. Acme's relay panel shows only a fresh key sending same-size messages to the drop box");
  await hr.getByRole("button", { name: "Relay" }).click();
  await hr.getByTestId("relay-table").waitFor();
  await hr.waitForTimeout(2500);
  const relayRows = await hr.locator("tr[data-to]").evaluateAll((rows) => rows.map((r) => ({ from: r.getAttribute("data-from"), to: r.getAttribute("data-to"), bytes: Number(r.getAttribute("data-bytes")) })));
  const toDropbox = relayRows.filter((r) => r.from !== priya.did && r.from !== marcus.did && r.bytes > 200_000);
  if (toDropbox.length < 2 || new Set(toDropbox.map((r) => r.bytes)).size !== 1) failures.push(`the relay panel didn't show same-size messages to the drop box: ${JSON.stringify(relayRows)}`);
  if (relayRows.some((r) => r.from === priya.did && r.bytes > 100_000)) failures.push("Priya's employee DID sent a tip-sized message");
  await shot(hr, "08-acme-relay-panel");

  step("6. Sam's inbox: Source A, a verified member of Acme's employees; the photo has no metadata");
  await openTip(inbox, "Valve 7 pressure log");
  const verified = await inbox.getByTestId("verified").innerText();
  if (!/A member of Acme Chemicals employees \(60 members\) as of .*Designed-to-be-zero-knowledge proof verified/.test(verified)) failures.push(`verified line: ${verified}`);
  await inbox.getByRole("heading", { name: "Source A" }).waitFor();
  await inbox.getByTestId("no-metadata").waitFor({ timeout: 20000 });
  await shot(inbox, "09-inbox-source-a");

  step("7. Sam replies; Priya has closed her window");
  await inbox.getByLabel("Reply to Source A").fill("Thank you. Who else saw the original log, and when was it re-filed?");
  await inbox.getByRole("button", { name: "Send reply" }).click();
  await inbox.getByText("Thank you. Who else saw").waitFor();

  step("8. A day later, Priya comes back in a new private window with only her tip code");
  await hr.getByRole("button", { name: "Skip ahead a day" }).click();
  await hr.waitForTimeout(1500);
  {
    const w = await privateWindow("Priya (returning)");
    await w.page.goto(`${U.outlet}/tip/ledger-sam`);
    await w.page.getByRole("button", { name: "I have a tip code" }).click();
    await w.page.getByLabel("Tip code").fill(tipCode.toLowerCase().replace(/-/g, " "));
    await w.page.getByRole("button", { name: "Open my tip" }).click();
    await w.page.getByText("Thank you. Who else saw").waitFor({ timeout: 30000 });
    await w.page.getByTestId("receipt").waitFor({ timeout: 20000 });
    await w.page.getByText("The log for valve V-7").waitFor({ timeout: 20000 });
    await shot(w.page, "10-source-reads-reply");
    await w.page.getByLabel("Reply to Sam Ortiz").fill("Two shift supervisors saw it. It was re-filed the morning after, before the inspector came.");
    await w.page.getByRole("button", { name: "Send reply" }).click();
    await w.page.waitForTimeout(1500);
    await w.page.getByRole("button", { name: "I'm done" }).click();
    const left = await storageLeft(w.page);
    if (left.localStorage || left.indexedDB.length || left.caches) failures.push(`returning source left storage: ${JSON.stringify(left)}`);
    checkAllowlist("Priya (returning)", w.requests);
    await w.ctx.close();
  }
  await inbox.getByText("Two shift supervisors saw it.").waitFor({ timeout: 30000 });
  await shot(inbox, "11-inbox-thread");

  step("9. Priya sends a second tip with a new tip code: still Source A");
  await sendTip({ who: "Priya (second tip)", code: priyaCode, subject: "Second tip: the inspector's visit", text: "The inspector was shown the re-filed sheet on 6 November." });
  await openTip(inbox, "Second tip");
  await inbox.getByRole("heading", { name: "Source A" }).waitFor();
  await inbox.getByText("Not the first tip from Source A").waitFor();
  await shot(inbox, "12-inbox-same-source");

  step("10. Marcus tips on the same story: Source B; 2 distinct members");
  await sendTip({ who: "Marcus", code: marcusCode, subject: "Maintenance was told to wait", text: "We asked to replace the V-7 seal in October and were told to wait for the next budget." });
  await openTip(inbox, "Maintenance was told");
  await inbox.getByRole("heading", { name: "Source B" }).waitFor();
  await inbox.getByRole("button", { name: /Valve failures at Acme/ }).click();
  await inbox.getByText(/2 distinct members of this group\. The issuer could control some of them/).waitFor();
  await shot(inbox, "13-inbox-two-sources");

  step("    A non-member can't send a tip that proves membership");
  {
    const w = await privateWindow("non-member");
    await w.page.goto(`${U.outlet}/tip/ledger-sam`);
    await w.page.getByRole("button", { name: "Send a new tip" }).click();
    await w.page.getByTestId("group-ok").waitFor({ timeout: 15000 });
    const fake = encodeMembershipCode(BigInt("0x" + "7".repeat(60)), platform.acme.groupId);
    await w.page.getByLabel("Membership code", { exact: true }).fill(fake);
    await w.page.getByRole("button", { name: "Check code" }).click();
    await w.page.getByText("This code isn't in the group's recent roots").waitFor();
    if (!(await w.page.getByLabel("Subject", { exact: true }).isDisabled())) failures.push("a non-member could write a tip");
    await w.page.getByLabel("Membership code", { exact: true }).fill("ABCD-EFGH-JKMN");
    await w.page.getByRole("button", { name: "Check code" }).click();
    await w.page.getByText("That code has a typo").waitFor();
    await shot(w.page, "14-source-non-member");
    await w.ctx.close();
  }

  step("11. Acme removes Marcus; four days on, his old proof is refused as stale");
  await hr.getByRole("button", { name: "Employees" }).click();
  await hr.getByRole("button", { name: "Remove Marcus Bell" }).click();
  await hr.locator('tr[data-name="Marcus Bell"]').getByText("Left").waitFor();
  for (let i = 0; i < 4; i++) {
    await hr.getByRole("button", { name: "Skip ahead a day" }).click();
    await hr.waitForTimeout(700);
  }
  await marcus.page.getByRole("button", { name: "Check my membership" }).click();
  await marcus.page.getByText("You are not in the newest member list").waitFor({ timeout: 15000 });
  {
    const w = await privateWindow("Marcus (removed)");
    await w.page.goto(`${U.outlet}/tip/ledger-sam`);
    await w.page.getByRole("button", { name: "Send a new tip" }).click();
    await w.page.getByTestId("group-ok").waitFor({ timeout: 15000 });
    await w.page.getByLabel("Membership code", { exact: true }).fill(marcusCode);
    await w.page.getByRole("button", { name: "Check code" }).click();
    await w.page.getByText(/Your membership is only in the list of/).waitFor();
    await w.page.getByLabel("Subject", { exact: true }).fill("After I was let go");
    await w.page.getByLabel("What you know").fill("They removed me the day after I asked about V-7.");
    await w.page.getByLabel("I've checked my tip and files for these.").check();
    await w.page.getByRole("button", { name: "Get my tip code" }).click();
    await w.page.getByRole("button", { name: "I've written it down. Send my tip" }).click();
    await w.page.getByText("Your tip is on its way").waitFor({ timeout: 60000 });
    await w.ctx.close();
  }
  await inbox.locator("details.refused summary").waitFor({ timeout: 30000 });
  await inbox.locator("details.refused summary").click();
  await inbox.locator('li[data-reason="stale"]').waitFor({ timeout: 30000 });
  await shot(inbox, "15-inbox-stale-refused");

  step("12. Acme cheats: a second signed list for today on The Ledger's mirror. Priya's app refuses; Sam's inbox keeps the evidence");
  await hr.getByRole("button", { name: "Member lists" }).click();
  await hr.getByLabel("Employee").selectOption({ label: "Priya Raman" });
  await hr.getByRole("button", { name: "Sign a second list and put it on the mirror" }).click();
  await hr.getByText("The Ledger's mirror is serving a second list").waitFor();
  await shot(hr, "16-acme-cheats");
  {
    const w = await privateWindow("Priya (during the cheat)");
    await w.page.goto(`${U.outlet}/tip/ledger-sam`);
    await w.page.getByRole("button", { name: "Send a new tip" }).click();
    await w.page.getByText("Don't send a tip to this story right now").waitFor({ timeout: 15000 });
    await w.page.getByText(/signed two different roots/).waitFor();
    await shot(w.page, "17-source-refuses-equivocation");
    await w.ctx.close();
  }
  await inbox.getByText(/signed two different member lists for/).waitFor({ timeout: 20000 });
  await shot(inbox, "18-inbox-equivocation");

  step("13. What Acme knows: Priya's DID only in its roster; her nullifier nowhere");
  await openTip(inbox, "Valve 7 pressure log");
  await inbox.getByText("The number behind the label").click();
  const nullifier = await value(inbox, "Nullifier");
  await hr.getByRole("button", { name: "What we know" }).click();
  const search = async (q: string) => {
    await hr.getByLabel("Search for").fill(q);
    await hr.getByRole("button", { name: "Search", exact: true }).click();
    await hr.getByTestId("search-results").waitFor();
    await hr.waitForTimeout(300);
    return hr.locator("tr[data-found]").evaluateAll((rows) => rows.map((r) => [r.querySelector("th")!.textContent, r.getAttribute("data-found")]));
  };
  const didHits = await search(priya.did);
  if (!didHits.some(([w, f]) => w!.startsWith("HR roster") && f === "true")) failures.push(`Acme should find Priya's DID in its roster: ${JSON.stringify(didHits)}`);
  const nullHits = await search(nullifier);
  if (nullHits.some(([, f]) => f === "true")) failures.push(`Acme found Priya's nullifier: ${JSON.stringify(nullHits)}`);
  await shot(hr, "19-acme-searches-nullifier");

  mkdirSync(join(HERE, "..", "results"), { recursive: true });
  writeFileSync(join(HERE, "..", "results", "e2e.json"), JSON.stringify({ date: new Date().toISOString(), browser: "Chromium (Playwright)", ...timings }, null, 2) + "\n");
} catch (e) {
  failures.push(`stopped: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  for (const [i, ctx] of browser.contexts().entries()) for (const p of ctx.pages()) await shot(p, `zz-failure-${i}`).catch(() => {});
} finally {
  await browser.close();
  await platform.close();
}

if (failures.length) {
  console.log(`\n\x1b[31m${failures.length} problem${failures.length === 1 ? "" : "s"}:\x1b[0m`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`\n\x1b[32mThe demo ran end to end.\x1b[0m Proving took ${timings.proveSeconds.map((s) => `${s} s`).join(", ")}. Screenshots in ${SHOTS}\n`);
process.exit(0);
