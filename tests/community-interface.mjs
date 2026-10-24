import { chromium } from "playwright";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const root = fileURLToPath(new URL("..", import.meta.url)),
  temp =
    process.env.TEST_COMMUNITY_DATA ||
    mkdtempSync(resolve(tmpdir(), "oisiicord-community-")),
  origin = "http://localhost:31994",
  screenshots = resolve(root, "docs/screenshots");
mkdirSync(screenshots, { recursive: true });
const child = spawn(
  process.env.BUN_BINARY || process.execPath,
  ["src/server.ts"],
  {
    cwd: root,
    env: {
      ...process.env,
      PORT: "31994",
      APP_ORIGIN: origin,
      DATABASE_PATH: resolve(temp, "chat.sqlite"),
      OISIICORD_DATA_DIR: resolve(temp, "storage"),
    },
  },
);
child.stderr.on("data", (d) => process.stderr.write(d));
process.on("exit", () => child.kill());
await new Promise((resolve, reject) => {
  let output = "";
  const timer = setTimeout(
    () => reject(Error("Server startup timeout")),
    10000,
  );
  child.stdout.on("data", (d) => {
    output += d;
    if (output.includes("Oisiicord:")) {
      clearTimeout(timer);
      resolve();
    }
  });
  child.once("error", reject);
  child.once("exit", () => reject(Error("Server startup failed")));
});
const browser = await chromium.launch({
  ...(process.env.TEST_BROWSER_EXECUTABLE
    ? { executablePath: process.env.TEST_BROWSER_EXECUTABLE }
    : {}),
  args: JSON.parse(process.env.TEST_BROWSER_ARGS || "[]"),
  headless: true,
});
const errors = [],
  pages = [],
  contexts = [],
  uploads = new Map();
let passed = false;
async function context() {
  const c = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });
  contexts.push(c);
  await c.addInitScript(() => {
    window.testDmPlays = 0;
    HTMLMediaElement.prototype.play = function () {
      if (this.src.includes("dm.mp3")) window.testDmPlays++;
      return Promise.resolve();
    };
  });
  await c.route("**/api/branding", (r) =>
    r.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ icon: false, dmSound: true }),
    }),
  );
  await c.route("**/api/files", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const bytes = route.request().postDataBuffer(),
      id = crypto.randomUUID();
    assert.notEqual(bytes.subarray(0, 4).toString(), "RIFF");
    uploads.set(id, bytes);
    writeFileSync(resolve(temp, "upload-" + id + ".enc"), bytes);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ id, removePassword: "test-only" }),
    });
  });
  await c.route("**/api/files/*", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop();
    const stored = resolve(temp, "upload-" + id + ".enc");
    if (uploads.has(id) || existsSync(stored))
      return route.fulfill({
        contentType: "application/octet-stream",
        body: uploads.get(id) ?? readFileSync(stored),
      });
    return route.continue();
  });
  const p = await c.newPage();
  p.setDefaultTimeout(12000);
  pages.push(p);
  p.on("pageerror", (e) => errors.push(e.message));
  return p;
}
const password = "Community-test-password-2026";
async function register(page, username, display) {
  if (!page.url().startsWith(origin)) await page.goto(origin);
  await page.locator("#auth-switch").click();
  await page.locator("#username").fill(username);
  await page.locator("#display").fill(display);
  await page.locator("#password").fill(password);
  await page.locator("#auth-submit").click();
  await page.locator("#workspace").waitFor({ state: "visible" });
}
async function login(page, username) {
  await page.goto(origin);
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  await page.locator("#auth-submit").click();
  await page.locator("#workspace").waitFor({ state: "visible" });
}
async function settings(page, tab) {
  if (!(await page.locator("#settings-dialog").isVisible())) {
    await page.locator("#side-menu").click();
    await page
      .getByRole("button", { name: "サーバー設定", exact: true })
      .click();
  }
  await page.locator(`[data-tab=${tab}]`).click();
}
async function closeSettings(page) {
  await page.getByRole("button", { name: "設定を閉じる", exact: true }).click();
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
    path: resolve(screenshots, "community-" + name + ".png"),
    fullPage: true,
  });
}
async function data(page) {
  return page.evaluate(async () => await (await fetch("/api/state")).json());
}
async function send(page, text, expected = text) {
  await page.locator("#message-input").fill(text);
  await page.locator("#send").click();
  await page
    .locator(".message-text")
    .filter({ hasText: expected })
    .last()
    .waitFor();
}
async function createChannel(page, label, name) {
  await settings(page, "channels");
  await page.getByRole("button", { name: label, exact: true }).click();
  await page
    .locator("#modal")
    .getByLabel("チャンネル名", { exact: true })
    .fill(name);
  await page.locator("#modal-submit").click();
  await page
    .locator(".channel-setting-title strong")
    .filter({ hasText: name })
    .waitFor();
}
try {
  const alice = await context(),
    resume = process.env.TEST_COMMUNITY_FOCUS;
  if (resume) {
    await login(alice, "community_alice");
    await alice
      .locator("#guild-list")
      .getByRole("button", { name: "Oisiicord 開発室", exact: true })
      .click();
  } else {
    await register(alice, "community_alice", "Panda");
    await alice
      .getByRole("button", { name: "サーバーを作成", exact: true })
      .click();
    await alice.locator("#modal-body input").fill("Oisiicord 開発室");
    await alice.locator("#modal-submit").click();
    await alice.locator("#room-name").filter({ hasText: "一般" }).waitFor();
    console.log("Community UI: roles and categories");
    await settings(alice, "roles");
    await alice
      .getByRole("button", { name: "ロールを作成", exact: true })
      .click();
    await alice
      .locator("#modal")
      .getByLabel("ロール名", { exact: true })
      .fill("運営");
    await alice
      .getByRole("switch", { name: "チャンネルを管理", exact: true })
      .check();
    await alice
      .getByRole("switch", { name: "メッセージを管理", exact: true })
      .check();
    await alice.locator("#modal-submit").click();
    await alice
      .locator(".community-role-title strong")
      .filter({ hasText: "運営" })
      .waitFor();
    await capture(alice, "roles");
    await settings(alice, "categories");
    await alice
      .getByRole("button", { name: "カテゴリを作成", exact: true })
      .click();
    await alice
      .locator("#modal")
      .getByLabel("カテゴリ名", { exact: true })
      .fill("サーバー案内");
    await alice.locator("#modal-submit").click();
    await alice
      .locator(".community-category-row")
      .filter({ hasText: "サーバー案内" })
      .waitFor();
    await createChannel(alice, "お知らせを作成", "お知らせ");
    await createChannel(alice, "ルールを作成", "ルール");
    await settings(alice, "rules");
    await alice
      .getByLabel("ルールチャンネル", { exact: true })
      .selectOption({ label: "ルール" });
    await alice
      .getByRole("switch", {
        name: "送信前にルールへの同意を求める",
        exact: true,
      })
      .check();
    await alice
      .getByRole("button", { name: "変更を保存", exact: true })
      .click();
    await capture(alice, "rules");
    await closeSettings(alice);
    await alice.locator(".channel").filter({ hasText: "ルール" }).click();
    await send(alice, "相手を尊重して会話してください。");
    console.log("Community UI: custom emoji");
    await settings(alice, "emojis");
    await alice
      .getByRole("button", { name: "絵文字を追加", exact: true })
      .click();
    const png = Buffer.from(
      await alice.evaluate(() => {
        const c = document.createElement("canvas");
        c.width = c.height = 320;
        const x = c.getContext("2d");
        x.fillStyle = "#5865f2";
        x.fillRect(0, 0, 320, 320);
        x.fillStyle = "#fff";
        x.font = "bold 160px sans-serif";
        x.textAlign = "center";
        x.fillText("P", 160, 210);
        return c.toDataURL().split(",")[1];
      }),
      "base64",
    );
    await alice
      .getByLabel("絵文字の画像", { exact: true })
      .setInputFiles({ name: "panda.png", mimeType: "image/png", buffer: png });
    await alice.getByRole("button", { name: "適用", exact: true }).click();
    await alice
      .locator("#modal")
      .getByLabel("絵文字名", { exact: true })
      .fill("panda");
    await alice.locator("#modal-submit").click();
    await alice.getByText(":panda:", { exact: true }).waitFor();
    const descriptor = (await data(alice)).guilds[0].emojis.find(
      (e) => e.name === "panda",
    ).image;
    const dimensions = await alice.evaluate(async (d) => {
      const C = await import("/crypto.js"),
        bytes = await (await fetch("/api/files/" + d.id)).arrayBuffer(),
        raw = await C.decryptFile(bytes, d),
        bitmap = await createImageBitmap(new Blob([raw], { type: d.mime }));
      return [bitmap.width, bitmap.height];
    }, descriptor);
    assert.deepEqual(dimensions, [128, 128]);
    await capture(alice, "custom-emojis");
    await closeSettings(alice);
  }
  let bob;
  if (!resume) {
    await alice.locator("#side-menu").click();
    await alice
      .getByRole("button", { name: "友達を招待", exact: true })
      .click();
    await alice
      .getByRole("button", { name: "リンクを作成", exact: true })
      .click();
    const invite = await alice
      .getByLabel("招待リンク", { exact: true })
      .inputValue();
    assert(invite.length < 110);
    await alice.locator("#modal-close").click();
    bob = await context();
    await bob.goto(invite);
    await register(bob, "community_bob", "muscat");
    await bob.locator("#modal-submit").filter({ hasText: "参加" }).click();
  } else {
    bob = await context();
    await login(bob, "community_bob");
  }
  await bob
    .locator("#guild-list")
    .getByRole("button", { name: "Oisiicord 開発室", exact: true })
    .click();
  if (!resume) {
    await bob.locator(".channel").filter({ hasText: "一般" }).click();
    assert(await bob.locator("#message-input").isDisabled());
    await bob
      .getByRole("button", { name: "ルールを見る", exact: true })
      .click();
    await bob
      .getByRole("button", { name: "ルールに同意", exact: true })
      .click();
    await bob.locator(".channel").filter({ hasText: "一般" }).click();
    await bob.locator("#message-input:not(:disabled)").waitFor();
    await settings(alice, "members");
    const member = alice
      .locator(".community-member-row")
      .filter({ hasText: "muscat" });
    await member
      .getByRole("button", { name: "ロールを編集", exact: true })
      .click();
    await alice.getByRole("checkbox", { name: "運営", exact: true }).check();
    await alice.locator("#modal-submit").click();
    await closeSettings(alice);
  }
  console.log("Community UI: chat controls");
  await alice.locator(".channel").filter({ hasText: "一般" }).click();
  if (resume !== "finish") {
    const marker = "UI確認 " + Date.now();
    await send(alice, marker);
    const message = alice.locator(".message").filter({ hasText: marker });
    await message.hover();
    await alice
      .locator(".message:not(.is-grouped)")
      .first()
      .getByRole("button", { name: "Pandaのプロフィール", exact: true })
      .click();
    await alice
      .getByRole("dialog")
      .filter({ hasText: "@community_alice" })
      .waitFor();
    await alice.locator("#modal-close").click();
    await message.hover();
    await message
      .getByRole("button", { name: "ピン留め", exact: true })
      .click();
    await alice.locator("#pins").click();
    await alice.getByRole("dialog", { name: /ピン/ }).waitFor();
    await capture(alice, "pins");
    await alice.keyboard.press("Escape");
    await send(
      alice,
      "<button:https://example.com|サイトを開く>",
      "サイトを開く",
    );
    await alice
      .getByRole("button", { name: "サイトを開く", exact: true })
      .last()
      .click();
    await alice
      .locator("#modal")
      .getByText("example.com", { exact: true })
      .waitFor();
    await capture(alice, "url-confirmation");
    await alice.locator("#modal-cancel").click();
  }
  await alice.locator("#emoji").click();
  await alice
    .getByRole("searchbox", { name: "絵文字を検索", exact: true })
    .fill("panda");
  await capture(alice, "emoji-picker");
  await alice.locator(".emoji-choice[data-token^='<:']").first().click();
  await alice.locator("#send").click();
  const customImage = alice.locator(".message-text .custom-emoji img").last();
  await customImage.waitFor();
  await customImage.evaluate((img) => img.decode());
  assert.equal(await customImage.evaluate((img) => img.naturalWidth), 128);
  await alice.locator("#emoji").click();
  await alice
    .getByRole("searchbox", { name: "絵文字を検索", exact: true })
    .fill("panda");
  await alice.keyboard.press("Escape");
  await alice
    .getByRole("dialog", { name: "絵文字を選ぶ", exact: true })
    .waitFor({ state: "hidden" });
  await capture(alice, "chat");
  await alice.setViewportSize({ width: 390, height: 844 });
  await capture(alice, "mobile-chat");
  assert(
    await alice
      .locator("#workspace")
      .evaluate((e) => e.scrollWidth <= e.clientWidth),
  );
  await alice.setViewportSize({ width: 1440, height: 960 });
  await alice.locator("#home").click();
  for (let i = 0; i < 5; i++) await alice.locator("#side-title").click();
  await alice.locator("body.dm-rainbow").waitFor();
  assert(await alice.evaluate(() => window.testDmPlays === 1));
  await capture(alice, "dm-rainbow");
  assert.deepEqual(errors, []);
  passed = true;
  console.log(
    "Community UI passed: roles, channels, rules, 128px emoji, auto invite, pins, profile, links, responsive chat and DM effect",
  );
} catch (error) {
  for (let i = 0; i < pages.length; i++) {
    await capture(pages[i], "diagnostic-" + i).catch(() => {});
    console.log(
      "UI diagnostic",
      await pages[i]
        .locator("#toast")
        .textContent()
        .catch(() => ""),
    );
  }
  console.log("TEST_COMMUNITY_DATA=" + temp);
  throw error;
} finally {
  await browser.close();
  child.kill();
  if (passed) rmSync(temp, { recursive: true, force: true });
}
