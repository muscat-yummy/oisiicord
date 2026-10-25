import { chromium } from "playwright";
import { createApp } from "../src/server.ts";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const temp = mkdtempSync(resolve(tmpdir(), "oisiicord-markdown-"));
const shots = resolve(import.meta.dir, "../test-results/markdown");
mkdirSync(shots, { recursive: true });
const app = createApp({
  port: 31989,
  origin: "http://localhost:31989",
  path: resolve(temp, "chat.sqlite"),
});
const browser = await chromium.launch({
  headless: true,
  ...(process.env.TEST_BROWSER_EXECUTABLE
    ? { executablePath: process.env.TEST_BROWSER_EXECUTABLE }
    : {}),
  args: JSON.parse(process.env.TEST_BROWSER_ARGS ?? "[]"),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } }),
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
  await page.locator("#auth-switch").click();
  await page.locator("#username").fill("markdown_test");
  await page.locator("#display").fill("Panda");
  await page.locator("#password").fill(crypto.randomUUID());
  await page.locator("#auth-submit").click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  await page
    .getByRole("button", { name: "サーバーを作成", exact: true })
    .click();
  await page.locator("#modal-body input").fill("書式の確認");
  await page.locator("#modal-submit").click();
  await page.locator("#room-name").filter({ hasText: "一般" }).waitFor();
  await send(
    "# こんにちは\n## 二番目の見出し\n### 三番目の見出し\n通常のメッセージ\n-# 小さな補足\n**太字** *斜体* __下線__ ~~取り消し線~~ __***組み合わせ***__\n- 箇条書き\n  - 入れ子の項目\n- 次の項目\n1. 番号付き\n2. 続き\n> 引用した文章\n[ドキュメント](https://example.com/docs_(test)) と <button:https://example.com|開く>\n||伏せ字の文章||",
  );
  if (!process.env.TEST_MARKDOWN_FOCUS) {
    const message = page.locator(".message").last(),
      text = message.locator(".message-text");
    await text.locator("h1").waitFor();
    assert.equal(await text.locator("h1").textContent(), "こんにちは");
    assert.equal(await text.locator("ul ul").count(), 1);
    assert.equal(await text.locator("ol > li").count(), 2);
    assert.equal(await text.locator("u strong em").count(), 1);
    assert.equal(
      await text.locator("blockquote").textContent(),
      "引用した文章",
    );
    const sizes = await text.evaluate((el) =>
      [
        el,
        el.querySelector("h1"),
        el.querySelector("h2"),
        el.querySelector("h3"),
        el.querySelector(".markdown-subtext"),
      ].map((e) => parseFloat(getComputedStyle(e).fontSize)),
    );
    assert.ok(
      sizes[1] > sizes[2] && sizes[2] > sizes[3] && sizes[4] < sizes[0],
    );
    await capture("desktop");
    const spoiler = text.locator(".markdown-spoiler");
    assert.equal(
      await spoiler.locator("span").getAttribute("aria-hidden"),
      "true",
    );
    await spoiler.focus();
    await page.keyboard.press("Enter");
    assert.equal(await spoiler.getAttribute("aria-expanded"), "true");
    assert.equal(await spoiler.locator("span").getAttribute("inert"), null);
    await text
      .getByRole("button", { name: "ドキュメント", exact: true })
      .click();
    await page.locator("#modal").waitFor({ state: "visible" });
    assert.ok(
      (await page.locator("#modal-body").textContent()).includes(
        "https://example.com/docs_(test)",
      ),
    );
    await capture("link-confirmation");
    await page.locator("#modal-cancel").click();
    await message.hover();
    await message
      .getByRole("button", { name: "ピン留め", exact: true })
      .click();
    await page.locator("#pins").click();
    await page.locator(".pin-card h1").waitFor();
    await capture("pins");
    await page.keyboard.press("Escape");
    await send(
      '\\# 見出しではない\n#空白なし\n#### 対象外\n`**コード内**`\n```js\nconst value = "# **そのまま**";\n```\n<img src=x onerror=alert(1)>\n[危険](javascript:alert(1))\nhttps://example.com/a_b\n@everyone',
    );
    const literal = page.locator(".message").last();
    await literal.locator(".code-block .hljs-keyword").waitFor();
    assert.equal(await literal.locator("h1,h2,h3,img").count(), 0);
    assert.equal(await literal.locator(".inline-code strong").count(), 0);
    assert.equal(await literal.locator(".mention").count(), 1);
    assert.ok(
      (await literal.textContent()).includes("<img src=x onerror=alert(1)>"),
    );
    await capture("literal-code");
    await send("```mermaid\nflowchart LR\n A[入力] --> B[出力]\n```");
    await page
      .locator(".diagram-frame")
      .last()
      .contentFrame()
      .locator("svg")
      .waitFor();
    await send("😀 😀");
    assert.equal(await page.locator(".message-text.emoji-only").count(), 1);
  }
  await page.reload();
  await page.locator("#workspace").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "書式の確認", exact: true }).click();
  await page.locator(".message h1").waitFor();
  assert.equal(await page.locator(".message h1").textContent(), "こんにちは");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".message h1").scrollIntoViewIfNeeded();
  await capture("mobile");
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      focus: process.env.TEST_MARKDOWN_FOCUS ?? "all",
      headings: !process.env.TEST_MARKDOWN_FOCUS,
      inline: !process.env.TEST_MARKDOWN_FOCUS,
      lists: !process.env.TEST_MARKDOWN_FOCUS,
      quotes: !process.env.TEST_MARKDOWN_FOCUS,
      spoilerKeyboard: !process.env.TEST_MARKDOWN_FOCUS,
      linkConfirmation: !process.env.TEST_MARKDOWN_FOCUS,
      pins: !process.env.TEST_MARKDOWN_FOCUS,
      code: !process.env.TEST_MARKDOWN_FOCUS,
      mermaid: !process.env.TEST_MARKDOWN_FOCUS,
      emoji: !process.env.TEST_MARKDOWN_FOCUS,
      reload: true,
      mobile: true,
      screenshots: shots,
    }),
  );
} catch (error) {
  await capture("diagnostic").catch(() => {});
  throw error;
} finally {
  await browser.close();
  app.stop();
  rmSync(temp, { recursive: true, force: true });
}
