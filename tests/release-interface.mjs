import { chromium } from "playwright";
import { createApp } from "../src/server.ts";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const temporary = mkdtempSync(resolve(tmpdir(), "oisiicord-release-"));
const shots = resolve(import.meta.dir, "../docs/release-review/screenshots");
mkdirSync(shots, { recursive: true });
const app = createApp({
  port: 31985,
  origin: "http://localhost:31985",
  path: resolve(temporary, "review.sqlite"),
});
const browser = await chromium.launch({
  headless: true,
  ...(process.env.TEST_BROWSER_EXECUTABLE
    ? { executablePath: process.env.TEST_BROWSER_EXECUTABLE }
    : {}),
  args: JSON.parse(process.env.TEST_BROWSER_ARGS ?? "[]"),
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 960 },
});
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors = [],
  checked = [];
page.on("pageerror", (e) => errors.push(e.message));
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
    path: resolve(shots, "release-" + name + ".png"),
    fullPage: true,
  });
  checked.push(name);
}
async function send(text) {
  await page.locator("#message-input").fill(text);
  await page.locator("#send").click();
  await page.waitForFunction(
    () => document.querySelector("#message-input").value === "",
  );
}
try {
  await page.goto(app.origin);
  await capture("login");
  await page.locator("#auth-switch").click();
  await capture("registration");
  await page.locator("#username").fill("release_review");
  await page.locator("#display").fill("Panda");
  await page.locator("#password").fill(crypto.randomUUID());
  await page.locator("#auth-submit").click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  await page
    .getByRole("button", { name: "サーバーを作成", exact: true })
    .click();
  await page.locator("#modal-body input").fill("リリース確認");
  await page.locator("#modal-submit").click();
  await page.locator("#room-name").filter({ hasText: "一般" }).waitFor();
  for (const text of [
    "普通の本文",
    "😀",
    "👍🏽 ❤️ 🇯🇵",
    "👨‍👩‍👧‍👦",
    "😀😀😀😀",
    "本文と 😀",
    "`😀`",
    "1️⃣#️⃣*️⃣",
  ])
    await send(text);
  assert.equal(await page.locator(".message-text.emoji-only").count(), 4);
  const ratio = await page
    .locator(".message-text.emoji-only .rich-prose")
    .first()
    .evaluate(
      (el) =>
        parseFloat(getComputedStyle(el).fontSize) /
        parseFloat(getComputedStyle(el.parentElement).fontSize),
    );
  assert.equal(ratio, 1.5);
  await capture("emoji-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await capture("emoji-mobile");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.locator("#profile-settings").click();
  for (const tab of [
    "account",
    "profile",
    "appearance",
    "voice",
    "notifications",
    "accessibility",
    "keybinds",
    "sessions",
  ]) {
    await page.locator('[data-tab="' + tab + '"]').click();
    await page
      .locator(".settings-content")
      .getByRole("heading")
      .first()
      .waitFor();
    await capture("user-" + tab);
  }
  await page.getByRole("button", { name: "設定を閉じる", exact: true }).click();
  await page.locator("#side-menu").click();
  await page.getByRole("button", { name: "サーバー設定", exact: true }).click();
  for (const tab of [
    "overview",
    "general",
    "notifications",
    "roles",
    "members",
    "categories",
    "emojis",
    "rules",
    "channels",
    "invites",
    "audit",
    "info",
  ]) {
    await page.locator('[data-tab="' + tab + '"]').click();
    await page
      .locator(".settings-content")
      .getByRole("heading")
      .first()
      .waitFor();
    await capture("server-" + tab);
  }
  await page.getByRole("button", { name: "設定を閉じる", exact: true }).click();
  const fixture = await page.evaluate(async () => {
    const C = await import("/crypto.js"),
      { restoreLogin } = await import("/login-state.js");
    const identity = await restoreLogin(
      await (await fetch("/api/auth/session")).json(),
    );
    const state = await (await fetch("/api/state")).json(),
      guild = state.guilds[0],
      room = guild.channels.find((r) => r.name === "一般");
    return {
      room: room.id,
      guild: guild.id,
      envelope: await C.seal(
        { type: "message", text: "切断中に届いたメッセージ", files: [] },
        {
          room: room.id,
          author: identity.id,
          identity,
          recipients: [state.me],
          version: guild.version,
        },
      ),
    };
  });
  await context.setOffline(true);
  await page.locator("#network-status").waitFor({ state: "visible" });
  await page.locator("#message-input").fill("失敗しても入力は残る");
  await page.locator("#send").click();
  await page.locator("#message-input:not([disabled])").waitFor();
  assert.equal(
    await page.locator("#message-input").inputValue(),
    "失敗しても入力は残る",
  );
  await capture("offline");
  const cookie = (await context.cookies())
    .map((c) => c.name + "=" + c.value)
    .join("; ");
  const received = await fetch(
    app.origin + "/api/rooms/" + fixture.room + "/events",
    {
      method: "POST",
      headers: {
        Origin: app.origin,
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(fixture.envelope),
    },
  );
  assert.equal(received.status, 200);
  await context.setOffline(false);
  await page.locator("#network-status").waitFor({ state: "hidden" });
  await page.getByText("切断中に届いたメッセージ", { exact: true }).waitFor();
  assert.equal(
    await page.locator("#message-input").inputValue(),
    "失敗しても入力は残る",
  );
  await page.locator("#message-input").fill("");
  await capture("reconnected");
  let failHistory = true;
  await page.route("**/api/rooms/*/events?*", async (route) => {
    if (failHistory) {
      failHistory = false;
      return route.fulfill({
        status: 503,
        contentType: "text/html",
        body: "temporary upstream failure",
      });
    }
    return route.continue();
  });
  await page
    .locator("#channel-list .channel")
    .filter({ hasText: "一般" })
    .click();
  await page
    .locator("#history-status")
    .getByRole("button", { name: "再試行", exact: true })
    .waitFor();
  await capture("history-retry");
  await page
    .locator("#history-status")
    .getByRole("button", { name: "再試行", exact: true })
    .click();
  await page.locator("#history-status").waitFor({ state: "hidden" });
  await page.unroute("**/api/rooms/*/events?*");
  const events = await (
    await fetch(app.origin + "/api/rooms/" + fixture.room + "/events?after=0", {
      headers: { Cookie: cookie },
    })
  ).json();
  let pages = 0;
  await page.route("**/api/rooms/*/events?*", async (route) => {
    const after = Number(
      new URL(route.request().url()).searchParams.get("after"),
    );
    const body =
      after < 10000
        ? Array.from({ length: 100 }, (_, i) => ({
            ...events[0],
            seq: after + i + 1,
          }))
        : [{ ...events.at(-1), seq: 10001 }];
    pages++;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await page.reload();
  await page.locator("#workspace").waitFor({ state: "visible" });
  await page
    .locator("#guild-list")
    .getByRole("button", { name: "リリース確認", exact: true })
    .click();
  await page
    .locator("#history-status")
    .getByRole("button", { name: "続きを読み込む", exact: true })
    .waitFor();
  await capture("history-continue");
  await page
    .locator("#history-status")
    .getByRole("button", { name: "続きを読み込む", exact: true })
    .click();
  await page.getByText("切断中に届いたメッセージ", { exact: true }).waitFor();
  assert(pages >= 101);
  assert.deepEqual(errors, []);
  writeFileSync(
    resolve(shots, "release-checks.json"),
    JSON.stringify(
      {
        checked,
        emojiRatio: ratio,
        offlineCatchup: true,
        failurePreservesInput: true,
        historyRetry: true,
        historyContinuation: true,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed: true,
      views: checked.length,
      emojiRatio: ratio,
      offlineCatchup: true,
      historyRetry: true,
      historyContinuation: true,
    }),
  );
} catch (error) {
  console.error(
    "Release UI",
    await page
      .locator("#toast")
      .textContent()
      .catch(() => ""),
  );
  await capture("diagnostic").catch(() => {});
  throw error;
} finally {
  await browser.close();
  app.stop();
  rmSync(temporary, { recursive: true, force: true });
}
