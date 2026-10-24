import { chromium } from "playwright";
import { createApp } from "../src/server.ts";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const temp = mkdtempSync(resolve(tmpdir(), "oisiicord-productivity-")),
  shots = resolve(import.meta.dir, "../docs/screenshots");
mkdirSync(shots, { recursive: true });
const app = createApp({
  port: 31988,
  origin: "http://localhost:31988",
  path: resolve(temp, "chat.sqlite"),
});
const browser = await chromium.launch({
  headless: true,
  ...(process.env.TEST_BROWSER_EXECUTABLE
    ? { executablePath: process.env.TEST_BROWSER_EXECUTABLE }
    : {}),
  args: JSON.parse(process.env.TEST_BROWSER_ARGS ?? "[]"),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } }),
  errors = [],
  bodies = [];
page.setDefaultTimeout(12000);
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => {
  if (r.postData()) bodies.push(r.postData());
});
const password = crypto.randomUUID();
async function register(username) {
  await page.locator("#auth-switch").click();
  await page.locator("#username").fill(username);
  await page.locator("#display").fill("Panda");
  await page.locator("#password").fill(password);
  await page.locator("#auth-submit").click();
  await page.locator("#workspace").waitFor({ state: "visible" });
}
async function tools(tab) {
  await page.locator("#personal-tools").click();
  await page.locator(".personal-panel").waitFor();
  if (tab) await page.getByRole("tab", { name: tab, exact: true }).click();
}
async function close() {
  await page.locator("#modal-close").click();
}
async function state() {
  return page.evaluate(async () => (await fetch("/api/state")).json());
}
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
    path: resolve(shots, "productivity-" + name + ".png"),
    fullPage: true,
  });
}
try {
  await page.goto(app.origin);
  await register("tools_alice");
  await page
    .getByRole("button", { name: "サーバーを作成", exact: true })
    .click();
  await page.locator("#modal-body input").fill("機能確認");
  await page.locator("#modal-submit").click();
  await page.locator("#room-name").filter({ hasText: "一般" }).waitFor();
  if (!process.env.TEST_PRODUCTIVITY_FOCUS) {
    await page.locator("#message-input").fill("<");
    await page.getByRole("option", { name: /リンクボタン/ }).waitFor();
    await capture("completion");
    await page.locator("#message-input").press("Enter");
    await page
      .getByLabel("リンク先URL", { exact: true })
      .fill("https://example.com/path");
    await page.getByLabel("ボタン名", { exact: true }).fill("詳細");
    await page.locator("#modal-submit").click();
    await page.locator("#modal").waitFor({ state: "hidden" });
    assert.equal(
      await page.locator("#message-input").inputValue(),
      "<button:https://example.com/path|詳細>",
    );
    assert.equal(await page.locator(".message").count(), 0);
    await page.locator("#send").click();
    await page
      .locator(".chat-link-button")
      .filter({ hasText: "詳細" })
      .waitFor();
    await page.locator(".chat-link-button").filter({ hasText: "詳細" }).click();
    await page
      .locator("#modal-title")
      .filter({ hasText: "リンクを開く" })
      .waitFor();
    assert.match(
      await page.locator(".link-confirmation").textContent(),
      /example.com/,
    );
    await close();
    await tools("メモ");
    await page
      .getByLabel("自分用メモ", { exact: true })
      .fill("private-note-browser-marker\n次回の作業を確認");
    await page.getByRole("tab", { name: "定型文", exact: true }).click();
    await page
      .getByRole("button", { name: "定型文を作成", exact: true })
      .click();
    await page.getByLabel("定型文名", { exact: true }).fill("今日の連絡");
    await page
      .getByLabel("定型文の本文", { exact: true })
      .fill("{date} / {channel} / {me}");
    await page
      .locator(".personal-card-actions")
      .getByRole("button", { name: "保存", exact: true })
      .click();
    await page
      .locator(".personal-card")
      .filter({ hasText: "今日の連絡" })
      .waitFor();
    await capture("templates");
    await page
      .locator(".personal-card")
      .getByRole("button", { name: "挿入", exact: true })
      .click();
    assert.match(
      await page.locator("#message-input").inputValue(),
      /^\d{4}-\d{2}-\d{2} \/ 一般 \/ Panda$/,
    );
    await page.locator("#message-input").fill("<今日");
    await page.getByRole("option", { name: /今日の連絡/ }).waitFor();
    await page.locator("#message-input").press("Tab");
    assert.match(
      await page.locator("#message-input").inputValue(),
      /一般 \/ Panda$/,
    );
    await page.locator("#message-input").fill("@");
    await page.getByRole("option").filter({ hasText: "Panda" }).waitFor();
    assert.match(
      await page
        .locator("#message-input")
        .getAttribute("aria-activedescendant"),
      /^mention-option/,
    );
    await page.locator("#message-input").press("Escape");
    await page.locator("#message-input").fill("private-draft-one");
    const g = (await state()).guilds[0];
    await page.evaluate(async (gid) => {
      const r = await fetch("/api/guilds/" + gid + "/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "作業部屋", kind: "text" }),
      });
      if (!r.ok) throw Error(await r.text());
    }, g.id);
    await page
      .locator("#channel-list .channel")
      .filter({ hasText: "作業部屋" })
      .click();
    await page.locator("#message-input").fill("private-draft-two");
    await tools("下書き");
    assert.equal(await page.locator(".personal-card").count(), 2);
    await capture("drafts");
    await page
      .locator(".personal-card")
      .filter({ hasText: "private-draft-one" })
      .getByRole("button", { name: "開く", exact: true })
      .click();
    await page.locator("#room-name").filter({ hasText: "一般" }).waitFor();
    assert.equal(
      await page.locator("#message-input").inputValue(),
      "private-draft-one",
    );
    await tools("メモ");
    assert.match(
      await page.getByLabel("自分用メモ", { exact: true }).inputValue(),
      /private-note-browser-marker/,
    );
    await capture("notes");
    await close();
    const id = (await state()).me.id;
    const raw = await page.evaluate(
      (id) => localStorage.getItem("oisiicord-personal-" + id),
      id,
    );
    assert(!raw.includes("private-note-browser-marker"));
    assert(!raw.includes("private-draft-one"));
    assert(
      !bodies.some(
        (b) =>
          b.includes("private-note-browser-marker") ||
          b.includes("private-draft-one"),
      ),
    );
    await page.reload();
    await page.locator("#workspace").waitFor({ state: "visible" });
    await page
      .locator("#guild-list")
      .getByRole("button", { name: "機能確認", exact: true })
      .click();
    await page.locator("#room-name").filter({ hasText: "一般" }).waitFor();
    assert.equal(
      await page.locator("#message-input").inputValue(),
      "private-draft-one",
    );
    await tools("メモ");
    assert.match(
      await page.getByLabel("自分用メモ", { exact: true }).inputValue(),
      /private-note-browser-marker/,
    );
    await page.getByRole("tab", { name: "定型文", exact: true }).click();
    await page
      .locator(".personal-card")
      .filter({ hasText: "今日の連絡" })
      .waitFor();
    await close();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#message-input").fill("<");
    await page.getByRole("option", { name: /リンクボタン/ }).waitFor();
    await capture("mobile");
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.locator("#message-input").press("Escape");
  } else {
    await page.locator("#message-input").fill("private-draft-two");
  }
  await tools("下書き");
  await page
    .locator(".personal-card")
    .filter({ hasText: "private-draft-two" })
    .getByRole("button", { name: "削除", exact: true })
    .click();
  await page
    .locator(".personal-card")
    .filter({ hasText: "private-draft-two" })
    .waitFor({ state: "detached" });
  await close();
  if (process.env.TEST_PRODUCTIVITY_FOCUS) {
    await page.reload();
    await page.locator("#workspace").waitFor({ state: "visible" });
    await page
      .locator("#guild-list")
      .getByRole("button", { name: "機能確認", exact: true })
      .click();
    assert.equal(await page.locator("#message-input").inputValue(), "");
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      mode: process.env.TEST_PRODUCTIVITY_FOCUS ?? "all",
      draftDeletion: true,
      lessThanCompletion: true,
      selectionDoesNotSend: true,
      urlConfirmation: true,
      notes: true,
      templatesWithVariables: true,
      persistentDrafts: true,
      noPlaintextEgress: true,
      mobile: true,
      mentionCoexistence: true,
    }),
  );
} catch (error) {
  console.error(
    "UI",
    await page
      .locator("#toast")
      .textContent()
      .catch(() => ""),
    await page
      .locator("#modal-error")
      .textContent()
      .catch(() => ""),
  );
  await page
    .screenshot({
      path: resolve(shots, "productivity-diagnostic.png"),
      fullPage: true,
    })
    .catch(() => {});
  throw error;
} finally {
  await browser.close();
  app.stop();
  rmSync(temp, { recursive: true, force: true });
}
