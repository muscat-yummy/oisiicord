import { chromium } from "playwright";
import { createApp } from "../src/server.ts";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const temp = mkdtempSync(resolve(tmpdir(), "oisiicord-beta-ui-"));
const settings = resolve(temp, "settings"),
  shots = resolve(import.meta.dir, "../test-results/beta");
mkdirSync(shots, { recursive: true });
const app = createApp({
  port: 31992,
  origin: "http://localhost:31992",
  path: resolve(temp, "chat.sqlite"),
  settingsDirectory: settings,
});
const code = crypto.randomUUID();
writeFileSync(
  resolve(settings, "beta.json"),
  JSON.stringify({ beta_mode: true, code }),
);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.TEST_BROWSER_EXECUTABLE
    ? { executablePath: process.env.TEST_BROWSER_EXECUTABLE }
    : {}),
  args: JSON.parse(process.env.TEST_BROWSER_ARGS ?? "[]"),
});
const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  }),
  page = await context.newPage(),
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.setDefaultTimeout(15000);
async function capture(name) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    );
  });
  await page.screenshot({
    path: resolve(shots, name + ".png"),
    fullPage: true,
  });
}
try {
  await page.goto(app.origin);
  assert.equal(await page.locator("#invite-code").isVisible(), false);
  await page.locator("#auth-switch").click();
  await page.locator("#invite-code").waitFor({ state: "visible" });
  assert.equal(await page.locator("#invite-code").getAttribute("required"), "");
  await capture("registration-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await capture("registration-mobile");
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.locator("#username").fill("beta_ui");
  await page.locator("#display").fill("Panda");
  await page.locator("#password").fill(crypto.randomUUID());
  await page.locator("#invite-code").fill(crypto.randomUUID());
  await page.locator("#auth-submit").click();
  await page
    .getByText("招待コードが正しくありません", { exact: true })
    .waitFor();
  await page.locator("#invite-code").fill(code);
  await page.locator("#auth-submit").click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  const other = await browser.newContext({
      viewport: { width: 390, height: 844 },
    }),
    login = await other.newPage();
  await login.goto(app.origin);
  await login.locator("#auth-switch").click();
  await login.locator("#invite-code").waitFor({ state: "visible" });
  await login.locator("#auth-switch").click();
  assert.equal(await login.locator("#invite-code").isVisible(), false);
  assert.equal(
    await login.locator("#invite-code").getAttribute("required"),
    null,
  );
  writeFileSync(
    resolve(settings, "beta.json"),
    JSON.stringify({ beta_mode: false, code }),
  );
  await Promise.all([
    login.waitForResponse((r) => r.url().endsWith("/api/auth/registration")),
    login.locator("#auth-switch").click(),
  ]);
  assert.equal(await login.locator("#invite-code").isVisible(), false);
  assert.deepEqual(errors, []);
  console.log(
    "Passed: required invite field, rejected wrong code, successful registration, login without code and live disable",
  );
} finally {
  await browser.close();
  app.stop();
  rmSync(temp, { recursive: true, force: true });
}
