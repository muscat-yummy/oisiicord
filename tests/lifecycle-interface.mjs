import { chromium } from "playwright";
import { createApp } from "../src/server.ts";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const temporary = mkdtempSync(resolve(tmpdir(), "oisiicord-lifecycle-ui-")),
  shots = resolve(import.meta.dir, "../docs/release-review/screenshots");
mkdirSync(shots, { recursive: true });
const app = createApp({
  path: resolve(temporary, "chat.sqlite"),
  port: 31981,
  origin: "http://localhost:31981",
});
const browser = await chromium.launch({
  headless: true,
  ...(process.env.TEST_BROWSER_EXECUTABLE
    ? { executablePath: process.env.TEST_BROWSER_EXECUTABLE }
    : {}),
  args: JSON.parse(process.env.TEST_BROWSER_ARGS ?? "[]"),
});
const password = crypto.randomUUID(),
  errors = [],
  pages = [];
async function register(username, display) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });
  await context.addInitScript(() => {
    window.testSounds = 0;
    window.testInputStreams = [];
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = async (options) => {
      const stream = await getUserMedia(options);
      window.testInputStreams.push(stream);
      return stream;
    };
    const base = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function (...args) {
      window.testSounds++;
      return base.apply(this, args);
    };
  });
  const page = await context.newPage();
  track(page);
  await page.goto(app.origin);
  await page.locator("#auth-switch").click();
  await page.locator("#username").fill(username);
  await page.locator("#display").fill(display);
  await page.locator("#password").fill(password);
  await page.locator("#auth-submit").click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  return { page, context };
}
function track(p) {
  pages.push(p);
  p.setDefaultTimeout(15000);
  p.on("pageerror", (e) => errors.push(e.message));
}
async function state(p) {
  return p.evaluate(async () => await (await fetch("/api/state")).json());
}
async function send(p, text) {
  await p.locator("#message-input").fill(text);
  await p.locator("#send").click();
  await p.waitForFunction(
    () => document.querySelector("#message-input").value === "",
  );
}
async function capture(p, name) {
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
    path: resolve(shots, "lifecycle-" + name + ".png"),
    fullPage: true,
  });
}
async function submit(p) {
  await p.locator("#modal-submit").click();
  await p.locator("#modal").waitFor({ state: "hidden" });
}
async function invite(p) {
  await p.locator("#side-menu").click();
  await p.getByRole("button", { name: "友達を招待", exact: true }).click();
  await p.getByRole("button", { name: "リンクを作成", exact: true }).click();
  await p.getByLabel("招待リンク", { exact: true }).waitFor();
  const link = await p.getByLabel("招待リンク", { exact: true }).inputValue();
  await p.locator("#modal-close").click();
  return link;
}
async function guild(p, name) {
  await p.getByRole("button", { name: "サーバーを作成", exact: true }).click();
  await p.locator("#modal-body input").fill(name);
  await submit(p);
  await p.locator("#room-name").filter({ hasText: "一般" }).waitFor();
}
try {
  const a = await register("life_ui_alice", "Panda"),
    b = await register("life_ui_bob", "muscat");
  let alice = a.page;
  const bob = b.page;
  await guild(alice, "会話の確認");
  const originalInvite = await invite(alice);
  await bob.goto(originalInvite);
  await bob
    .locator("#modal-submit")
    .filter({ hasText: /^参加$/ })
    .click();
  await bob.locator("#modal").waitFor({ state: "hidden" });
  await bob
    .locator("#guild-list")
    .getByRole("button", { name: "会話の確認", exact: true })
    .click();
  await send(bob, "ブロック前のメッセージ");
  await alice.getByText("ブロック前のメッセージ", { exact: true }).waitFor();
  const g = (await state(bob)).guilds[0];
  if (process.env.TEST_LIFECYCLE_FOCUS === "voice-cleanup") {
    await bob
      .locator("#channel-list .channel")
      .filter({ hasText: "ボイスラウンジ" })
      .click();
    await bob.waitForFunction(() =>
      window.testInputStreams.some((stream) =>
        stream.getAudioTracks().some((track) => track.readyState === "live"),
      ),
    );
    const result = await alice.evaluate(
      async ({ password }) => {
        const C = await import("/crypto.js"),
          { restoreLogin } = await import("/login-state.js");
        const session = await (await fetch("/api/auth/session")).json();
        const identity = await restoreLogin(session);
        const state = await (await fetch("/api/state")).json();
        const proof = {
          v: 1,
          type: "delete-account",
          user: identity.id,
          at: Date.now(),
          nonce: crypto.randomUUID(),
          owned: state.guilds
            .filter((g) => g.owner === identity.id)
            .map((g) => g.id)
            .sort(),
          departures: [],
        };
        return (
          await fetch("/api/me", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              proof,
              signature: await C.sign(proof, identity),
              auth: (await C.credentials(password, session.salt)).auth,
            }),
          })
        ).status;
      },
      { password },
    );
    assert.equal(result, 200);
    await bob.locator("#voice-controls").waitFor({ state: "hidden" });
    await bob.waitForFunction(() =>
      window.testInputStreams.every((stream) =>
        stream.getTracks().every((track) => track.readyState === "ended"),
      ),
    );
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        passed: true,
        ownerAccountDeletion: true,
        otherMemberMicrophoneStopped: true,
      }),
    );
  } else {
    await alice.locator(".message-avatar").first().click();
    await alice
      .locator("#modal")
      .getByRole("button", { name: "メッセージ", exact: true })
      .click();
    await send(alice, "DMの履歴");
    await alice
      .locator("#guild-list")
      .getByRole("button", { name: "会話の確認", exact: true })
      .click();
    await alice.locator(".message-avatar").first().click();
    await alice
      .locator("#modal")
      .getByRole("button", { name: "ブロック", exact: true })
      .click();
    await alice
      .locator("#modal-title")
      .filter({ hasText: "ユーザーをブロック" })
      .waitFor();
    await capture(alice, "block-confirmation");
    await submit(alice);
    await alice
      .getByRole("button", {
        name: "ブロック中のメッセージを表示",
        exact: true,
      })
      .waitFor();
    assert.equal(
      await alice
        .locator(".message-text")
        .filter({ hasText: "ブロック前のメッセージ" })
        .count(),
      0,
    );
    const sounds = await alice.evaluate(() => window.testSounds);
    await send(bob, "@everyone ブロック後のメッセージ");
    await alice.waitForFunction(
      () => document.querySelectorAll("[data-blocked-message]").length === 2,
    );
    assert.equal(await alice.evaluate(() => window.testSounds), sounds);
    await capture(alice, "blocked-chat");
    await bob.locator("#home").click();
    await bob
      .locator("#channel-list .channel")
      .filter({ hasText: "Panda" })
      .click();
    await bob.locator("#message-input:disabled").waitFor();
    await capture(bob, "blocked-dm");
    await alice.locator("#profile-settings").click();
    await alice.locator("[data-tab=blocked]").click();
    await alice
      .getByRole("button", { name: "ブロックを解除", exact: true })
      .waitFor();
    await capture(alice, "blocked-settings");
    await alice.setViewportSize({ width: 390, height: 844 });
    await capture(alice, "blocked-settings-mobile");
    assert.equal(
      await alice.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await alice.setViewportSize({ width: 1440, height: 960 });
    await alice
      .getByRole("button", { name: "ブロックを解除", exact: true })
      .click();
    await alice
      .getByRole("button", { name: "設定を閉じる", exact: true })
      .click();
    await alice.getByText("ブロック後のメッセージ", { exact: false }).waitFor();
    await bob.locator("#message-input:not([disabled])").waitFor();
    await bob
      .locator("#guild-list")
      .getByRole("button", { name: "会話の確認", exact: true })
      .click();
    await alice.close();
    await bob.locator("#side-menu").click();
    await bob
      .getByRole("button", { name: "サーバーから退出", exact: true })
      .click();
    await capture(bob, "leave-confirmation");
    await submit(bob);
    await bob
      .locator("#guild-list")
      .getByRole("button", { name: "会話の確認", exact: true })
      .waitFor({ state: "detached" });
    assert.equal(
      await bob.evaluate(
        async (id) => (await fetch("/api/rooms/" + id + "/events")).status,
        g.channels.find((r) => r.kind === "text").id,
      ),
      403,
    );
    alice = await a.context.newPage();
    track(alice);
    await alice.goto(app.origin);
    await alice.locator("#workspace").waitFor({ state: "visible" });
    await alice
      .locator("#guild-list")
      .getByRole("button", { name: "会話の確認", exact: true })
      .click();
    await send(alice, "退出後に残ったメンバーのメッセージ");
    const fresh = await invite(alice);
    await bob.goto(fresh);
    await bob
      .locator("#modal-submit")
      .filter({ hasText: /^参加$/ })
      .click();
    await bob.locator("#modal").waitFor({ state: "hidden" });
    await bob
      .locator("#guild-list")
      .getByRole("button", { name: "会話の確認", exact: true })
      .click();
    await bob
      .getByText("退出後に残ったメンバーのメッセージ", { exact: true })
      .waitFor();
    await capture(bob, "rejoined-history");
    await bob.locator("#home").click();
    await guild(bob, "削除対象のサーバー");
    await bob.locator("#personal-tools").click();
    await bob
      .getByLabel("自分用メモ", { exact: true })
      .fill("削除確認用のメモ");
    await bob.getByLabel("自分用メモ", { exact: true }).blur();
    await bob
      .locator(".personal-save-state")
      .filter({ hasText: "保存済み" })
      .waitFor();
    await bob.locator("#modal-close").click();
    const secondary = await b.context.newPage();
    track(secondary);
    await secondary.goto(app.origin);
    await secondary.locator("#workspace").waitFor({ state: "visible" });
    const id = (await state(bob)).me.id;
    await bob.locator("#profile-settings").click();
    await bob.locator("[data-tab=account]").click();
    await bob.getByRole("button", { name: "削除", exact: true }).click();
    await bob
      .getByLabel("削除するユーザー名", { exact: true })
      .fill("life_ui_bob");
    await bob.getByLabel("所有サーバーの削除に同意", { exact: true }).check();
    await bob
      .getByLabel("現在のパスワード", { exact: true })
      .fill("invalid-" + crypto.randomUUID());
    await bob.locator("#modal-submit").click();
    await bob
      .locator("#modal-error")
      .filter({ hasText: "パスワードが違います" })
      .waitFor();
    await capture(bob, "delete-confirmation");
    await bob.getByLabel("現在のパスワード", { exact: true }).fill(password);
    await bob.locator("#modal-submit").click();
    await bob.locator("#auth").waitFor({ state: "visible" });
    await secondary.locator("#auth").waitFor({ state: "visible" });
    assert(
      await secondary.evaluate(
        (id) =>
          [
            "oisiicord-trust-",
            "oisiicord-personal-",
            "oisiicord-preferences-",
            "oisiicord-emoji-recent-",
          ].every((prefix) => localStorage.getItem(prefix + id) === null),
        id,
      ),
    );
    await alice
      .getByText("削除されたユーザー", { exact: true })
      .first()
      .waitFor();
    await capture(alice, "deleted-user-history");
    await send(alice, "削除後も会話を続けられる");
    assert.equal(
      app.db.query("SELECT 1 FROM guilds WHERE owner=?").get(id),
      null,
    );
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        passed: true,
        blockAndUnblock: true,
        blockedMessagesCollapsed: true,
        blockedNotificationsSuppressed: true,
        dmEnforced: true,
        ownerOfflineDeparture: true,
        rejoinHistory: true,
        accountDeletion: true,
        ownedServersDeleted: true,
        twoTabsRevoked: true,
        localDataRemoved: true,
        oldMessagesVerified: true,
      }),
    );
  }
} catch (error) {
  for (let i = 0; i < pages.length; i++)
    if (!pages[i].isClosed()) {
      console.error(
        "UI",
        i,
        await pages[i]
          .locator("#toast")
          .textContent()
          .catch(() => ""),
      );
      await capture(pages[i], "diagnostic-" + i).catch(() => {});
    }
  throw error;
} finally {
  await browser.close();
  app.stop();
  rmSync(temporary, { recursive: true, force: true });
}
