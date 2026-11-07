import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { BASE } from "./config";
import { serve } from "./serve";

let browser: Browser;
let server: ReturnType<typeof serve>;
let root: string;

before(async () => {
  server = serve(0);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  root = `http://127.0.0.1:${address.port}${BASE}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.close();
});

test("SDK search opens a generated API page with public method details", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${root}toolkit/`);
    await page.getByRole("searchbox", { name: "Find an export" }).fill("web-vault unlock");
    assert.ok(await page.locator('#api-results a[href$="/web-vault/api/createVault/"]').count(), "Search should include methods on factory return values");
    await page.getByRole("searchbox", { name: "Find an export" }).fill("Endpoint");
    assert.ok(await page.locator('#api-results a[href$="/trust-core/api/Endpoint/"]').count(), "Search should find the Endpoint reference");
    await page.locator('#api-results a[href$="/trust-core/api/Endpoint/"]').click();
    assert.equal(await page.getByRole("heading", { level: 1 }).innerText(), "Endpoint");
    assert.ok(await page.locator("#member-request").count());
    assert.ok(await page.locator("#member-close").count());
    assert.equal(await page.locator("#member-settle").count(), 0);
  } finally { await page.close(); }
});

for (const width of [390, 1440]) {
  test(`ecosystem guide is reachable from the homepage at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      await page.goto(root);
      assert.ok(!/P2P Trust Stack|TrustStackers/.test(await page.locator("main").innerText()), "The homepage should focus on this toolkit; project comparisons belong in the ecosystem guide");
      const homeSize = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
      assert.ok(homeSize.content <= homeSize.viewport, "The homepage should fit the viewport");
      const link = page.getByRole("navigation", { name: "Site", exact: true }).getByRole("link", { name: "Ecosystem", exact: true });
      assert.equal(await link.count(), 1, "The ecosystem guide should be in the main navigation");
      await link.click();
      assert.match(page.url(), /\/ecosystem\/$/);
      assert.equal(await link.getAttribute("aria-current"), "page");
      await page.getByRole("heading", { level: 1 }).waitFor({ state: "visible" });
      const dimensions = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
      assert.ok(dimensions.content <= dimensions.viewport, "The guide should fit the viewport");
    } finally {
      await page.close();
    }
  });
}

test("image opens in a named modal; Escape closes it and restores focus", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${root}examples/`);
    const thumbnail = page.locator(".shots a").first();
    const imageUrl = await thumbnail.getAttribute("href");
    const alt = await thumbnail.locator("img").getAttribute("alt");
    const pageUrl = page.url();
    await thumbnail.click();
    const dialog = page.getByRole("dialog", { name: "Image preview" });
    await dialog.waitFor({ state: "visible" });
    assert.equal(page.url(), pageUrl);
    assert.equal(await dialog.locator("img").getAttribute("src"), new URL(imageUrl!, root).href);
    assert.equal(await dialog.locator("img").getAttribute("alt"), alt);
    assert.ok(await dialog.locator("figcaption").textContent());
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.ok(await thumbnail.evaluate((el) => el === document.activeElement));
  } finally {
    await page.close();
  }
});

test("image modal closes with its button and backdrop on mobile", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.goto(`${root}examples/`);
    const thumbnail = page.locator(".shots a").nth(1);
    const pageUrl = page.url();
    await thumbnail.click();
    const dialog = page.getByRole("dialog", { name: "Image preview" });
    await dialog.waitFor({ state: "visible" });
    assert.equal(page.url(), pageUrl);
    const image = await dialog.locator("img").boundingBox();
    assert.ok(image && image.width <= 390 && image.height <= 844);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    assert.ok(await dialog.evaluate((el) => el.contains(document.activeElement)));
    await dialog.getByRole("button", { name: "Close image preview" }).click();
    await dialog.waitFor({ state: "hidden" });
    await thumbnail.click();
    await dialog.waitFor({ state: "visible" });
    await page.mouse.click(2, 2);
    await dialog.waitFor({ state: "hidden" });
  } finally {
    await page.close();
  }
});

test("image links still work without JavaScript", async () => {
  const page = await browser.newPage({ javaScriptEnabled: false });
  try {
    await page.goto(`${root}examples/`);
    const thumbnail = page.locator(".shots a").first();
    const imageUrl = await thumbnail.getAttribute("href");
    await thumbnail.click();
    assert.equal(page.url(), new URL(imageUrl!, root).href);
  } finally {
    await page.close();
  }
});
