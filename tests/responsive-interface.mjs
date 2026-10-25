import { chromium, webkit } from "playwright";
import { createApp } from "../src/server.ts";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const temp = mkdtempSync(resolve(tmpdir(), "oisiicord-responsive-"));
const shots = resolve(import.meta.dir, "../test-results/responsive");
mkdirSync(shots, { recursive: true });
const app = createApp({
  port: 31993,
  origin: "http://localhost:31993",
  path: resolve(temp, "chat.sqlite"),
  settingsDirectory: resolve(temp, "settings"),
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
const context = await browser.newContext({
  viewport: { width: 1440, height: 960 },
  hasTouch: true,
  isMobile: engine === "webkit",
  deviceScaleFactor: 1,
});
const page = await context.newPage(),
  errors = [],
  checked = [];
page.on("pageerror", (e) => errors.push(e.message));
page.setDefaultTimeout(15000);
const matrix = [
  [320, 640, "phone-small"],
  [360, 740, "phone-android"],
  [390, 844, "phone-iphone"],
  [430, 932, "phone-large"],
  [768, 1024, "tablet-portrait"],
  [820, 1180, "tablet-large-portrait"],
  [1024, 768, "tablet-landscape"],
  [1180, 700, "tablet-browser"],
  [1194, 834, "tablet-wide"],
  [1280, 800, "laptop"],
  [1440, 960, "desktop"],
  [844, 390, "phone-landscape"],
];
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
    path: resolve(shots, engine + "-" + name + ".png"),
    fullPage: true,
  });
}
async function bounds(label) {
  const info = await page.evaluate(() => {
    const rect = (s) => {
      const e = document.querySelector(s),
        r = e.getBoundingClientRect();
      return {
        x: r.x,
        y: r.y,
        w: r.width,
        h: r.height,
        right: r.right,
        bottom: r.bottom,
        display: getComputedStyle(e).display,
      };
    };
    return {
      width: innerWidth,
      height: visualViewport?.height ?? innerHeight,
      pageW: document.documentElement.scrollWidth,
      pageH: document.documentElement.scrollHeight,
      bodyH: document.body.scrollHeight,
      workspace: rect("#workspace"),
      main: rect(".main"),
      members: rect("#members-panel"),
      rows: getComputedStyle(document.querySelector("#workspace"))
        .gridTemplateRows,
      header: rect(".room-header"),
    };
  });
  assert.ok(
    info.pageW <= info.width + 1,
    label + " horizontal " + JSON.stringify(info),
  );
  assert.ok(
    info.pageH <= info.height + 1,
    label + " vertical " + JSON.stringify(info),
  );
  assert.ok(
    info.workspace.bottom <= info.height + 1,
    label + " workspace bottom",
  );
  assert.ok(Math.abs(info.main.y - info.workspace.y) < 1, label + " main row");
  assert.ok(
    Math.abs(info.main.h - info.workspace.h) < 1,
    label + " main height",
  );
  assert.equal(
    info.rows.split(" ").length,
    1,
    label + " implicit rows " + info.rows,
  );
  if (info.width <= 780)
    assert.ok(info.main.w >= info.width - 1, label + " full width chat");
  if (info.members.display !== "none")
    assert.ok(
      info.members.y >= 0 && info.members.bottom <= info.height + 1,
      label + " member bounds",
    );
}
async function drawer() {
  if (await page.locator("#mobile-channels").isVisible()) {
    if (
      !(await page.locator("#workspace").getAttribute("class")).includes(
        "show-sidebar",
      )
    )
      await page.locator("#mobile-channels").click();
  }
}
async function send(text) {
  await page.locator("#message-input").fill(text);
  await page.locator("#send").click();
  await page.waitForFunction(
    () => document.querySelector("#message-input").value === "",
  );
}
async function settings(kind = "user") {
  await drawer();
  if (kind === "user") await page.locator("#profile-settings").click();
  else {
    await page.locator("#side-menu").click();
    await page
      .getByRole("button", { name: "サーバー設定", exact: true })
      .click();
  }
  await page.locator("#settings-dialog").waitFor({ state: "visible" });
}
try {
  await page.goto(app.origin);
  await page.locator("#auth-switch").click();
  await page.locator("#username").fill("responsive_" + engine);
  await page.locator("#display").fill("Panda");
  await page.locator("#password").fill(crypto.randomUUID());
  await page.locator("#auth-submit").click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  await page
    .getByRole("button", { name: "サーバーを作成", exact: true })
    .click();
  await page.locator("#modal-body input").fill("おいしいコミュニティ");
  await page.locator("#modal-submit").click();
  await page.locator("#room-name").filter({ hasText: "一般" }).waitFor();
  await send(
    '# スマホとタブレット\n画面幅に合わせて表示する。\n**太字** と [リンク](https://example.com)\n- チャンネル\n- メンバー\n```js\nconst message = "long-code-' +
      "x".repeat(90) +
      '";\n```',
  );
  const footerOnly = process.env.TEST_RESPONSIVE_FOCUS === "footer";
  if (footerOnly) {
    for (const width of [320, 820]) {
      await page.setViewportSize({ width, height: 844 });
      await drawer();
      const person = await page.locator(".profile-person").boundingBox();
      assert.ok(person.width >= 190, "touch profile width");
      assert.ok(
        await page
          .locator("#connection")
          .evaluate((el) => el.scrollWidth <= el.clientWidth),
        "online label is not squeezed",
      );
      await capture("touch-footer-" + width);
    }
  }
  const samples = process.env.TEST_RESPONSIVE_FOCUS
    ? matrix.filter((x) =>
        process.env.TEST_RESPONSIVE_FOCUS.split(",").includes(x[2]),
      )
    : matrix;
  for (const [width, height, name] of samples) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await bounds(name + " chat");
    const composer = await page.locator("#composer").boundingBox();
    assert.ok(
      composer.x >= 0 && composer.x + composer.width <= width + 1,
      name + " composer width",
    );
    const input = page.locator("#message-input");
    if (width <= 780)
      assert.ok(
        await input.evaluate(
          (el) => parseFloat(getComputedStyle(el).fontSize) >= 16,
        ),
        "avoid iOS focus zoom",
      );
    await capture(name + "-chat");
    await page.locator("#toggle-members").click();
    if (width <= 1200) {
      await page.locator("#members-panel").waitFor({ state: "visible" });
      await bounds(name + " members");
      assert.equal(await page.locator("#panel-backdrop").isVisible(), true);
      if ([390, 820, 1180].includes(width)) await capture(name + "-members");
      await page
        .getByRole("button", { name: "メンバーを閉じる", exact: true })
        .click();
    } else {
      await page.locator("#toggle-members").click();
    }
    if (width <= 780) {
      await drawer();
      assert.equal(await page.locator("#profile-settings").isVisible(), true);
      if ([320, 390, 768].includes(width)) await capture(name + "-channels");
      await page
        .getByRole("button", { name: "チャンネルを閉じる", exact: true })
        .click();
      assert.equal(await page.locator(".sidebar").isVisible(), false);
      await page.locator("#mobile-tools").click();
      await page.locator("#search").fill("スマホ");
      await page.locator(".message h1").waitFor();
      await page.locator("#search").fill("");
      await page.locator("#pins").click();
      await page.getByRole("dialog", { name: /ピン/ }).waitFor();
      await page.keyboard.press("Escape");
    }
    await settings();
    await page.locator('.settings-action[data-tab="profile"]').click();
    await page.locator(".profile-editor").waitFor();
    const content = await page.locator(".settings-content").boundingBox();
    assert.ok(
      content.x >= 0 && content.x + content.width <= width + 1,
      name + " settings bounds",
    );
    if (width <= 780)
      assert.ok(content.width >= width - 1, name + " settings full width");
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      name + " settings document overflow",
    );
    if ([320, 390, 768, 820, 1180, 1440].includes(width))
      await capture(name + "-profile-settings");
    await page
      .getByRole("button", { name: "設定を閉じる", exact: true })
      .click();
    if (width <= 780)
      await page
        .getByRole("button", { name: "チャンネルを閉じる", exact: true })
        .click();
    if ([390, 820, 1180].includes(width)) {
      await settings("server");
      await capture(name + "-server-settings");
      await page
        .getByRole("button", { name: "設定を閉じる", exact: true })
        .click();
      if (width <= 780)
        await page
          .getByRole("button", { name: "チャンネルを閉じる", exact: true })
          .click();
    }
    await drawer();
    await page.locator("#home").click();
    if (width <= 780 && (await page.locator(".sidebar").isVisible()))
      await page
        .getByRole("button", { name: "チャンネルを閉じる", exact: true })
        .click();
    await bounds(name + " home");
    if ([320, 768, 1180].includes(width)) await capture(name + "-home");
    await drawer();
    await page
      .locator("#guild-list")
      .getByRole("button", { name: "おいしいコミュニティ", exact: true })
      .click();
    await page.locator("#room-name").filter({ hasText: "一般" }).waitFor();
    checked.push(name);
  }
  if (!footerOnly) {
    // A focused input must remain inside the reduced viewport used by a software keyboard.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#message-input").focus();
    await page.setViewportSize({ width: 390, height: 420 });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await bounds("keyboard viewport");
    const keyboard = await page.locator("#composer").boundingBox();
    assert.ok(keyboard.y + keyboard.height <= 420, "composer above keyboard");
    await capture("keyboard-viewport");
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      engine,
      passed: true,
      checked,
      keyboardViewport: !footerOnly,
      touchFooter: footerOnly,
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
