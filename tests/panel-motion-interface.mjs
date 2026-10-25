import { chromium, webkit } from "playwright";
import { createApp } from "../src/server.ts";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const temp = mkdtempSync(resolve(tmpdir(), "oisiicord-motion-")),
  shots = resolve(import.meta.dir, "../test-results/motion");
mkdirSync(shots, { recursive: true });
const app = createApp({
  port: 31994,
  origin: "http://localhost:31994",
  path: resolve(temp, "chat.sqlite"),
  settingsDirectory: resolve(temp, "settings"),
});
const engine = process.env.TEST_BROWSER_ENGINE ?? "chromium";
const browser = await (engine === "webkit" ? webkit : chromium).launch({
  headless: true,
  ...(engine !== "webkit" && process.env.TEST_BROWSER_EXECUTABLE
    ? { executablePath: process.env.TEST_BROWSER_EXECUTABLE }
    : {}),
  args:
    engine === "webkit"
      ? []
      : JSON.parse(process.env.TEST_BROWSER_ARGS ?? "[]"),
});
const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  }),
  errors = [];
page.setDefaultTimeout(12000);
page.on("pageerror", (e) => errors.push(e.message));
async function settled() {
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    );
  });
}
async function midFrame(selector, name) {
  const running = await page.locator(selector).evaluate((el) => {
    const animations = el.getAnimations();
    for (const a of animations) {
      a.pause();
      a.currentTime = Number(a.effect.getTiming().duration) * 0.4;
    }
    return animations.length;
  });
  assert.ok(running > 0, "animation is running: " + name);
  await page.screenshot({
    path: resolve(shots, engine + "-" + name + ".png"),
    fullPage: true,
  });
  await page.locator(selector).evaluate((el) => {
    for (const a of el.getAnimations()) a.play();
  });
  await settled();
}
try {
  await page.goto(app.origin);
  await page.locator("#auth-switch").click();
  await page.locator("#username").fill("motion_" + engine);
  await page.locator("#display").fill("Panda");
  await page.locator("#password").fill(crypto.randomUUID());
  await page.locator("#auth-submit").click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  await page.locator("#mobile-channels").click();
  await midFrame(".sidebar", "channels-open");
  assert.equal(
    await page.locator(".sidebar").evaluate((el) => el.inert),
    false,
  );
  await page
    .getByRole("button", { name: "チャンネルを閉じる", exact: true })
    .click();
  assert.equal(await page.locator(".sidebar").evaluate((el) => el.inert), true);
  await midFrame(".sidebar", "channels-close");
  assert.equal(await page.locator(".sidebar").isVisible(), false);
  await page.locator("#toggle-members").click();
  await midFrame("#members-panel", "members-open");
  await page
    .getByRole("button", { name: "メンバーを閉じる", exact: true })
    .click();
  await midFrame("#members-panel", "members-close");
  assert.equal(await page.locator("#members-panel").isVisible(), false);
  await page.locator("#mobile-tools").click();
  await midFrame("#mobile-toolbar", "tools-open");
  assert.equal(await page.locator("#search").isVisible(), true);
  await page.locator("#mobile-tools").click();
  await midFrame("#mobile-toolbar", "tools-close");
  assert.equal(await page.locator("#mobile-toolbar").isVisible(), false);
  // Reverse running transitions and toolbar animations without leaving a stale backdrop.
  await page.evaluate(() => {
    const b = document.querySelector("#mobile-channels");
    b.click();
    b.click();
    b.click();
  });
  await settled();
  assert.equal(await page.locator(".sidebar").isVisible(), true);
  await page.locator("#panel-backdrop").click({ position: { x: 380, y: 300 } });
  await settled();
  assert.equal(await page.locator(".sidebar").isVisible(), false);
  await page.evaluate(() => {
    const b = document.querySelector("#mobile-tools");
    b.click();
    b.click();
    b.click();
  });
  await settled();
  assert.equal(await page.locator("#search").isVisible(), true);
  await page.keyboard.press("Escape");
  await settled();
  assert.equal(await page.locator("#mobile-toolbar").isVisible(), false);
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.locator("#toggle-members").click();
  await midFrame("#members-panel", "tablet-members-open");
  await page.keyboard.press("Escape");
  await settled();
  assert.equal(await page.locator("#members-panel").isVisible(), false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.locator("#mobile-channels").click();
  assert.equal(
    await page.locator(".sidebar").evaluate((el) => el.getAnimations().length),
    0,
  );
  await page.keyboard.press("Escape");
  await page.locator("#mobile-tools").click();
  assert.equal(
    await page
      .locator("#mobile-toolbar")
      .evaluate((el) => el.getAnimations().length),
    0,
  );
  await page.keyboard.press("Escape");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(async () => {
    const { updatePreferences } = await import("/preferences.js");
    updatePreferences({ reducedMotion: true });
  });
  await page.locator("#toggle-members").click();
  assert.equal(
    await page
      .locator("#members-panel")
      .evaluate((el) => el.getAnimations().length),
    0,
  );
  await page.keyboard.press("Escape");
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      engine,
      passed: true,
      opening: true,
      closing: true,
      rapidReversal: true,
      toolbar: true,
      tablet: true,
      reducedMotion: true,
    }),
  );
} catch (error) {
  await page
    .screenshot({
      path: resolve(shots, engine + "-diagnostic.png"),
      fullPage: true,
    })
    .catch(() => {});
  throw error;
} finally {
  await browser.close();
  app.stop();
  rmSync(temp, { recursive: true, force: true });
}
