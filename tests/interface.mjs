import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const root = fileURLToPath(new URL("..", import.meta.url)),
  temp = mkdtempSync(resolve(tmpdir(), "oisiicord-interface-")),
  screenshots = resolve(root, "docs/screenshots");
mkdirSync(screenshots, { recursive: true });
const bun = process.env.BUN_BINARY ?? process.execPath,
  origin = "http://localhost:31996";
const child = spawn(bun, ["src/server.ts"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: "31996",
    APP_ORIGIN: origin,
    DATABASE_PATH: resolve(temp, "test.sqlite"),
    OISIICORD_DATA_DIR: resolve(temp, "storage"),
  },
});
child.stderr.on("data", (d) => process.stderr.write(d));
process.on("exit", () => child.kill());
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error("server start timeout")), 10000);
  child.stdout.once("data", () => {
    clearTimeout(timer);
    resolve();
  });
  child.once("error", reject);
});
const browser = await chromium.launch({
  ...(process.env.TEST_BROWSER_EXECUTABLE
    ? { executablePath: process.env.TEST_BROWSER_EXECUTABLE }
    : {}),
  args: [
    ...JSON.parse(process.env.TEST_BROWSER_ARGS ?? "[]"),
    "--use-fake-ui-for-media-stream",
    "--allow-loopback-in-peer-connection",
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-device-for-media-stream",
  ],
  headless: true,
});
const errors = [],
  uploads = new Map();
let uploadCount = 0;
const contexts = [];
async function context() {
  const c = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    permissions: ["microphone", "camera"],
  });
  contexts.push(c);
  await c.addInitScript(() => {
    window.testSounds = 0;
    window.testPeers = [];
    const audio = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function (...args) {
      window.testSounds++;
      return audio.apply(this, args);
    };
    const Base = RTCPeerConnection;
    window.RTCPeerConnection = new Proxy(Base, {
      construct(target, args) {
        const pc = new target(...args);
        window.testPeers.push(pc);
        return pc;
      },
    });
  });
  await c.route("**/api/files", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const data = route.request().postDataBuffer(),
      id = crypto.randomUUID();
    assert.notEqual(data.subarray(0, 4).toString(), "RIFF");
    uploads.set(id, data);
    uploadCount++;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id, removePassword: "local-test" }),
    });
  });
  await c.route("**/api/files/*", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop(),
      data = uploads.get(id);
    if (data)
      return route.fulfill({
        status: 200,
        contentType: "application/octet-stream",
        body: data,
      });
    return route.continue();
  });
  return c;
}
async function register(page, username, display) {
  page.on("pageerror", (e) => errors.push(e.message));
  if (!page.url().startsWith(origin)) await page.goto(origin);
  assert(
    !(await page
      .locator("#auth")
      .innerText()
      .then((t) => t.includes("復号鍵"))),
  );
  await page.locator("#auth-switch").click();
  await page.locator("#username").fill(username);
  await page.locator("#display").fill(display);
  await page.locator("#password").fill("Interface-test-password-2026");
  await page.locator("#auth-submit").click();
  await page.locator("#workspace").waitFor({ state: "visible" });
}
async function screenshot(page, name) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      document.getAnimations().map((a) => a.finished.catch(() => {})),
    );
  });
  await page.screenshot({
    path: resolve(screenshots, name + ".png"),
    fullPage: true,
  });
}
async function picture(page, letter, color) {
  return Buffer.from(
    await page.evaluate(
      ({ letter, color }) => {
        const c = document.createElement("canvas");
        c.width = 640;
        c.height = 400;
        const x = c.getContext("2d"),
          g = x.createLinearGradient(0, 0, 640, 400);
        g.addColorStop(0, color);
        g.addColorStop(1, "#111827");
        x.fillStyle = g;
        x.fillRect(0, 0, 640, 400);
        x.fillStyle = "#ffffff15";
        x.beginPath();
        x.arc(450, 50, 160, 0, Math.PI * 2);
        x.fill();
        x.fillStyle = "white";
        x.font = "bold 170px sans-serif";
        x.textAlign = "center";
        x.textBaseline = "middle";
        x.fillText(letter, 320, 210);
        return c.toDataURL("image/png").split(",")[1];
      },
      { letter, color },
    ),
    "base64",
  );
}
try {
  const a = await context(),
    page = await a.newPage();
  await register(page, "interface_alice", "Panda");
  if (process.env.TEST_UI_FOCUS === "server") {
    await page.locator("#profile-settings").click();
    await page.locator("[data-tab=appearance]").click();
    assert.equal(
      await page
        .getByRole("button", { name: "ライト", exact: true })
        .textContent(),
      "ライト",
    );
    assert(
      !(await page.locator("#settings-dialog").innerText()).includes("null"),
    );
    await page.getByRole("button", { name: "ライト", exact: true }).click();
    await screenshot(page, "appearance-fixed");
    await page.getByRole("button", { name: "ダーク", exact: true }).click();
    await page
      .getByRole("button", { name: "設定を閉じる", exact: true })
      .click();
    await page.locator("#add-guild").click();
    await screenshot(page, "server-add");
    await page
      .locator(".guild-choice")
      .filter({ hasText: "サーバーを作成" })
      .click();
    await page.locator("#modal-body input").fill("Oisiicord 開発室");
    await page.locator("#modal-submit").click();
    await page.locator("#room-name").filter({ hasText: "一般" }).waitFor();
    async function settings() {
      await page.locator("#side-menu").click();
      await page
        .getByRole("button", { name: "サーバー設定", exact: true })
        .click();
    }
    const area = page.locator(".settings-content"),
      modal = page.locator("#modal");
    await settings();
    assert.equal(
      await page.locator(".settings-navigation [data-tab]").count(),
      12,
    );
    await page.locator("[data-tab=channels]").click();
    await page
      .getByRole("button", { name: "テキストを作成", exact: true })
      .click();
    await modal.locator("input").fill("お知らせ");
    await page.locator("#modal-submit").click();
    await area
      .getByRole("button", { name: "お知らせを編集", exact: true })
      .click();
    await modal
      .getByLabel("説明", { exact: true })
      .fill("アップデート・リリース情報");
    await page.locator("#modal-submit").click();
    await area
      .getByText("アップデート・リリース情報", { exact: true })
      .waitFor();
    await area
      .getByRole("button", { name: "お知らせを上へ", exact: true })
      .click();
    await area
      .getByRole("button", { name: "お知らせを上へ", exact: true })
      .click();
    await area
      .locator(".channel-setting-title strong")
      .first()
      .filter({ hasText: "お知らせ" })
      .waitFor();
    assert.equal(
      await area.locator(".channel-setting-title strong").first().textContent(),
      "お知らせ",
    );
    await screenshot(page, "server-channels");
    await page.locator("[data-tab=general]").click();
    await area
      .getByLabel("既定のチャンネル")
      .selectOption({ label: "# お知らせ" });
    await area.getByRole("button", { name: "変更を保存", exact: true }).click();
    await page.locator("[data-tab=notifications]").click();
    await area.getByRole("radio", { name: "通知しない", exact: true }).check();
    await page.locator("[data-tab=invites]").click();
    await area
      .getByRole("button", { name: "招待リンクを作成", exact: true })
      .click();
    await modal.getByLabel("有効期限").selectOption("604800");
    await modal.getByLabel("利用回数").selectOption("5");
    await modal
      .getByRole("button", { name: "リンクを作成", exact: true })
      .click();
    await modal.getByLabel("招待リンク", { exact: true }).waitFor();
    const invite = await modal
      .getByLabel("招待リンク", { exact: true })
      .inputValue();
    assert(invite.includes("#join="));
    await screenshot(page, "server-invite");
    await page.locator("#modal-close").click();
    await area.getByText(/0 \/ 5 回/).waitFor();
    await area.getByRole("button", { name: "無効にする", exact: true }).click();
    await area.getByText("招待リンクはない", { exact: true }).waitFor();
    await page.locator("[data-tab=audit]").click();
    await area.getByText("招待リンクを無効化", { exact: true }).waitFor();
    await screenshot(page, "server-audit");
    await page
      .getByRole("button", { name: "設定を閉じる", exact: true })
      .click();
    await page.reload();
    await page.locator("#workspace").waitFor({ state: "visible" });
    await page
      .getByRole("button", { name: "Oisiicord 開発室", exact: true })
      .click();
    await page.locator("#room-name").filter({ hasText: "お知らせ" }).waitFor();
    assert.equal(
      await page.locator("#room-topic").textContent(),
      "アップデート・リリース情報",
    );
    await settings();
    await page.locator("[data-tab=notifications]").click();
    assert(
      await area
        .getByRole("radio", { name: "通知しない", exact: true })
        .isChecked(),
    );
    await page.locator("[data-tab=general]").click();
    assert.equal(
      await area
        .getByLabel("既定のチャンネル")
        .locator("option:checked")
        .textContent(),
      "# お知らせ",
    );
    await page.locator("[data-tab=channels]").click();
    await page.setViewportSize({ width: 390, height: 844 });
    await screenshot(page, "mobile-server-channels");
    const channelTitle = await area
      .locator(".channel-setting-title")
      .first()
      .boundingBox();
    assert(channelTitle.width > 180);
    assert(
      await page
        .locator("#settings-dialog")
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    );
    await area
      .getByRole("button", { name: "お知らせを削除", exact: true })
      .click();
    await page.locator("#modal-submit").click();
    await page.locator("[data-tab=general]").click();
    assert.equal(await area.getByLabel("既定のチャンネル").inputValue(), "");
    assert.deepEqual(errors, []);
    console.log(
      "Server settings, theme labels, invitations, audit history and responsive UI passed",
    );
  } else if (process.env.TEST_UI_FOCUS === "microphone") {
    await page.locator("#profile-settings").click();
    await page.locator("[data-tab=voice]").click();
    await page
      .getByRole("button", { name: "マイクをテスト", exact: true })
      .click();
    await page
      .getByRole("button", { name: "テストを停止", exact: true })
      .click();
    await page.locator("[data-tab=appearance]").click();
    await page
      .getByRole("button", { name: "設定を閉じる", exact: true })
      .click();
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    assert.deepEqual(errors, []);
    console.log("Microphone teardown and settings navigation passed");
  } else if (process.env.TEST_UI_FOCUS === "voice") {
    await page
      .getByRole("button", { name: "サーバーを作成", exact: true })
      .click();
    await page.locator("#modal-body input").fill("Oisiicord 開発室");
    await page.locator("#modal-submit").click();
    await page.locator("#room-name").filter({ hasText: "一般" }).waitFor();
    await page.locator("#side-menu").click();
    await page.getByRole("button", { name: "友達を招待", exact: true }).click();
    await page
      .getByRole("checkbox", { name: "参加に承認が必要", exact: true })
      .check();
    await page
      .getByRole("button", { name: "リンクを作成", exact: true })
      .click();
    const invite = await page
      .getByLabel("招待リンク", { exact: true })
      .inputValue();
    await page.locator("#modal-close").click();
    const c = await context(),
      bob = await c.newPage();
    await bob.goto(invite);
    await register(bob, "interface_bob", "muscat");
    await bob.getByRole("button", { name: "参加申請", exact: true }).click();
    await page
      .getByRole("button", { name: "muscat を確認", exact: true })
      .click();
    await page.getByRole("button", { name: "承認", exact: true }).click();
    await bob
      .getByRole("button", { name: "Oisiicord 開発室", exact: true })
      .click();
    await page
      .locator(".channel")
      .filter({ hasText: "ボイスラウンジ" })
      .click();
    await bob.locator(".channel").filter({ hasText: "ボイスラウンジ" }).click();
    await page.waitForFunction(async () => {
      for (const pc of window.testPeers)
        for (const s of (await pc.getStats()).values())
          if (
            s.type === "inbound-rtp" &&
            s.kind === "audio" &&
            s.bytesReceived > 0
          )
            return true;
      return false;
    });
    await page.waitForFunction(
      () => document.querySelectorAll("#call-stage .call-tile").length === 2,
    );
    await screenshot(page, "voice-call");
    await page.locator("#camera").click();
    await page.waitForFunction(() =>
      document.querySelector(".call-tile.has-video"),
    );
    await page.locator("#camera").click();
    assert.equal(
      await page
        .locator("#toast")
        .evaluate((e) => !e.hidden && e.textContent.includes("再生するには")),
      false,
    );
    await page.locator("#hangup").click();
    await bob.locator("#hangup").click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#mobile-channels").click();
    await page.locator("#profile-settings").click();
    await page.locator("[data-tab=profile]").click();
    await screenshot(page, "mobile-profile");
    const close = await page.locator(".settings-exit svg").boundingBox();
    assert(close.width >= 32);
    assert.deepEqual(errors, []);
    console.log(
      "Focused voice media, camera teardown, autoplay handling, and mobile settings close passed",
    );
  } else {
    await page
      .getByRole("button", { name: "サーバーを作成", exact: true })
      .click();
    await page.locator("#modal-body input").fill("Oisiicord 開発室");
    await page.locator("#modal-submit").click();
    await page.locator("#room-name").filter({ hasText: "一般" }).waitFor();
    await page
      .locator("#message-input")
      .fill("プロフィールとサーバー設定を更新したよ。");
    await page.locator("#send").click();
    await page
      .getByText("プロフィールとサーバー設定を更新したよ。", { exact: true })
      .waitFor();
    await page.locator("#profile-settings").click();
    assert.equal(
      await page
        .locator("#settings-dialog")
        .evaluate((d) => getComputedStyle(d).animationName),
      "dialog-in",
    );
    await page.locator("[data-tab=profile]").click();
    await page
      .locator("#settings-dialog")
      .getByLabel("表示名", { exact: true })
      .fill("Panda");
    await page
      .locator("#settings-dialog")
      .getByLabel("自己紹介", { exact: true })
      .fill("Minecraft とコードを書くのが好き。");
    await page
      .locator("#settings-dialog")
      .getByLabel("代名詞", { exact: true })
      .fill("panda");
    await page
      .locator("#settings-dialog")
      .getByLabel("ステータス", { exact: true })
      .selectOption("idle");
    await page.locator("#settings-dialog input[type=file]").setInputFiles({
      name: "large-profile.png",
      mimeType: "image/png",
      buffer: await picture(page, "P", "#5865f2"),
    });
    await page.getByRole("dialog", { name: "画像を調整" }).waitFor();
    await page.getByRole("button", { name: "適用", exact: true }).click();
    await page.getByRole("button", { name: "変更を保存", exact: true }).click();
    await page.locator("#my-avatar img").waitFor();
    const metadata = await page.evaluate(
      async () => await (await fetch("/api/state")).json(),
    );
    assert.equal(metadata.me.profile.status, "idle");
    const descriptor = metadata.me.profile.avatar;
    assert.equal(descriptor.mime, "image/webp");
    const dimensions = await page.evaluate(async (d) => {
      const C = await import("/crypto.js");
      const encrypted = await (await fetch("/api/files/" + d.id)).arrayBuffer(),
        data = await C.decryptFile(encrypted, d),
        bitmap = await createImageBitmap(new Blob([data], { type: d.mime }));
      return [bitmap.width, bitmap.height];
    }, descriptor);
    assert.deepEqual(dimensions, [128, 128]);
    await screenshot(page, "user-profile");
    await page.locator("[data-tab=appearance]").click();
    await page
      .getByRole("button", { name: "ミッドナイト", exact: true })
      .click();
    assert.equal(
      await page.locator("html").getAttribute("data-theme"),
      "midnight",
    );
    await page.getByRole("button", { name: "ダーク", exact: true }).click();
    await page
      .getByRole("slider", { name: "メッセージの文字サイズ" })
      .evaluate((el) => {
        el.value = "16";
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
    await page
      .getByRole("switch", { name: "コンパクト表示", exact: true })
      .check();
    assert(
      await page
        .locator("body")
        .evaluate((el) => el.classList.contains("compact-messages")),
    );
    await page
      .getByRole("switch", { name: "コンパクト表示", exact: true })
      .uncheck();
    await screenshot(page, "appearance");
    await page.locator("[data-tab=notifications]").click();
    await page
      .getByRole("button", { name: "効果音をテスト", exact: true })
      .click();
    assert(await page.evaluate(() => window.testSounds > 0));
    await screenshot(page, "notifications");
    await page.locator("[data-tab=voice]").click();
    await page
      .getByRole("button", { name: "マイクをテスト", exact: true })
      .click();
    await page
      .getByRole("button", { name: "テストを停止", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "テストを停止", exact: true })
      .click();
    await screenshot(page, "voice-settings");
    await page.locator("[data-tab=keybinds]").click();
    await page
      .locator("#settings-dialog")
      .getByLabel("メッセージの送信キー", { exact: true })
      .selectOption("ctrl");
    await page
      .getByRole("button", { name: "設定を閉じる", exact: true })
      .click();
    await page.locator("#message-input").fill("Ctrl + Enter で送信");
    await page.locator("#message-input").press("Enter");
    assert((await page.locator("#message-input").inputValue()).includes("\n"));
    await page.locator("#message-input").press("Control+Enter");
    await page.getByText("Ctrl + Enter で送信", { exact: true }).waitFor();
    await page.locator("#side-menu").click();
    await page
      .getByRole("button", { name: "サーバー設定", exact: true })
      .click();
    await page
      .locator("#settings-dialog")
      .getByLabel("説明", { exact: true })
      .fill("開発・ゲーム・作業通話");
    await page.locator("#settings-dialog input[type=file]").setInputFiles({
      name: "server.png",
      mimeType: "image/png",
      buffer: await picture(page, "O", "#23a559"),
    });
    await page.getByRole("button", { name: "適用", exact: true }).click();
    await page.getByRole("button", { name: "変更を保存", exact: true }).click();
    await page.locator("#guild-list img").waitFor();
    await screenshot(page, "server-profile");
    await page
      .getByRole("button", { name: "設定を閉じる", exact: true })
      .click();
    await page.locator("#side-menu").click();
    await page.getByRole("button", { name: "友達を招待", exact: true }).click();
    await page
      .getByRole("checkbox", { name: "参加に承認が必要", exact: true })
      .check();
    await page
      .getByRole("button", { name: "リンクを作成", exact: true })
      .click();
    const invite = await page
      .getByLabel("招待リンク", { exact: true })
      .inputValue();
    await page.locator("#modal-close").click();
    const c = await context(),
      bob = await c.newPage();
    await bob.goto(invite);
    await register(bob, "interface_bob", "muscat");
    await bob.getByRole("button", { name: "参加申請", exact: true }).click();
    await page
      .getByRole("button", { name: "muscat を確認", exact: true })
      .click();
    await page.getByRole("button", { name: "承認", exact: true }).click();
    await bob
      .getByRole("button", { name: "Oisiicord 開発室", exact: true })
      .click();
    await bob
      .locator("#message-input")
      .fill("アイコンも反映されてる。あとで通話しよう。");
    await bob.locator("#send").click();
    await page
      .getByText("アイコンも反映されてる。あとで通話しよう。", { exact: true })
      .waitFor();
    await screenshot(page, "chat");
    await page
      .locator(".channel")
      .filter({ hasText: "ボイスラウンジ" })
      .click();
    await bob.locator(".channel").filter({ hasText: "ボイスラウンジ" }).click();
    await page.waitForFunction(
      () => document.querySelectorAll(".call-tile").length === 2,
    );
    await bob.waitForFunction(() =>
      window.testPeers.some((p) => p.connectionState === "connected"),
    );
    await page.waitForFunction(async () => {
      for (const pc of window.testPeers)
        for (const stat of (await pc.getStats()).values())
          if (
            stat.type === "inbound-rtp" &&
            stat.kind === "audio" &&
            stat.bytesReceived > 0
          )
            return true;
      return false;
    });
    await page.locator("#mute").click();
    assert(
      await page
        .locator("#mute")
        .evaluate((el) => el.classList.contains("toggled")),
    );
    await page.locator("#mute").click();
    await page.waitForFunction(
      () => document.querySelectorAll("#call-stage .call-tile").length === 2,
    );
    await screenshot(page, "voice-call");
    await page.locator("#camera").click();
    await page.waitForFunction(
      () => document.querySelector(".call-tile.has-video") !== null,
    );
    await page.locator("#camera").click();
    await page.locator("#hangup").click();
    await bob.locator("#hangup").click();
    await page
      .getByRole("button", { name: "通話に参加", exact: true })
      .waitFor();
    assert(await page.evaluate(() => window.testSounds >= 6));
    await page.locator(".channel").filter({ hasText: "一般" }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await screenshot(page, "mobile-chat");
    await page.locator("#mobile-channels").click();
    await page.locator("#profile-settings").click();
    await page.locator("[data-tab=profile]").click();
    await screenshot(page, "mobile-profile");
    assert.equal(uploadCount, 2);
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        passed: true,
        profileImage: dimensions,
        uploads: uploadCount,
        media: "WebRTC connected and inbound audio bytes received",
        screenshots: 9,
      }),
    );
  }
} catch (e) {
  for (const c of contexts) {
    const p = c.pages()[0];
    if (p)
      console.log(
        "RTC",
        await p.evaluate(async () => ({
          toast: document.querySelector("#toast").textContent,
          peers: await Promise.all(
            window.testPeers.map(async (pc) => ({
              state: pc.connectionState,
              ice: pc.iceConnectionState,
              local: pc.localDescription?.sdp
                .split("\r\n")
                .filter((x) => x.startsWith("a=candidate")),
              stats: [...(await pc.getStats()).values()].filter((s) =>
                [
                  "inbound-rtp",
                  "outbound-rtp",
                  "candidate-pair",
                  "media-source",
                ].includes(s.type),
              ),
            })),
          ),
        })),
      );
    if (p)
      await p
        .screenshot({
          path: resolve(
            screenshots,
            "diagnostic-" + contexts.indexOf(c) + ".png",
          ),
          fullPage: true,
        })
        .catch(() => {});
  }
  throw e;
} finally {
  await browser.close();
  child.kill();
  rmSync(temp, { recursive: true, force: true });
}
