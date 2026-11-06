/**
 * Records the real app: two browser profiles, Alice and Bob, using a running relay and web app
 * (`npm run dev` at the repository root). Nothing is mocked; this is the app as people use it.
 *
 *   npx tsx video/record-app.ts        (from projects/shared-todo)
 *
 * Writes video/out/alice.webm, video/out/bob.webm and video/out/markers.json.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "playwright";

const APP = process.env.APP_URL ?? "http://localhost:5181/";
const OUT = join(import.meta.dirname, "out");
const SIZE = { width: 900, height: 900 };
const run = Date.now().toString(36);
mkdirSync(OUT, { recursive: true });

let start = Date.now();
const markers: { t: number; label: string }[] = [];
const mark = (label: string) => {
  markers.push({ t: (Date.now() - start) / 1000, label });
  console.log(`${((Date.now() - start) / 1000).toFixed(1)}s ${label}`);
};
const beat = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A visible cursor, since headless recordings don't draw one.
const CURSOR = `
  window.addEventListener('DOMContentLoaded', () => {
    const c = document.createElement('div');
    c.id = '__cursor';
    Object.assign(c.style, { position: 'fixed', left: '450px', top: '450px', width: '22px', height: '22px', borderRadius: '50%',
      background: 'rgba(46,106,79,0.35)', border: '2px solid #2e6a4f', zIndex: 99999, pointerEvents: 'none',
      transform: 'translate(-50%,-50%)', transition: 'left .45s ease, top .45s ease, transform .15s' });
    document.body.appendChild(c);
  });`;

async function point(page: Page, target: Locator) {
  const box = await target.boundingBox();
  if (!box) return;
  await page.evaluate(([x, y]) => {
    const c = document.getElementById("__cursor");
    if (c) Object.assign(c.style, { left: `${x}px`, top: `${y}px` });
  }, [box.x + box.width / 2, box.y + box.height / 2]);
  await beat(500);
}
async function click(page: Page, target: Locator) {
  await point(page, target);
  await page.evaluate(() => {
    const c = document.getElementById("__cursor");
    if (c) c.style.transform = "translate(-50%,-50%) scale(0.7)";
  });
  await target.click();
  await beat(150);
  await page.evaluate(() => {
    const c = document.getElementById("__cursor");
    if (c) c.style.transform = "translate(-50%,-50%)";
  });
}
async function type(page: Page, target: Locator, text: string) {
  await click(page, target);
  await target.pressSequentially(text, { delay: 55 });
}

const browser = await chromium.launch();
const make = async () => {
  const context = await browser.newContext({ viewport: SIZE, deviceScaleFactor: 1, recordVideo: { dir: OUT, size: SIZE } });
  await context.addInitScript(CURSOR);
  return { context, page: await context.newPage() };
};
const alice = await make();
start = Date.now(); // markers are timed from the start of Alice's recording
const bob = await make();
const bobOffset = (Date.now() - start) / 1000; // Bob's recording starts this much later
await bob.page.setContent(`<body style="margin:0;height:100vh;display:grid;place-items:center;background:#f7f8f6;font:22px system-ui;color:#5f6b65">Bob hasn't opened the app yet</body>`);

// ---- Alice sets up
const A = alice.page;
await A.goto(`${APP}?profile=alice-${run}`);
mark("alice-first-run");
await beat(1200);
await type(A, A.getByLabel("Your name"), "Alice");
await click(A, A.getByRole("button", { name: "Continue" }));
await A.getByText("Connected").waitFor();
mark("alice-connected");
await beat(900);
await click(A, A.getByRole("button", { name: "New list" }).first());
await type(A, A.getByLabel("List name"), "Maple St House");
await click(A, A.getByRole("button", { name: "Create list" }));
mark("list-created");
await beat(700);
for (const item of ["Milk", "Fix the porch light"]) {
  await type(A, A.getByLabel("New item"), item);
  await click(A, A.getByRole("button", { name: "Add", exact: true }));
  await beat(400);
}
mark("items-added");
await beat(800);
await click(A, A.getByRole("button", { name: /^People/ }));
await beat(500);
await click(A, A.getByRole("button", { name: "Make an invitation" }));
const link = await A.getByLabel("Invitation link").inputValue();
mark("invitation");
await beat(2500);
await click(A, A.getByRole("button", { name: "Close" }));

// ---- Bob joins from the link
const B = bob.page;
const token = link.slice(link.indexOf("#invite="));
await B.goto(`${APP}?profile=bob-${run}${token}`);
mark("bob-opens-link");
await beat(1000);
await type(B, B.getByLabel("Your name"), "Bob");
await click(B, B.getByRole("button", { name: "Continue" }));
await B.getByText(/invited you/).waitFor();
await beat(1500);
await click(B, B.getByRole("button", { name: "Ask to join" }));
mark("bob-asks");
await B.getByRole("heading", { name: "Maple St House" }).waitFor();
await B.getByText("Milk").waitFor();
mark("bob-joined");
await beat(1500);

// ---- Edits flow both ways
await click(B, B.getByLabel("Done: Milk"));
await beat(400);
await type(B, B.getByLabel("New item"), "Eggs");
await click(B, B.getByRole("button", { name: "Add", exact: true }));
mark("bob-edits");
await A.getByText("Eggs").waitFor();
await beat(1500);

// ---- A private item
await click(A, A.getByText("Private", { exact: true }));
await click(A, A.locator(".readers label", { hasText: "Bob" }));
await type(A, A.getByLabel("New item"), "Carol's birthday present");
await click(A, A.getByRole("button", { name: "Add", exact: true }));
mark("private-item");
await B.getByText("Carol's birthday present").waitFor();
await beat(2000);

// ---- Bob goes offline, keeps working, comes back
await bob.context.setOffline(true);
await B.evaluate(() => window.dispatchEvent(new Event("offline")));
await B.getByText(/Offline|Connecting/).waitFor({ timeout: 20000 });
mark("bob-offline");
await beat(800);
await type(B, B.getByLabel("New item"), "Bread");
await click(B, B.getByRole("button", { name: "Add", exact: true }));
mark("bob-adds-offline");
await beat(3000);
await bob.context.setOffline(false);
await A.getByText("Bread").waitFor({ timeout: 30000 });
mark("bread-arrives");
await beat(1500);

// ---- What's happening
await click(A, A.getByRole("button", { name: "Show what's happening" }));
await beat(800);
const received = A.locator(".log .row", { hasText: "Received op from Bob" }).first();
await click(A, received);
mark("inspector");
await beat(4000);
mark("end");

const files = [await A.video()!.path(), await B.video()!.path()];
await alice.context.close();
await bob.context.close();
await browser.close();
renameSync(files[0], join(OUT, "alice.webm"));
renameSync(files[1], join(OUT, "bob.webm"));
writeFileSync(join(OUT, "markers.json"), JSON.stringify({ markers, bobOffset }, null, 2));
console.log("wrote", OUT);
