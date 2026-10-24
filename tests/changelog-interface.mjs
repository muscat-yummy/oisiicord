import { chromium } from "playwright";
import { createApp } from "../src/server.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
const temp = mkdtempSync(resolve(tmpdir(), "oisiicord-changelog-"));
const app = createApp({
  path: resolve(temp, "chat.sqlite"),
  port: 31989,
  origin: "http://localhost:31989",
});
const browser = await chromium.launch({
  headless: true,
  ...(process.env.TEST_BROWSER_EXECUTABLE
    ? { executablePath: process.env.TEST_BROWSER_EXECUTABLE }
    : {}),
  args: JSON.parse(process.env.TEST_BROWSER_ARGS ?? "[]"),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } }),
  errors = [];
let content = "";
page.on("pageerror", (e) => errors.push(e.message));
await page.route("**/api/changelog", (r) =>
  r.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ content }),
  }),
);
try {
  await page.goto(app.origin);
  await page.locator("#auth-switch").click();
  await page.locator("#username").fill("changelog_test");
  await page.locator("#display").fill("Panda");
  await page.locator("#password").fill(crypto.randomUUID());
  await page.locator("#auth-submit").click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  assert.equal(await page.locator(".home-updates").count(), 0);
  content =
    "## 2026-10-25 Owner-written update\n\nThis text comes from the configured file.\n\n- First change\n- Second change";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page
    .locator(".update-card h3")
    .filter({ hasText: "Owner-written update" })
    .waitFor();
  assert.equal(await page.locator(".update-card li").count(), 2);
  assert.equal(
    await page.getByText("右クリック、解禁", { exact: true }).count(),
    0,
  );
  await page.screenshot({
    path: "/tmp/oisiicord-changelog.png",
    fullPage: true,
  });
  content = "## Replaced\n\n<script>window.changelogExecuted=true</script>";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page
    .locator(".update-card h3")
    .filter({ hasText: "Replaced" })
    .waitFor();
  assert.equal(await page.locator(".update-card script").count(), 0);
  assert.equal(await page.evaluate(() => window.changelogExecuted), undefined);
  assert.match(await page.locator(".update-card").textContent(), /<script>/);
  content = "";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.locator(".home-updates").waitFor({ state: "detached" });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      configuredText: true,
      emptyHidden: true,
      fileRefresh: true,
      htmlStaysText: true,
    }),
  );
} finally {
  await browser.close();
  app.stop();
  rmSync(temp, { recursive: true, force: true });
}
