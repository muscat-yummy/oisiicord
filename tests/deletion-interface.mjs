import { chromium } from "playwright";
import { createApp } from "../src/server.ts";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const temp = mkdtempSync(resolve(tmpdir(), "oisiicord-deletion-"));
const shots = resolve(import.meta.dir, "../test-results/deletion");
mkdirSync(shots, { recursive: true });
const app = createApp({
  port: 31990,
  origin: "http://localhost:31990",
  path: resolve(temp, "chat.sqlite"),
});
const browser = await chromium.launch({
  headless: true,
  ...(process.env.TEST_BROWSER_EXECUTABLE
    ? { executablePath: process.env.TEST_BROWSER_EXECUTABLE }
    : {}),
  args: JSON.parse(process.env.TEST_BROWSER_ARGS ?? "[]"),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } }),
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.setDefaultTimeout(15000);
async function send(text) {
  await page.locator("#message-input").fill(text);
  await page.locator("#send").click();
  await page.waitForFunction(
    () => document.querySelector("#message-input").value === "",
  );
}
try {
  await page.goto(app.origin);
  await page.locator("#auth-switch").click();
  await page.locator("#username").fill("deletion_test");
  await page.locator("#display").fill("Panda");
  await page.locator("#password").fill(crypto.randomUUID());
  await page.locator("#auth-submit").click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  await page
    .getByRole("button", { name: "サーバーを作成", exact: true })
    .click();
  await page.locator("#modal-body input").fill("削除の確認");
  await page.locator("#modal-submit").click();
  await page.locator("#room-name").filter({ hasText: "一般" }).waitFor();
  await send("残すメッセージ");
  await send("通常削除の対象");
  const normal = page.locator(".message").filter({ hasText: "通常削除の対象" });
  await normal.hover();
  await normal
    .getByRole("button", { name: "メッセージを削除", exact: true })
    .click();
  await page
    .getByText("このメッセージを削除しますか？", { exact: true })
    .waitFor();
  await page.locator("#modal-submit").click();
  await normal.waitFor({ state: "detached" });
  await send("Shift削除の対象");
  const quick = page.locator(".message").filter({ hasText: "Shift削除の対象" });
  await quick.hover();
  await quick
    .getByRole("button", { name: "メッセージを削除", exact: true })
    .click({ modifiers: ["Shift"] });
  await quick.waitFor({ state: "detached" });
  assert.equal(await page.locator("#modal").isVisible(), false);
  assert.equal(await page.locator(".message").count(), 1);
  assert.equal(
    await page.locator(".message-text").textContent(),
    "残すメッセージ",
  );
  assert.equal(
    await page
      .locator("#messages")
      .getByText(/メッセージを削除/)
      .count(),
    0,
  );
  await page.reload();
  await page.locator("#workspace").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "削除の確認", exact: true }).click();
  await page
    .locator(".message-text")
    .filter({ hasText: "残すメッセージ" })
    .waitFor();
  assert.equal(await page.locator(".message").count(), 1);
  assert.equal(
    await page
      .locator("#messages")
      .getByText(/メッセージを削除/)
      .count(),
    0,
  );
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
    path: resolve(shots, "deleted-messages-hidden.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "Passed: normal deletion, Shift deletion and reload leave no message placeholder",
  );
} finally {
  await browser.close();
  app.stop();
  rmSync(temp, { recursive: true, force: true });
}
