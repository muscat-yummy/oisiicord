import { chromium, webkit } from "playwright";
import { createApp } from "../src/server.ts";
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const directory = mkdtempSync(resolve(tmpdir(), "oisiicord-search-")),
  shots = resolve(import.meta.dir, "../test-results/search");
mkdirSync(shots, { recursive: true });
const app = createApp({
  port: 31978,
  origin: "http://localhost:31978",
  path: resolve(directory, "chat.sqlite"),
  settingsDirectory: resolve(directory, "settings"),
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
const errors = [],
  requests = [];
async function account(name) {
  const context = await browser.newContext({
    viewport: { width: 1180, height: 820 },
    hasTouch: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (r.url().includes("/api/"))
      requests.push(r.url() + " " + (r.postData() ?? ""));
  });
  await page.goto(app.origin);
  await page.locator("#auth-switch").click();
  await page.locator("#username").fill(name);
  await page.locator("#display").fill(name);
  await page.locator("#password").fill(crypto.randomUUID());
  await page.locator("#auth-submit").click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  return page;
}
async function guild(page, name, first = false) {
  if (!first) {
    await page.locator("#add-guild").click();
  }
  await page
    .getByRole("button", { name: "サーバーを作成", exact: true })
    .click();
  await page.locator("#modal-body input").fill(name);
  await page.locator("#modal-submit").click();
  await page.locator("#modal").waitFor({ state: "hidden" });
  await page.locator("#side-title").filter({ hasText: name }).waitFor();
  await page.locator("#room-name").filter({ hasText: "一般" }).waitFor();
}
async function send(page, text) {
  await page.locator("#message-input").fill(text);
  await page.locator("#send").click();
  await page.waitForFunction(
    () => document.querySelector("#message-input").value === "",
  );
}
async function search(page, query) {
  await page.getByLabel("検索語", { exact: true }).fill(query);
  await page
    .locator("#global-search-dialog")
    .getByRole("button", { name: "検索", exact: true })
    .click();
  await page
    .locator(".global-search-status")
    .filter({ hasText: /件を検索/ })
    .waitFor();
}
async function shot(page, name) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    );
  });
  await page.waitForFunction(() => {
    const r = document
      .querySelector("#global-search-dialog")
      .getBoundingClientRect();
    return (
      r.left >= -1 &&
      r.top >= -1 &&
      r.right <= innerWidth + 1 &&
      r.bottom <= innerHeight + 1
    );
  });
  await page.screenshot({
    path: resolve(shots, engine + "-" + name + ".png"),
    fullPage: true,
  });
  const dimensions = await page.evaluate(() => ({
    root: document.scrollingElement.scrollTop,
    width: document.documentElement.scrollWidth,
    viewport: innerWidth,
    body: document.documentElement.scrollHeight,
    height: innerHeight,
  }));
  assert.equal(dimensions.root, 0);
  assert.ok(dimensions.width <= dimensions.viewport + 1);
  assert.ok(dimensions.body <= dimensions.height + 1);
}
async function run() {
  try {
    const a = await account("search_alice");
    if (process.env.TEST_SEARCH_FOCUS === "layout") {
      await a.locator("#global-search").click();
      for (const [width, height, name] of [
        [1180, 820, "desktop"],
        [820, 700, "tablet"],
        [390, 844, "phone"],
        [390, 430, "phone-short"],
      ]) {
        await a.setViewportSize({ width, height });
        await shot(a, "layout-" + name);
        for (const label of ["横断検索を閉じる", "結果を書き出す"]) {
          const box = await a
            .getByRole("button", { name: label, exact: true })
            .boundingBox();
          assert.ok(
            box.x >= 0 &&
              box.y >= 0 &&
              box.x + box.width <= width + 1 &&
              box.y + box.height <= height + 1,
          );
        }
      }
      console.log(
        JSON.stringify({
          engine,
          focus: "layout",
          allDialogBounds: true,
          closeAndExportVisible: true,
        }),
      );
      return;
    }
    const b = await account("search_bob");
    await guild(a, "開発", true);
    await send(a, "BEFORE_EDIT");
    const edited = a.locator(".message").filter({ hasText: "BEFORE_EDIT" });
    await edited.click();
    await edited
      .getByRole("button", { name: "メッセージを編集", exact: true })
      .click();
    await a.locator("#modal-body textarea").fill("OISII_UNIQUE_ERR 修正済み");
    await a.locator("#modal-submit").click();
    await a.locator(".message-text").filter({ hasText: "修正済み" }).waitFor();
    await send(a, "SHOULD_DISAPPEAR");
    const removed = a
      .locator(".message")
      .filter({ hasText: "SHOULD_DISAPPEAR" });
    await removed.click();
    await removed
      .getByRole("button", { name: "メッセージを削除", exact: true })
      .click({ modifiers: ["Shift"] });
    await removed.waitFor({ state: "detached" });
    await send(a, "a".repeat(2000) + "!");
    await guild(a, "運用");
    await send(a, "```ts\nconst issue = 'OISII_UNIQUE_ERR';\n```");
    const bob = (
      await b.evaluate(async () => await (await fetch("/api/state")).json())
    ).me;
    await a.evaluate(async (id) => {
      const r = await fetch("/api/dms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: id }),
      });
      if (!r.ok) throw Error(await r.text());
    }, bob.id);
    await a.locator("#home").click();
    await a
      .locator("#channel-list .channel")
      .filter({ hasText: "search_bob" })
      .click();
    await send(a, "OISII_UNIQUE_ERR DMでも見つかる");
    await a.locator("#global-search").click();
    if (!process.env.TEST_SEARCH_FOCUS) {
      await search(a, "OISII_UNIQUE_ERR");
      assert.equal(await a.locator(".search-result").count(), 3);
      await shot(a, "all-results");
      await search(a, "SHOULD_DISAPPEAR");
      assert.equal(await a.locator(".search-result").count(), 0);
      await search(a, "BEFORE_EDIT");
      assert.equal(await a.locator(".search-result").count(), 0);
      await a.getByLabel("内容", { exact: true }).selectOption("code");
      await a.getByLabel("正規表現", { exact: true }).check();
      await search(a, "const\\s+issue");
      assert.equal(await a.locator(".search-result").count(), 1);
      const downloaded = a.waitForEvent("download");
      await a
        .getByRole("button", { name: "結果を書き出す", exact: true })
        .click();
      const file = await downloaded;
      const exported = JSON.parse(readFileSync(await file.path(), "utf8"));
      assert.equal(exported.messages.length, 1);
      assert.match(exported.messages[0].text, /const issue/);
      assert.equal(exported.messages[0].server, "運用");
      await a.locator(".search-result").click();
      await a.locator("#global-search-dialog").waitFor({ state: "hidden" });
      assert.equal(await a.locator("#side-title").textContent(), "運用");
      await a.locator(".message-jump-highlight").waitFor();
      await a.locator("#global-search").click();
    }
    await a.getByLabel("内容", { exact: true }).selectOption("all");
    await a.evaluate(() => {
      window.searchTicks = 0;
      window.searchTickTimer = setInterval(() => window.searchTicks++, 50);
    });
    await a.getByLabel("正規表現", { exact: true }).check();
    if (engine === "webkit")
      await a.route("**/search-worker.js", (route) =>
        route.fulfill({
          contentType: "text/javascript",
          body: "self.onmessage=()=>{while(true){}};",
        }),
      );
    await a.getByLabel("検索語", { exact: true }).fill("^(a+)+$");
    await a
      .locator("#global-search-dialog")
      .getByRole("button", { name: "検索", exact: true })
      .click();
    await a.getByText(/検索処理がタイムアウトしました/).waitFor();
    assert.ok((await a.evaluate(() => window.searchTicks)) > 8);
    await a.evaluate(() => clearInterval(window.searchTickTimer));
    if (engine === "webkit") await a.unroute("**/search-worker.js");
    await a.getByLabel("正規表現", { exact: true }).uncheck();
    await search(a, "OISII_UNIQUE_ERR");
    assert.equal(await a.locator(".search-result").count(), 3);
    for (const [width, height, name] of [
      [820, 700, "tablet"],
      [390, 844, "phone"],
      [390, 430, "phone-short"],
    ]) {
      await a.setViewportSize({ width, height });
      await shot(a, name);
      const footer = await a
        .locator("#global-search-dialog footer")
        .boundingBox();
      assert.ok(footer.y >= 0 && footer.y + footer.height <= height + 1);
    }
    assert.ok(requests.every((r) => !r.includes("OISII_UNIQUE_ERR")));
    assert.ok(
      app.db
        .query("SELECT envelope FROM events")
        .all()
        .every((r) => !r.envelope.includes("OISII_UNIQUE_ERR")),
    );
    // Closing and resetting during logout clears results and search terms.
    await a
      .getByRole("button", { name: "横断検索を閉じる", exact: true })
      .click();
    await a.setViewportSize({ width: 1180, height: 820 });
    await a.locator("#profile-settings").click();
    await a.getByRole("button", { name: "ログアウト", exact: true }).click();
    await a.locator("#auth").waitFor({ state: "visible" });
    assert.equal(await a.locator("#global-search-dialog").count(), 0);
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        engine,
        focus: process.env.TEST_SEARCH_FOCUS ?? "all",
        allServersAndDMs: true,
        timeoutFixture: engine === "webkit",
        editedAndDeleted: !process.env.TEST_SEARCH_FOCUS,
        regexTimeout: true,
        export: !process.env.TEST_SEARCH_FOCUS,
        jump: !process.env.TEST_SEARCH_FOCUS,
        tablet: true,
        phone: true,
        noPlaintextRequests: true,
        logoutCleared: true,
      }),
    );
  } catch (error) {
    for (const context of browser.contexts())
      for (const page of context.pages())
        await page
          .screenshot({
            path: resolve(
              shots,
              engine +
                "-diagnostic-" +
                browser.contexts().indexOf(context) +
                ".png",
            ),
            fullPage: true,
          })
          .catch(() => {});
    throw error;
  } finally {
    await browser.close();
    app.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}
await run();
