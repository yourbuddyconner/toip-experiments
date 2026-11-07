/**
 * The demo, driven through a real browser with Chromium's fake camera: enroll a camera, take a photo,
 * verify it (untrusted, then trusted), find a stripped copy in the registry, redact a face and verify the
 * edit back to the device, catch a tampered file, read a C2PA sample, retire the key and catch the thief's
 * next photo, and watch verified sensor readings.
 *
 *   npm run e2e --workspace @zk-toip/capture              # Vite dev server
 *   npm run e2e --workspace @zk-toip/capture -- --static  # the built app (npm run build:web first)
 *   add --headed to watch
 *
 * Screenshots land in web/e2e-shots/.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { withoutStore } from "../src/core";
import { startWorld } from "../src/world/world";

const SHOTS = join(import.meta.dirname, "e2e-shots");
mkdirSync(SHOTS, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
const step = (s: string) => console.log(`  \x1b[2m·\x1b[0m ${s}`);
const dataDir = mkdtempSync(join(tmpdir(), "capture-e2e-"));
const world = await startWorld({ port: 0, dataDir, drand: "dev", web: process.argv.includes("--static") ? "static" : "dev", sensorIntervalMs: 1500, sealEvery: 3, beaconEveryMs: 3000 });
const browser = await chromium.launch({ headless: !process.argv.includes("--headed"), args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
const failures: string[] = [];
const base = world.appUrl;

async function verdictOf(page: Page): Promise<string> {
  const v = page.getByTestId("verdict");
  await v.waitFor({ timeout: 30_000 });
  return (await v.getAttribute("data-verdict")) ?? "";
}

async function verifyFile(page: Page, path: string): Promise<string> {
  await page.goto(`${base}/verify`);
  await page.getByTestId("verify-input").setInputFiles(path);
  return verdictOf(page);
}

/** After a page load, the tab remembers the camera's account but not its key. */
async function unlockCamera(page: Page) {
  const unlock = page.getByRole("button", { name: /^Unlock / });
  await Promise.race([unlock.waitFor({ timeout: 15_000 }), page.getByRole("button", { name: "Take a photo" }).waitFor({ timeout: 15_000 })]);
  if (await unlock.isVisible()) {
    await page.getByLabel("Passphrase").fill("correct horse battery");
    await unlock.click();
  }
  await page.getByRole("button", { name: "Take a photo" }).waitFor({ timeout: 20_000 });
}

function expect(ok: boolean, what: string) {
  if (!ok) {
    failures.push(what);
    console.log(`  \x1b[31m✕ ${what}\x1b[0m`);
  }
}

try {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, permissions: ["camera"], acceptDownloads: true });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => failures.push(`page error: ${e.message}`));
  page.on("console", (m) => m.type() === "warning" && console.log(`    browser: ${m.text()}`));
  page.on("console", (m) => m.type() === "error" && !/favicon|404|Failed to load resource/.test(m.text()) && failures.push(`console: ${m.text()}`));
  const download = async (click: () => Promise<void>, name: string) => {
    const [d] = await Promise.all([page.waitForEvent("download"), click()]);
    const p = join(dataDir, name);
    await d.saveAs(p);
    return p;
  };

  step("camera: make this browser a camera, with a passphrase");
  await page.goto(`${base}/camera`);
  await page.getByRole("button", { name: "Use a passphrase instead" }).click();
  await page.getByLabel("Passphrase").fill("correct horse battery");
  await page.getByRole("button", { name: "Make this a camera", exact: true }).click();
  await page.getByRole("button", { name: "Take a photo" }).waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => (document.querySelector("video") as HTMLVideoElement | null)?.videoWidth, null, { timeout: 15_000 });

  step("camera: take a photo; it is signed, then anchored by the witnesses");
  await page.getByRole("button", { name: "Take a photo" }).click();
  await page.getByText(/Anchored by 3 witnesses/).first().waitFor({ timeout: 30_000 });
  await shot(page, "01-camera");
  await page.getByRole("button", { name: "Publish" }).first().click();
  await page.getByText("In the registry").first().waitFor();
  const photo = await download(() => page.getByRole("button", { name: /Download photo/ }).first().click(), "photo.jpg");

  step("verifier: the photo is signed, but you don't trust the owner yet");
  await page.getByRole("button", { name: "Verify", exact: true }).first().click();
  expect((await verdictOf(page)) === "untrustedIssuer", "a fresh verifier says 'Signed, issuer not trusted'");
  await shot(page, "02-verify-untrusted");
  step("verifier: trust the owner");
  await page.getByRole("button", { name: /^Trust / }).click();
  await page.waitForFunction(() => document.querySelector("[data-testid=verdict]")?.getAttribute("data-verdict")?.startsWith("verified"), null, { timeout: 30_000 });
  const v1 = await verdictOf(page);
  expect(v1 === "verified" || v1 === "verifiedWithWarnings", `after trusting the owner the photo verifies (got ${v1})`);
  await page.getByText(/Captured between/).waitFor();
  await shot(page, "03-verify-trusted");

  step("verifier: a copy with its credentials stripped is found in the registry");
  const strippedPath = join(dataDir, "stripped.jpg");
  (await import("node:fs")).writeFileSync(strippedPath, withoutStore(new Uint8Array(readFileSync(photo))));
  const vs = await verifyFile(page, strippedPath);
  expect(vs.startsWith("verified"), `the stripped copy verifies through the registry (got ${vs})`);
  expect(await page.getByText("credentials found in the registry").first().isVisible(), "the verifier says the credentials came from the registry");

  step("editor: make an editor identity, blur a face, sign the edit");
  await page.goto(`${base}/camera`);
  await unlockCamera(page);
  await page.getByRole("button", { name: "Edit", exact: true }).first().click();
  await page.getByRole("button", { name: "Use a passphrase instead" }).click();
  await page.getByLabel("Passphrase").fill("another long passphrase");
  await page.getByRole("button", { name: "Make my editor identity", exact: true }).click();
  const canvas = page.getByTestId("editor-canvas");
  await canvas.waitFor({ timeout: 20_000 });
  await page.waitForTimeout(500);
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.38, box.y + box.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.55, { steps: 6 });
  await page.mouse.up();
  await page.getByLabel("How to redact").selectOption("gaussian-12");
  await shot(page, "04-editor");
  await page.getByRole("button", { name: "Sign the edit and save as PNG" }).click();
  await page.getByRole("heading", { name: "Signed" }).waitFor({ timeout: 30_000 });
  const edited = await download(() => page.getByRole("button", { name: "Download PNG" }).click(), "edited.png");

  step("verifier: the edited PNG verifies back to the device, with the redaction proven");
  await page.getByRole("button", { name: "Verify it" }).click();
  const v2 = await verdictOf(page);
  expect(v2 === "verified" || v2 === "verifiedWithWarnings", `the edit verifies (got ${v2})`);
  expect(await page.getByText(/Redacted in one area by M\. Chen/).first().isVisible(), "the verdict names the editor and the redaction");
  expect(await page.getByTestId("tile-overlay").isVisible(), "the tile map is shown");
  expect(await page.getByText(/Unchanged from the capture: \d+ of \d+ tiles/).first().isVisible(), "the tile proof is reported");
  await shot(page, "05-verify-edit");

  step("verifier: a tampered copy shows the break");
  const tampered = join(dataDir, "tampered.png");
  const bytes = new Uint8Array(readFileSync(edited));
  bytes[bytes.length - 40] ^= 0xff;
  (await import("node:fs")).writeFileSync(tampered, bytes);
  const v3 = await verifyFile(page, tampered);
  expect(v3 === "broken", `a tampered file is broken (got ${v3})`);
  expect(await page.getByText(/doesn't match its credentials/).first().isVisible(), "the break is explained");
  await shot(page, "06-verify-tampered");

  step("verifier: Content Credentials (C2PA) are read too");
  await page.goto(`${base}/verify`);
  await page.getByRole("button", { name: "Try a Content Credentials sample" }).click();
  await verdictOf(page);
  const c2pa = page.getByTestId("c2pa-card");
  await page.waitForFunction(() => !document.querySelector("[data-testid=c2pa-card]")?.textContent?.includes("Reading…"), null, { timeout: 30_000 });
  const c2paText = (await c2pa.textContent()) ?? "";
  console.log(`    C2PA card: ${c2paText.replace(/\s+/g, " ").slice(0, 160)}`);
  expect(c2paText.includes("Present"), "the C2PA sample's credentials are read");
  await shot(page, "07-verify-c2pa");

  step("owner: the camera is lost; retire its key");
  await page.goto(`${base}/owner`);
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("article", { name: "Dana's laptop camera" }).getByRole("button", { name: "Retire the key: device lost" }).click();
  await page.getByText(/key is retired/).waitFor({ timeout: 20_000 });
  await shot(page, "08-owner");
  await page.waitForTimeout(4000); // a beacon round later than the rotation's receipts

  step("camera: the thief takes another photo with the old key; it verifies as broken");
  await page.goto(`${base}/camera`);
  await unlockCamera(page);
  await page.getByText(/The owner has retired this camera's key/).waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => (document.querySelector("video") as HTMLVideoElement | null)?.videoWidth, null, { timeout: 15_000 });
  await page.getByRole("button", { name: "Take a photo" }).click();
  await page.getByText(/witnesses refused/).waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Verify", exact: true }).first().click();
  const v4 = await verdictOf(page);
  expect(v4 === "broken", `a photo by the retired key is broken (got ${v4})`);
  expect(await page.getByText(/Signed after this device's key was retired/).first().isVisible(), "the verifier says the key was retired first");
  await shot(page, "09-verify-retired");
  step("verifier: the first photo, anchored before the rotation, still verifies");
  const v5 = await verifyFile(page, photo);
  expect(v5.startsWith("verified"), `the photo anchored before the rotation still verifies (got ${v5})`);
  expect(await page.getByText(/Retired later by the owner; this photo was anchored before that/).first().isVisible(), "the device card says it was anchored before");

  step("sensors: the dashboard shows verified readings");
  await page.goto(`${base}/sensors`);
  await page.getByTestId("station").first().waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => document.querySelectorAll("[data-status=verified]").length >= 6, null, { timeout: 40_000 });
  expect(await page.getByText(/This sensor's clock is wrong/).first().isVisible(), "Rooftop 2's wrong clock is flagged");
  await shot(page, "10-sensors");
  step("sensors: a dishonest gateway changes a reading; it shows as invalid");
  await page.getByLabel(/Dishonest gateway/).click();
  await page.waitForFunction(() => document.querySelectorAll("[data-status=invalid]").length >= 1, null, { timeout: 40_000 });
  await shot(page, "11-sensors-evil");
} catch (e) {
  failures.push(String((e as Error)?.stack ?? e));
} finally {
  await browser.close();
  await world.close();
  rmSync(dataDir, { recursive: true, force: true });
}

if (failures.length) {
  console.log(`\n\x1b[31m${failures.length} failure(s):\x1b[0m\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  process.exit(1);
}
console.log(`\n\x1b[32mThe demo works end to end.\x1b[0m Screenshots: ${SHOTS}`);
process.exit(0);
