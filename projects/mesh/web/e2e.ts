/**
 * The visualizer, driven through a real browser: runs act 1 and act 2 from the page, with the
 * keyboard as well as the mouse, and checks what the page shows. Uses its own server on a free port.
 *
 *   npm run e2e --workspace @zk-toip/mesh              # Vite dev server
 *   npm run e2e --workspace @zk-toip/mesh -- --static  # the built app (npm run build:web first)
 *   add --headed to watch
 *
 * Screenshots land in web/e2e-shots/.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { startApp } from "../src/server";

const SHOTS = join(import.meta.dirname, "e2e-shots");
mkdirSync(SHOTS, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
const step = (s: string) => console.log(`  · ${s}`);
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  if (!ok) failures.push(what);
  console.log(`    ${ok ? "✓" : "✗"} ${what}`);
};

const app = await startApp({ port: 0, web: process.argv.includes("--static") ? "static" : "dev" });
const browser = await chromium.launch({ headless: !process.argv.includes("--headed") });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  step(`open ${app.appUrl}`);
  await page.goto(app.appUrl);
  await page.getByText("Choose an act above to run it on the simulator.").waitFor();
  await shot(page, "0-empty");

  step("act 1 at 0% loss, at 4× speed, started from the keyboard");
  await page.getByLabel("Speed").selectOption("4");
  await page.getByRole("button", { name: /Run the door/ }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: /Act 1: A door with no internet/ }).waitFor();
  // Mid-act: a frame on the air.
  await page.locator(".pulse").first().waitFor({ timeout: 15_000 });
  await shot(page, "1-door-in-flight");
  await page.getByText("✓ door/open response {open: true}").waitFor({ timeout: 30_000 });
  check(await page.getByText(/opened: a valid pass from household 4B/).isVisible(), "the door says it opened for the pass");
  check((await page.getByRole("table", { name: "Sizes of door/open", exact: true }).count()) === 1, "the log shows the presentation's sizes");
  check(await page.getByText(/on the air, INTRO/).first().isVisible(), "the presentation went as an INTRO packet");
  await page.getByText("Act complete").waitFor({ timeout: 60_000 });
  const replay = await page.locator(".summary dd", { hasText: "refused three ways" }).count();
  check(replay === 1, "the replay attack was refused three ways");
  check((await page.getByRole("meter", { name: /Front Door: [\d.]+% of its hourly airtime share/ }).count()) === 1, "the door has an airtime meter");
  await shot(page, "2-door-done");

  step("act 2 at 20% loss");
  await page.getByRole("slider", { name: "Frame loss" }).fill("0.2");
  check((await page.locator(".slider output").textContent()) === "20%", "the loss slider reads 20%");
  await page.getByRole("button", { name: /Run the cabin/ }).click();
  await page.getByRole("heading", { name: /Act 2: An attestation from the cabin/ }).waitFor();
  check(await page.getByText(/frame loss 20%/).isVisible(), "the act ran at 20% loss");
  await page.getByText(/accepted "work complete"/).waitFor({ timeout: 90_000 });
  await page.getByText(/exactly the ones Alice sealed/).waitFor({ timeout: 60_000 });
  check(true, "the landlord's agent got the exact TSP bytes");
  await page.getByText("Act complete").waitFor({ timeout: 60_000 });
  check((await page.locator(".summary dd", { hasText: /^yes$/ }).count()) === 2, "byte-exact and accepted");
  await shot(page, "3-cabin-done");

  step("seek back with the scrubber, and look on a phone-sized screen");
  await page.getByLabel("Position in the act").fill("0");
  await page.setViewportSize({ width: 420, height: 900 });
  await shot(page, "4-narrow");
  check(errors.length === 0, `no errors in the page${errors.length ? `: ${errors.join("; ")}` : ""}`);
} finally {
  await browser.close();
  await app.close();
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`\nAll checks passed. Screenshots in ${SHOTS}`);
