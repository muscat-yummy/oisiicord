import { chromium } from "playwright";
import { createApp } from "../src/server.ts";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const root = resolve(import.meta.dir, ".."),
  temp = mkdtempSync(resolve(tmpdir(), "oisiicord-login-"));
const app = createApp({
  path: resolve(temp, "chat.sqlite"),
  port: 31991,
  origin: "http://localhost:31991",
});
const profile = resolve(temp, "browser"),
  screenshots = resolve(root, "docs/screenshots");
mkdirSync(screenshots, { recursive: true });
const options = {
  headless: true,
  viewport: { width: 1440, height: 960 },
  ...(process.env.TEST_BROWSER_EXECUTABLE
    ? { executablePath: process.env.TEST_BROWSER_EXECUTABLE }
    : {}),
  args: JSON.parse(process.env.TEST_BROWSER_ARGS ?? "[]"),
};
let context, page;
const errors = [];
// Disposable accounts exist only in this test's temporary local database.
const password = crypto.randomUUID(),
  nextPassword = crypto.randomUUID();
async function launch() {
  context = await chromium.launchPersistentContext(profile, options);
  page = context.pages()[0] ?? (await context.newPage());
  track(page);
}
function track(p) {
  p.setDefaultTimeout(12000);
  p.on("pageerror", (e) => errors.push(e.message));
}
async function goto() {
  await page.goto(app.origin);
}
async function workspace() {
  await page.locator("#workspace").waitFor({ state: "visible" });
}
async function login(pass = password) {
  await page.locator("#username").fill("persistent_login");
  await page.locator("#password").fill(pass);
  await page.locator("#auth-submit").click();
  await workspace();
}
async function selectGuild() {
  await page
    .locator("#guild-list")
    .getByRole("button", { name: "ログイン保持", exact: true })
    .click();
  await page.locator("#room-name").filter({ hasText: "一般" }).waitFor();
}
async function capture(name) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: resolve(screenshots, name + ".png"),
    fullPage: true,
  });
}
async function saved() {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open("oisiicord-device", 1);
        r.onsuccess = () => {
          const db = r.result,
            tx = db.transaction("login", "readonly"),
            q = tx.objectStore("login").get("current");
          q.onsuccess = () => {
            db.close();
            resolve(
              q.result
                ? {
                    user: q.result.user,
                    session: q.result.session,
                    extractable: q.result.sign.extractable,
                    fields: Object.keys(q.result),
                  }
                : null,
            );
          };
          q.onerror = () => reject(q.error);
        };
        r.onerror = () => reject(r.error);
      }),
  );
}
try {
  await launch();
  await goto();
  await page.locator("#auth-switch").click();
  await page.locator("#username").fill("persistent_login");
  await page.locator("#display").fill("Panda");
  await page.locator("#password").fill(password);
  await page.locator("#auth-submit").click();
  await workspace();
  await page
    .getByRole("button", { name: "サーバーを作成", exact: true })
    .click();
  await page.locator("#modal-body input").fill("ログイン保持");
  await page.locator("#modal-submit").click();
  await page.locator("#room-name").filter({ hasText: "一般" }).waitFor();
  await page
    .locator("#message-input")
    .fill("タブを閉じても、この会話を引き継ぐ。");
  await page.locator("#send").click();
  await page
    .locator(".message-text")
    .filter({ hasText: "この会話を引き継ぐ" })
    .waitFor();
  const data = await saved();
  assert.equal(data.extractable, false);
  assert.deepEqual(
    data.fields.sort(),
    ["session", "expires", "user", "keys", "sign", "exchange"].sort(),
  );
  await page.close();
  page = await context.newPage();
  track(page);
  await goto();
  await workspace();
  await selectGuild();
  await page
    .locator(".message-text")
    .filter({ hasText: "この会話を引き継ぐ" })
    .waitFor();
  console.log("Tab reopening restored the account and decrypted history");
  await context.close();
  await launch();
  await goto();
  await workspace();
  await selectGuild();
  await page
    .locator(".message-text")
    .filter({ hasText: "この会話を引き継ぐ" })
    .waitFor();
  console.log("Browser reopening restored the account");
  await page.locator("#message-input").fill("@Pan");
  await page.getByRole("option").filter({ hasText: "Panda" }).waitFor();
  await capture("mentions-picker");
  await page.locator("#message-input").press("Enter");
  assert.equal(
    await page.locator("#message-input").inputValue(),
    "<@" + data.user + "> ",
  );
  await page.locator("#message-input").press("End");
  await page.locator("#message-input").press("Enter");
  await page.locator("button.mention").filter({ hasText: "@Panda" }).waitFor();
  await page.locator("#message-input").fill("@everyone 全体への連絡");
  await page.locator("#send").click();
  await page
    .locator(".message.is-mentioned")
    .filter({ hasText: "全体への連絡" })
    .waitFor();
  await capture("mentions-chat");
  // The private keys are usable after cloning, but cannot be exported.
  assert.equal(
    await page.evaluate(
      async () =>
        new Promise((resolve, reject) => {
          const r = indexedDB.open("oisiicord-device", 1);
          r.onsuccess = () => {
            const db = r.result,
              q = db.transaction("login").objectStore("login").get("current");
            q.onsuccess = async () => {
              try {
                await crypto.subtle.exportKey("pkcs8", q.result.sign);
                resolve(false);
              } catch {
                resolve(true);
              } finally {
                db.close();
              }
            };
          };
          r.onerror = () => reject(r.error);
        }),
    ),
    true,
  );
  const previousVault = await page.evaluate(
    async () => (await (await fetch("/api/auth/session")).json()).vault,
  );
  await page.locator("#profile-settings").click();
  await page
    .getByRole("button", { name: "パスワードを変更", exact: true })
    .click();
  await page.getByLabel("現在のパスワード", { exact: true }).fill(password);
  await page.getByLabel("新しいパスワード", { exact: true }).fill(nextPassword);
  await page
    .getByLabel("新しいパスワード（確認）", { exact: true })
    .fill(nextPassword);
  await page.locator("#modal-submit").click();
  await page.locator("#modal").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "設定を閉じる", exact: true }).click();
  await page.reload();
  await workspace();
  assert.notDeepEqual(
    await page.evaluate(
      async () => (await (await fetch("/api/auth/session")).json()).vault,
    ),
    previousVault,
  );
  const second = await context.newPage();
  track(second);
  await second.goto(app.origin);
  await second.locator("#workspace").waitFor({ state: "visible" });
  await page.locator("#profile-settings").click();
  await page.getByRole("button", { name: "ログアウト", exact: true }).click();
  await page.locator("#auth").waitFor({ state: "visible" });
  await second.locator("#auth").waitFor({ state: "visible" });
  assert.equal(await saved(), null);
  assert.equal(
    await page.evaluate(async () => (await fetch("/api/auth/session")).status),
    401,
  );
  await second.close();
  await page.reload();
  await page.locator("#auth").waitFor({ state: "visible" });
  await login(nextPassword);
  // A new cookie without its matching local keys must not restore a different session.
  await page.evaluate(async (pass) => {
    const C = await import("/crypto.js");
    const { salt } = await (
      await fetch("/api/auth/salt?username=persistent_login")
    ).json();
    const credential = await C.credentials(pass, salt);
    const r = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "persistent_login",
        auth: credential.auth,
      }),
    });
    if (!r.ok) throw Error(await r.text());
  }, nextPassword);
  await page.reload();
  await page.locator("#auth").waitFor({ state: "visible" });
  assert.equal(await saved(), null);
  await login(nextPassword);
  app.db.query("UPDATE sessions SET expires=?").run(Date.now() - 1);
  await page.reload();
  await page.locator("#auth").waitFor({ state: "visible" });
  assert.equal(await saved(), null);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      tabReopen: true,
      browserReopen: true,
      historyDecrypted: true,
      nonExtractable: true,
      passwordChange: true,
      logoutAcrossTabs: true,
      sessionMismatchBlocked: true,
      expiredSessionBlocked: true,
    }),
  );
} catch (error) {
  console.error(
    "UI",
    await page
      ?.locator("#auth-error")
      .textContent()
      .catch(() => ""),
    await page
      ?.locator("#toast")
      .textContent()
      .catch(() => ""),
  );
  await page
    ?.screenshot({
      path: resolve(screenshots, "login-diagnostic.png"),
      fullPage: true,
    })
    .catch(() => {});
  throw error;
} finally {
  await context?.close();
  app.stop();
  rmSync(temp, { recursive: true, force: true });
}
