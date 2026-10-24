// Optional browser integration test. Run with bun run test:browser after installing Chromium.
import { chromium as playwright } from "playwright";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const temp = mkdtempSync(resolve(tmpdir(), "oisiicord-ui-"));
const output = resolve(root, "data/ui-test-artifacts");
mkdirSync(output, { recursive: true });
const child = spawn(process.execPath, ["src/server.ts"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: "31998",
    APP_ORIGIN: "http://localhost:31998",
    DATABASE_PATH: resolve(temp, "test.sqlite"),
    OISIICORD_DATA_DIR: resolve(temp, "storage"),
  },
});
process.on("exit", () => child.kill());
await new Promise((resolve, reject) => {
  const timeout = setTimeout(
    () => reject(Error("server startup timeout")),
    10000,
  );
  child.stdout.once("data", () => {
    clearTimeout(timeout);
    resolve();
  });
  child.once("error", reject);
  child.once("exit", () => reject(Error("server exited")));
});
const browser = await playwright.launch({
  ...(process.env.TEST_BROWSER_EXECUTABLE
    ? { executablePath: process.env.TEST_BROWSER_EXECUTABLE }
    : {}),
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
  ],
  headless: true,
});
try {
  const errors = [];
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    permissions: ["microphone", "camera"],
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:31998");
  await page.locator("#auth-switch").click();
  await page.locator("#username").fill("ui_alice");
  await page.locator("#display").fill("Panda");
  await page.locator("#password").fill("Test-password-ui-2026");
  await page.locator("#auth-submit").click();
  await page.waitForFunction(
    () =>
      !document.querySelector("#workspace").hidden ||
      document.querySelector("#auth-error").textContent,
  );
  await page.locator("#workspace").waitFor({ state: "visible" });
  await page
    .getByRole("button", { name: "サーバーを作成", exact: true })
    .click();
  await page.locator("#modal-body input").fill("Oisiicord 開発");
  await page.locator("#modal-submit").click();
  await page
    .getByRole("heading", { name: "一般", exact: true, level: 1 })
    .waitFor();
  await page
    .locator("#message-input")
    .fill("暗号化メッセージの表示と改変検知を確認");
  await page.locator("#send").click();
  await page
    .getByText("暗号化メッセージの表示と改変検知を確認", { exact: true })
    .waitFor();
  await page.locator(".message").hover();
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page
    .locator("#modal-body textarea")
    .fill("署名を検証した編集済みのメッセージ");
  await page.locator("#modal-submit").click();
  await page
    .getByText("署名を検証した編集済みのメッセージ", { exact: false })
    .waitFor();
  await page.locator(".message").hover();
  await page.getByRole("button", { name: "反応", exact: true }).click();
  await page.getByRole("button", { name: "👍", exact: true }).click();
  await page.getByRole("button", { name: "👍 1", exact: true }).waitFor();
  await page.locator(".message").hover();
  await page
    .getByRole("button", { name: "ピン留め", exact: true })
    .last()
    .click();
  await page.locator(".pinned-label").filter({ hasText: "ピン留め" }).waitFor();
  await page.locator("#side-menu").click();
  await page.getByRole("button", { name: "友達を招待", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "参加に承認が必要", exact: true })
    .check();
  await page.getByRole("button", { name: "リンクを作成", exact: true }).click();
  const invite = await page
    .getByLabel("招待リンク", { exact: true })
    .inputValue();
  await page.locator("#modal-close").click();
  const c2 = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    permissions: ["microphone", "camera"],
  });
  const p2 = await c2.newPage();
  p2.on("pageerror", (e) => errors.push(e.message));
  await p2.goto(invite);
  await p2.locator("#auth-switch").click();
  await p2.locator("#username").fill("ui_bob");
  await p2.locator("#display").fill("Bob");
  await p2.locator("#password").fill("Test-password-bob-2026");
  await p2.locator("#auth-submit").click();
  await p2.getByRole("button", { name: "参加申請", exact: true }).click();
  await page.getByRole("button", { name: "Bob を確認", exact: true }).click();
  await page.getByRole("button", { name: "承認", exact: true }).click();
  await p2.getByRole("button", { name: "Oisiicord 開発", exact: true }).click();
  await p2
    .getByRole("heading", { name: "一般", exact: true, level: 1 })
    .waitFor();
  await p2.locator("#message-input").fill("Bob から暗号化して送信");
  await p2.locator("#send").click();
  await page.getByText("Bob から暗号化して送信", { exact: true }).waitFor();
  await page
    .locator("#message-input")
    .fill("添付なし・ブラウザ内復号・署名を確認済み");
  await page.locator("#send").click();
  await p2
    .getByText("添付なし・ブラウザ内復号・署名を確認済み", { exact: true })
    .waitFor();
  await page.screenshot({ path: output + "/desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: output + "/mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page
    .getByRole("button", { name: "ボイスラウンジ", exact: false })
    .click();
  await p2
    .getByRole("button", { name: "ボイスラウンジ", exact: false })
    .click();
  await page.waitForFunction(
    () => document.querySelectorAll(".call-tile").length === 2,
  );
  await p2.waitForFunction(
    () => document.querySelectorAll(".call-tile").length === 2,
  );
  await page.locator("#mute").click();
  await page.locator("#hangup").click();
  await p2.locator("#hangup").click();
  console.log(
    JSON.stringify({
      ui: "passed",
      errors,
      invite: "owner approval tested",
      voice: "two browser contexts received tracks",
      screenshots: ["oisiicord-ui.png", "oisiicord-mobile.png"],
    }),
  );
  if (errors.length) throw Error(errors.join("\n"));
} finally {
  await browser.close();
  child.kill();
  rmSync(temp, { recursive: true, force: true });
}
