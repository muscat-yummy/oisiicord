import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("..", import.meta.url));
const temporary = mkdtempSync(
  resolve(tmpdir(), "oisiicord-history-interface-"),
);
const screenshots = resolve(root, "docs/screenshots");
const origin = "http://localhost:31993";
const password = "History-interface-password-2026";
const guildName = "履歴の引き継ぎ確認";
const beforeText = "招待リンクを作る前のメッセージ。";
const afterText = "招待リンクを作った後、参加する前のメッセージ。";
const replyText = "参加前の会話が両方読めた。";
mkdirSync(screenshots, { recursive: true });
const child = spawn(
  process.env.BUN_BINARY ?? process.execPath,
  ["src/server.ts"],
  {
    cwd: root,
    env: {
      ...process.env,
      PORT: "31993",
      APP_ORIGIN: origin,
      DATABASE_PATH: resolve(temporary, "chat.sqlite"),
      OISIICORD_DATA_DIR: resolve(temporary, "storage"),
    },
  },
);
let startup = "";
child.stderr.on("data", (data) => process.stderr.write(data));
process.on("exit", () => child.kill());
await new Promise((ready, reject) => {
  const timer = setTimeout(
    () => reject(Error("Server startup timeout")),
    10000,
  );
  child.stdout.on("data", (data) => {
    startup += data;
    if (startup.includes("Oisiicord:")) {
      clearTimeout(timer);
      ready();
    }
  });
  child.once("error", reject);
  child.once("exit", () => reject(Error("Server exited during startup")));
});
const browser = await chromium.launch({
  ...(process.env.TEST_BROWSER_EXECUTABLE
    ? { executablePath: process.env.TEST_BROWSER_EXECUTABLE }
    : {}),
  args: JSON.parse(process.env.TEST_BROWSER_ARGS ?? "[]"),
  headless: true,
});
const errors = [],
  contexts = [],
  pages = [];
async function context() {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });
  contexts.push(context);
  const page = await context.newPage();
  pages.push(page);
  page.on("pageerror", (error) => errors.push(error.message));
  return { context, page };
}
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
  if (!page.url().startsWith(origin)) await page.goto(origin);
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  await page.locator("#auth-submit").click();
  await page.locator("#workspace").waitFor({ state: "visible" });
}
async function send(page, text) {
  await page.locator("#message-input").fill(text);
  await page.locator("#send").click();
  await page
    .locator(".message-text")
    .getByText(text, { exact: true })
    .waitFor();
}
async function state(page) {
  return page.evaluate(async () => await (await fetch("/api/state")).json());
}
async function selectGuild(page) {
  await page
    .locator("#guild-list")
    .getByRole("button", { name: guildName, exact: true })
    .click();
  await page.locator("#room-name").filter({ hasText: "一般" }).waitFor();
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
    path: resolve(screenshots, name + ".png"),
    fullPage: true,
  });
}
try {
  const owner = await context();
  await register(owner.page, "history_owner", "Panda");
  await owner.page
    .getByRole("button", { name: "サーバーを作成", exact: true })
    .click();
  await owner.page.locator("#modal-body input").fill(guildName);
  await owner.page.locator("#modal-submit").click();
  await owner.page.locator("#room-name").filter({ hasText: "一般" }).waitFor();
  await send(owner.page, beforeText);
  await owner.page.locator("#side-menu").click();
  await owner.page
    .getByRole("button", { name: "友達を招待", exact: true })
    .click();
  assert.equal(
    await owner.page
      .getByRole("checkbox", { name: "参加に承認が必要", exact: true })
      .isChecked(),
    false,
  );
  await owner.page
    .getByRole("button", { name: "リンクを作成", exact: true })
    .click();
  await owner.page.getByLabel("招待リンク", { exact: true }).waitFor();
  const invite = await owner.page
    .getByLabel("招待リンク", { exact: true })
    .inputValue();
  assert(invite.length < 110, "Invite should fit in a short link");
  assert.match(
    new URL(invite).hash,
    /^#join=[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/,
  );
  await owner.page.locator("#modal-close").click();
  await send(owner.page, afterText);
  const ownerState = await state(owner.page),
    guild = ownerState.guilds[0],
    room = guild.channels.find((room) => room.kind === "text").id;
  await owner.context.close();

  const newcomer = await context();
  await newcomer.page.goto(invite);
  await register(newcomer.page, "history_newcomer", "muscat");
  await newcomer.page
    .locator("#modal-submit")
    .filter({ hasText: /^参加$/ })
    .click();
  await newcomer.page
    .locator("#room-name")
    .filter({ hasText: "一般" })
    .waitFor();
  await newcomer.page
    .locator(".message-text")
    .getByText(beforeText, { exact: true })
    .waitFor();
  await newcomer.page
    .locator(".message-text")
    .getByText(afterText, { exact: true })
    .waitFor();
  assert.equal((await state(newcomer.page)).guilds.length, 1);
  await send(newcomer.page, replyText);
  await newcomer.page.reload();
  await login(newcomer.page, "history_newcomer");
  await selectGuild(newcomer.page);
  for (const text of [beforeText, afterText, replyText])
    await newcomer.page
      .locator(".message-text")
      .getByText(text, { exact: true })
      .waitFor();
  await capture(newcomer.page, "history-newcomer");

  const returning = await context();
  await login(returning.page, "history_owner");
  await selectGuild(returning.page);
  await returning.page
    .locator(".message-text")
    .getByText(replyText, { exact: true })
    .waitFor();
  const current = await state(returning.page);
  assert.equal(current.guilds[0].certificate.admissions.length, 1);
  assert.equal(
    current.users.some((user) => user.username === "history_newcomer"),
    true,
  );
  const newcomerId = (await state(newcomer.page)).me.id;
  await returning.page
    .locator("#members .member")
    .filter({ hasText: "muscat" })
    .click();
  await returning.page
    .getByRole("button", { name: "メンバーを削除", exact: true })
    .click();
  await returning.page.locator("#modal-submit").click();
  await returning.page.locator("#modal").waitFor({ state: "hidden" });
  await send(returning.page, "退出後のメッセージ。");
  const blocked = await newcomer.page.evaluate(
    async (room) => (await fetch("/api/rooms/" + room + "/events")).status,
    room,
  );
  assert.equal(blocked, 403);
  const last = await returning.page.evaluate(
    async (room) =>
      (await (await fetch("/api/rooms/" + room + "/events")).json()).at(-1),
    room,
  );
  assert.equal(Object.hasOwn(last.envelope.boxes, newcomerId), false);
  assert.equal(Object.keys(last.envelope.historyBoxes ?? {}).length, 0);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      inviteLength: invite.length,
      offlineOwner: true,
      historyBeforeAndAfterInvite: true,
      reloadPreserved: true,
      removedMemberBlocked: true,
    }),
  );
} catch (error) {
  for (const [index, page] of pages.entries())
    if (!page.isClosed()) {
      console.log(
        "History UI diagnostic",
        index,
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
          path: resolve(screenshots, "history-diagnostic-" + index + ".png"),
          fullPage: true,
        })
        .catch(() => {});
    }
  throw error;
} finally {
  await browser.close();
  child.kill();
  rmSync(temporary, { recursive: true, force: true });
}
