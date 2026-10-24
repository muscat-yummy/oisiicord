import { chromium } from "playwright";
import { createApp } from "../src/server.ts";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const temp = mkdtempSync(resolve(tmpdir(), "oisiicord-workspace-")),
  shots = resolve(import.meta.dir, "../docs/screenshots");
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
const errors = [],
  pages = [];
const password = crypto.randomUUID();
async function account(username, display, url = app.origin) {
  const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
    }),
    page = await context.newPage();
  page.setDefaultTimeout(12000);
  pages.push(page);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  await page.locator("#auth-switch").click();
  await page.locator("#username").fill(username);
  await page.locator("#display").fill(display);
  await page.locator("#password").fill(password);
  await page.locator("#auth-submit").click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  return page;
}
async function state(p) {
  return p.evaluate(async () => (await fetch("/api/state")).json());
}
async function capture(p, name) {
  await p.mouse.move(1300, 500);
  await p.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    );
  });
  await p.screenshot({
    path: resolve(shots, "workspace-" + name + ".png"),
    fullPage: true,
  });
}
async function choose(p, label) {
  await p.getByRole("menuitem", { name: label, exact: true }).click();
}
async function submit(p) {
  await p.locator("#modal-submit").click();
  await p.locator("#modal").waitFor({ state: "hidden" });
}
async function rightChannel(p, name) {
  await p
    .locator("#channel-list .channel")
    .filter({ hasText: name })
    .click({ button: "right" });
}
try {
  const a = await account("workspace_alice", "Panda");
  await a.getByRole("button", { name: "サーバーを作成", exact: true }).click();
  await a.locator("#modal-body input").fill("おいしいコミュニティ");
  await submit(a);
  await a.locator("#room-name").filter({ hasText: "一般" }).waitFor();
  let g, b;
  const rail = a
    .locator("#guild-list")
    .getByRole("button", { name: "おいしいコミュニティ", exact: true });
  if (!process.env.TEST_WORKSPACE_FOCUS) {
    assert.equal(await a.locator(".category-heading").count(), 0);
    await a
      .locator("#channel-list")
      .click({ button: "right", position: { x: 100, y: 350 } });
    await choose(a, "カテゴリを作成");
    await a.getByLabel("カテゴリ名", { exact: true }).fill("雑談");
    await submit(a);
    await a
      .locator(".category-heading")
      .filter({ hasText: "雑談" })
      .click({ button: "right" });
    await capture(a, "category-menu");
    await choose(a, "チャンネルを作成");
    assert.equal(await a.getByLabel("カテゴリ", { exact: true }).count(), 0);
    await a.getByLabel("チャンネル名", { exact: true }).fill("作業部屋");
    await a.getByRole("radio", { name: "テキスト", exact: true }).check();
    await capture(a, "channel-create");
    await submit(a);
    g = (await state(a)).guilds[0];
    assert(
      g.channels.find((r) => r.name === "作業部屋").category ===
        g.categories[0].id,
    );
    await rightChannel(a, "作業部屋");
    await capture(a, "channel-menu");
    await choose(a, "チャンネルを編集");
    await a.getByLabel("チャンネル名", { exact: true }).fill("作業と雑談");
    await a
      .getByLabel("説明", { exact: true })
      .fill("作業中の進捗や、休憩の話を。");
    await a.getByLabel("スローモード", { exact: true }).selectOption("5");
    await capture(a, "channel-editor");
    await submit(a);
    await rightChannel(a, "作業と雑談");
    await choose(a, "チャンネルを複製");
    await a
      .locator("#channel-list .channel")
      .filter({ hasText: "作業と雑談-コピー" })
      .waitFor();
    await rightChannel(a, "作業と雑談-コピー");
    await choose(a, "チャンネルを削除");
    await submit(a);
    assert.equal(
      await a
        .locator("#channel-list .channel")
        .filter({ hasText: "作業と雑談-コピー" })
        .count(),
      0,
    );
    await rightChannel(a, "作業と雑談");
    await choose(a, "カテゴリへ移動");
    await choose(a, "カテゴリなし");
    g = (await state(a)).guilds[0];
    assert.equal(
      g.channels.find((r) => r.name === "作業と雑談").category,
      null,
    );
    await rightChannel(a, "作業と雑談");
    await choose(a, "カテゴリへ移動");
    await choose(a, "雑談");
    await a
      .locator(".category-heading")
      .filter({ hasText: "雑談" })
      .click({ button: "right" });
    await choose(a, "カテゴリを編集");
    await a.getByLabel("カテゴリ名", { exact: true }).fill("雑談室");
    await submit(a);
    await rail.click({ button: "right" });
    await capture(a, "server-menu");
    await choose(a, "友達を招待");
    await a.locator(".invite-panel").waitFor();
    await capture(a, "invite");
    await a.getByRole("button", { name: "リンクを作成", exact: true }).click();
    await a.getByLabel("招待リンク", { exact: true }).waitFor();
    const invite = await a
      .getByLabel("招待リンク", { exact: true })
      .inputValue();
    await capture(a, "invite-link");
    await a.locator("#modal-close").click();
    b = await account("workspace_bob", "てすと", invite);
    await b
      .locator("#modal-submit")
      .filter({ hasText: /^参加$/ })
      .click();
    await b.locator("#modal").waitFor({ state: "hidden" });
    await a.locator("#members .member").filter({ hasText: "てすと" }).waitFor();
    // On a wide screen, the member button must actually hide and show the panel.
    assert.equal(await a.locator("#members-panel").isVisible(), true);
    await a.locator("#toggle-members").click();
    assert.equal(await a.locator("#members-panel").isVisible(), false);
    await a.locator("#toggle-members").click();
    assert.equal(await a.locator("#members-panel").isVisible(), true);
    await a.locator("#members .member").filter({ hasText: "てすと" }).click();
    await a.locator(".workspace-profile").waitFor();
    await capture(a, "profile");
    await a.locator("#modal-close").click();
    await a.locator("#message-input").fill("@");
    await a.getByRole("option").filter({ hasText: "てすと" }).waitFor();
    assert.equal(
      await a
        .getByRole("option")
        .filter({ hasText: "てすと" })
        .locator(".avatar")
        .evaluate((el) => getComputedStyle(el).whiteSpace),
      "nowrap",
    );
    await capture(a, "mentions");
    await a.locator("#message-input").press("Escape");
    await a.locator("#message-input").fill("");
    await a.locator("#home").click();
    await a.locator(".home-person").filter({ hasText: "てすと" }).waitFor();
    await capture(a, "home");
    await a
      .locator(".home-person-profile")
      .filter({ hasText: "てすと" })
      .click();
    await a.locator(".workspace-profile").waitFor();
    await a.locator("#modal-close").click();
    await a.locator("#profile-settings").click();
    await a.locator("[data-tab=accessibility]").click();
    assert.equal(
      await a.locator("[data-tab=accessibility] svg path").count(),
      2,
    );
    await capture(a, "accessibility");
    await a.getByRole("button", { name: "設定を閉じる", exact: true }).click();
  } else {
    // Minimal fixture for the previously unreached mobile/deletion checks.
    await a.evaluate(async () => {
      const g = (await (await fetch("/api/state")).json()).guilds[0];
      async function post(path, body, method = "POST") {
        const r = await fetch("/api" + path, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw Error(await r.text());
        return r.json();
      }
      const c = await post("/guilds/" + g.id + "/categories", {
        name: "雑談室",
      });
      const r = await post("/guilds/" + g.id + "/channels", {
        name: "作業と雑談",
        kind: "text",
        topic: "作業中の進捗や、休憩の話を。",
      });
      await post(
        "/guilds/" + g.id + "/channelmeta/" + r.id,
        { category: c.id, slowmode: 5 },
        "PATCH",
      );
    });
    await a
      .locator(".category-heading")
      .filter({ hasText: "雑談室" })
      .waitFor();
    await rightChannel(a, "作業と雑談");
    await capture(a, "channel-menu");
    await choose(a, "チャンネルを編集");
    await capture(a, "channel-editor");
    await a.locator("#modal-close").click();
    await rail.click({ button: "right" });
    await capture(a, "server-menu");
    await choose(a, "友達を招待");
    await a.locator(".invite-panel").waitFor();
    await capture(a, "invite");
    await a.getByRole("button", { name: "リンクを作成", exact: true }).click();
    await a.getByLabel("招待リンク", { exact: true }).waitFor();
    const invite = await a
      .getByLabel("招待リンク", { exact: true })
      .inputValue();
    await capture(a, "invite-link");
    await a.locator("#modal-close").click();
    b = await account("workspace_bob", "てすと", invite);
    await b
      .locator("#modal-submit")
      .filter({ hasText: /^参加$/ })
      .click();
    await b.locator("#modal").waitFor({ state: "hidden" });
    await a.locator("#members .member").filter({ hasText: "てすと" }).waitFor();
    await a.locator("#members .member").filter({ hasText: "てすと" }).click();
    await capture(a, "profile");
    await a.locator("#modal-close").click();
    await a.locator("#message-input").fill("@");
    await a.getByRole("option").filter({ hasText: "てすと" }).waitFor();
    await capture(a, "mentions");
    await a.locator("#message-input").press("Escape");
    await a.locator("#message-input").fill("");
    await a.locator("#home").click();
    await a.locator(".home-person").filter({ hasText: "てすと" }).waitFor();
    await capture(a, "home");
    await a.locator("#profile-settings").click();
    await a.locator("[data-tab=accessibility]").click();
    await capture(a, "accessibility");
    await a.getByRole("button", { name: "設定を閉じる", exact: true }).click();
  }
  if (process.env.TEST_WORKSPACE_FOCUS === "visual") {
    await a.setViewportSize({ width: 390, height: 844 });
    if (await a.locator("#members-panel").isVisible())
      await a.locator("#toggle-members").click();
    await capture(a, "mobile-home");
  } else {
    await a.setViewportSize({ width: 390, height: 844 });
    if (await a.locator("#members-panel").isVisible())
      await a.locator("#toggle-members").click();
    await capture(a, "mobile-home");
    assert.equal(
      await a.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await a.locator("#toggle-members").click();
    assert.equal(await a.locator("#members-panel").isVisible(), true);
    await a.locator("#toggle-members").click();
    assert.equal(await a.locator("#members-panel").isVisible(), false);
    await a.setViewportSize({ width: 1440, height: 960 });
    await rail.click();
    await a
      .locator(".category-heading")
      .filter({ hasText: "雑談室" })
      .click({ button: "right" });
    await choose(a, "カテゴリを削除");
    await submit(a);
    g = (await state(a)).guilds[0];
    assert.equal(g.categories.length, 0);
    assert(g.channels.some((r) => r.name === "作業と雑談"));
    // Server deletion is owner-only in the menu and requires an exact name.
    await a.locator("#home").click();
    await a
      .getByRole("button", { name: "サーバーを作成", exact: true })
      .click();
    await a.locator("#modal-body input").fill("削除確認用");
    await submit(a);
    await a
      .locator("#guild-list")
      .getByRole("button", { name: "削除確認用", exact: true })
      .click({ button: "right" });
    await choose(a, "サーバーを削除");
    await a
      .getByLabel("削除するサーバー名", { exact: true })
      .fill("削除確認用");
    await submit(a);
    assert.equal((await state(a)).guilds.length, 1);
    await b
      .locator("#guild-list")
      .getByRole("button", { name: "おいしいコミュニティ", exact: true })
      .click({ button: "right" });
    assert.equal(
      await b
        .getByRole("menuitem", { name: "サーバーを削除", exact: true })
        .count(),
      0,
    );
    await b.keyboard.press("Escape");
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      mode: process.env.TEST_WORKSPACE_FOCUS ?? "all",
      contexts: true,
      channelEditor: true,
      categoryMove: true,
      profile: true,
      invite: true,
      memberToggleDesktopMobile: true,
      onlineHome: true,
      mentionLayout: true,
      categoryDeletionPreservesChannels: true,
      serverDelete: true,
    }),
  );
} catch (error) {
  for (const [i, p] of pages.entries()) {
    console.error(
      "UI",
      i,
      await p
        .locator("#toast")
        .textContent()
        .catch(() => ""),
      await p
        .locator("#modal-error")
        .textContent()
        .catch(() => ""),
    );
    await p
      .screenshot({
        path: resolve(shots, "workspace-diagnostic-" + i + ".png"),
        fullPage: true,
      })
      .catch(() => {});
  }
  throw error;
} finally {
  await browser.close();
  app.stop();
  rmSync(temp, { recursive: true, force: true });
}
