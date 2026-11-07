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
