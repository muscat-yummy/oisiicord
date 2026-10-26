import { chromium, webkit } from "playwright";
import { createApp } from "../src/server.ts";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const temp = mkdtempSync(resolve(tmpdir(), "oisiicord-feedback-ui-")),
  shots = resolve(import.meta.dir, "../test-results/feedback");
mkdirSync(shots, { recursive: true });
const invoices = new Map();
let paymentStatus = "New";
const paymentFetch = async (input, options) => {
  const url = new URL(String(input));
  if (options.method === "POST") {
    const data = JSON.parse(options.body),
      id = crypto.randomUUID();
    invoices.set(id, {
      ...data,
      id,
      checkoutLink: "https://pay.example.test/checkout/" + id,
    });
    return Response.json(invoices.get(id));
  }
  const parts = url.pathname.split("/"),
    id = parts.at(-1) === "payment-methods" ? parts.at(-2) : parts.at(-1),
    invoice = invoices.get(id);
  if (parts.at(-1) === "payment-methods")
    return Response.json([
      { paymentMethodId: "LTC-CHAIN", totalPaid: invoice.amount, due: "0" },
    ]);
  return Response.json({ ...invoice, status: paymentStatus });
};
const app = createApp({
  port: 31980,
  origin: "http://localhost:31980",
  path: resolve(temp, "chat.sqlite"),
  settingsDirectory: resolve(temp, "settings"),
  paymentFetch,
});
writeFileSync(
  resolve(temp, "settings/store.json"),
  JSON.stringify({
    enabled: true,
    btcpay_url: "https://pay.example.test",
    store_id: "demo",
    api_key: crypto.randomUUID(),
    plus_ltc: "0.01",
    boost_ltc: "0.002",
    boost_days: 30,
  }),
);
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
  uploads = new Map();
async function account(username, display, path = "/") {
  const context = await browser.newContext({
    viewport: { width: 1180, height: 700 },
    hasTouch: true,
    isMobile: engine === "webkit",
  });
  await context.route("**/api/files", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const id = crypto.randomUUID();
    uploads.set(id, route.request().postDataBuffer());
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ id, removePassword: crypto.randomUUID() }),
    });
  });
  await context.route("**/api/files/*", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    if (!uploads.has(id)) return route.continue();
    await route.fulfill({
      contentType: "application/octet-stream",
      body: uploads.get(id),
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(18000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(app.origin + path);
  await page.locator("#auth-switch").click();
  await page.locator("#username").fill(username);
  await page.locator("#display").fill(display);
  await page.locator("#password").fill(crypto.randomUUID());
  await page.locator("#auth-submit").click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  return page;
}
async function send(page, text) {
  await page.locator("#message-input").fill(text);
  await page.locator("#send").click();
  await page.waitForFunction(
    () => document.querySelector("#message-input").value === "",
  );
}
async function capture(page, name) {
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
    path: resolve(shots, engine + "-" + name + ".png"),
    fullPage: true,
  });
}
async function userSettings(page) {
  if (await page.locator("#mobile-channels").isVisible())
    await page.locator("#mobile-channels").click();
  await page.locator("#profile-settings").click();
  await page.locator("#settings-dialog").waitFor({ state: "visible" });
}
async function run() {
  try {
    const a = await account("feedback_alice", "Alice");
    await a
      .getByRole("button", { name: "サーバーを作成", exact: true })
      .click();
    await a.locator("#modal-body input").fill("ベータテスト");
    await a.locator("#modal-submit").click();
    await a.locator("#room-name").filter({ hasText: "一般" }).waitFor();
    await send(a, "参加前からある履歴");
    if (
      !process.env.TEST_FEEDBACK_FOCUS ||
      process.env.TEST_FEEDBACK_FOCUS === "history"
    ) {
      await a.locator("#side-menu").click();
      await a.getByRole("button", { name: "友達を招待", exact: true }).click();
      await a.getByLabel("カスタムURL", { exact: true }).fill("beta-test");
      assert.equal(
        await a.locator('input[aria-label="参加に承認が必要"]').isDisabled(),
        true,
      );
      await a
        .getByRole("button", { name: "リンクを作成", exact: true })
        .click();
      await a.getByLabel("招待リンク", { exact: true }).waitFor();
      assert.equal(
        await a.getByLabel("招待リンク", { exact: true }).inputValue(),
        app.origin + "/beta-test",
      );
      await capture(a, "custom-invite");
      await a.locator("#modal-close").click();
      const b = await account("feedback_bob", "Bob", "/beta-test");
      await b
        .locator("#modal-title")
        .filter({ hasText: "サーバーに参加" })
        .waitFor();
      assert.equal(await b.locator("#modal-submit").textContent(), "参加");
      await b.locator("#modal-submit").click();
      await b.locator("#room-name").filter({ hasText: "一般" }).waitFor();
      await b
        .locator(".message-text")
        .filter({ hasText: "参加前からある履歴" })
        .waitFor();
      await capture(b, "public-join-history");
      if (process.env.TEST_FEEDBACK_FOCUS === "history") {
        await b.waitForFunction(async () => {
          const state = await (await fetch("/api/state")).json();
          const envelopes = await (
            await fetch(
              "/api/guilds/" + state.guilds[0].id + "/history-credentials",
            )
          ).json();
          return envelopes.some((e) => e.header.author === state.me.id);
        });
        await a.context().close();
        await b.reload();
        await b
          .locator("#guild-list")
          .getByRole("button", { name: "ベータテスト", exact: true })
          .click();
        await b
          .locator(".message-text")
          .filter({ hasText: "参加前からある履歴" })
          .waitFor();
        assert.deepEqual(errors, []);
        console.log(
          JSON.stringify({
            engine,
            focus: "history",
            peerCredentialVerified: true,
            savedToSelf: true,
            authorOfflineReload: true,
          }),
        );
        return;
      }

      await send(
        a,
        "[確認する](https://example.com/login) <button:https://example.com/reset|ボタン>",
      );
      await a.getByRole("button", { name: "確認する", exact: true }).click();
      await a.getByText(/アクセス先にはIPアドレス/).waitFor();
      await capture(a, "link-warning");
      await a.locator("#modal-cancel").click();
      await userSettings(a);
      await a.locator(".settings-content").hover();
      if (engine === "webkit")
        await a
          .locator(".settings-content")
          .evaluate((el) => el.scrollBy(0, 700));
      else await a.mouse.wheel(0, 700);
      await a.waitForFunction(
        () => document.querySelector(".settings-content").scrollTop > 0,
      );
      const scroll = await a.evaluate(() => ({
        root: document.scrollingElement.scrollTop,
        h: document.documentElement.scrollHeight,
        viewport: innerHeight,
        dialog: document
          .querySelector("#settings-dialog")
          .getBoundingClientRect().height,
        layout: document
          .querySelector(".settings-layout")
          .getBoundingClientRect().height,
      }));
      assert.equal(scroll.root, 0);
      assert.ok(scroll.h <= scroll.viewport + 1);
      assert.ok(scroll.layout <= scroll.dialog + 1);
      await capture(a, "tablet-account-scroll");
      await a.setViewportSize({ width: 1180, height: 590 });
      await a.evaluate(() => new Promise(requestAnimationFrame));
      assert.equal(
        await a.evaluate(() => document.scrollingElement.scrollTop),
        0,
      );
      await capture(a, "tablet-short-settings");
      await a.locator('.settings-action[data-tab="store"]').click();
      await a.getByRole("button", { name: "LTCで購入", exact: true }).click();
      await a.getByText("pay.example.test", { exact: true }).waitFor();
      await a.locator("#modal-cancel").click();
      paymentStatus = "Settled";
      await a.getByRole("button", { name: "入金を確認", exact: true }).click();
      await a.getByText("購入済み", { exact: true }).waitFor();
      await capture(a, "plus-purchased");
      await a
        .getByRole("button", { name: "設定を閉じる", exact: true })
        .click();
    } else {
      paymentStatus = "Settled";
      await a.evaluate(async () => {
        const order = await (
          await fetch("/api/store/orders", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ product: "plus" }),
          })
        ).json();
        const result = await fetch("/api/store/orders/" + order.id);
        if (!result.ok) throw Error(await result.text());
      });
      await a.reload();
      await a.locator("#workspace").waitFor({ state: "visible" });
      await a
        .locator("#guild-list")
        .getByRole("button", { name: "ベータテスト", exact: true })
        .click();
    }
    const guild = (
      await a.evaluate(async () => await (await fetch("/api/state")).json())
    ).guilds[0];
    const emoji = await a.evaluate(async (guild) => {
      const C = await import("/crypto.js"),
        canvas = document.createElement("canvas");
      canvas.width = 128;
      canvas.height = 128;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#5865f2";
      ctx.fillRect(0, 0, 128, 128);
      ctx.fillStyle = "white";
      ctx.font = "bold 70px sans-serif";
      ctx.fillText("O", 32, 92);
      const blob = await new Promise((r) => canvas.toBlob(r, "image/webp")),
        file = new File([blob], "emoji.webp", { type: "image/webp" }),
        encrypted = await C.encryptFile(file);
      const upload = await (
        await fetch("/api/files", {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: encrypted.ciphertext,
        })
      ).json();
      const r = await fetch("/api/guilds/" + guild + "/emojis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "test_emoji",
          image: { ...encrypted.descriptor, ...upload },
        }),
      });
      if (!r.ok) throw Error(await r.text());
      return await r.json();
    }, guild.id);
    const c = await account("feedback_carol", "Carol");
    const carol = (
      await c.evaluate(async () => await (await fetch("/api/state")).json())
    ).me;
    const dm = await a.evaluate(
      async (user) =>
        await (
          await fetch("/api/dms", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ user }),
          })
        ).json(),
      carol.id,
    );
    await a.locator("#home").click();
    await a
      .locator("#channel-list .channel")
      .filter({ hasText: "Carol" })
      .click();
    await c
      .locator("#channel-list .channel")
      .filter({ hasText: "Alice" })
      .click();
    await a.locator("#emoji").click();
    await a.locator('.emoji-choice[data-token="<:' + emoji.id + ':>"]').click();
    await a.locator("#send").click();
    await c.locator(".message .custom-emoji img").waitFor();
    assert.equal(
      await c
        .locator(".message .custom-emoji img")
        .evaluate((el) => el.naturalWidth),
      128,
    );
    await capture(c, "global-emoji-dm");
    await a
      .locator("#guild-list")
      .getByRole("button", { name: "ベータテスト", exact: true })
      .click();
    await a.locator("#side-menu").click();
    await a.getByRole("button", { name: "サーバー設定", exact: true }).click();
    await a.locator('.settings-action[data-tab="boost"]').click();
    await a.getByRole("button", { name: "LTCで購入", exact: true }).click();
    await a.locator("#modal-cancel").click();
    await a.getByRole("button", { name: "入金を確認", exact: true }).click();
    await a.getByText(/有効期限:/).waitFor();
    await capture(a, "boost-active");
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        engine,
        focus: process.env.TEST_FEEDBACK_FOCUS ?? "all",
        passed: true,
        publicAlias: !process.env.TEST_FEEDBACK_FOCUS,
        history: !process.env.TEST_FEEDBACK_FOCUS,
        warning: !process.env.TEST_FEEDBACK_FOCUS,
        tabletScroll: !process.env.TEST_FEEDBACK_FOCUS,
        plus: true,
        boost: true,
        globalEmojiOutsideGuild: true,
        screenshots: shots,
      }),
    );
  } catch (error) {
    console.error(
      "Toast",
      await (
        await browser.contexts()[0]?.pages()[0]
      )
        ?.locator("#toast")
        .textContent()
        .catch(() => ""),
    );
    for (const context of browser.contexts())
      for (const p of context.pages())
        await capture(
          p,
          "diagnostic-" + browser.contexts().indexOf(context),
        ).catch(() => {});
    throw error;
  } finally {
    await browser.close();
    app.stop();
    rmSync(temp, { recursive: true, force: true });
  }
}
await run();
