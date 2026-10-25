import { chromium } from "playwright";
import { createApp } from "../src/server.ts";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const temp = mkdtempSync(resolve(tmpdir(), "oisiicord-developer-")),
  shots = resolve(import.meta.dir, "../docs/screenshots");
mkdirSync(shots, { recursive: true });
const app = createApp({
  port: 31987,
  origin: "http://localhost:31987",
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
  consoleErrors = [],
  uploads = new Map(),
  downloads = new Map();
let tamper = false,
  phase = "setup";
page.setDefaultTimeout(30000);
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
await page.route("**/api/files", async (route) => {
  if (route.request().method() !== "POST") return route.continue();
  const bytes = Buffer.from(route.request().postDataBuffer()),
    id = crypto.randomUUID();
  if (tamper) {
    bytes[20] ^= 1;
    tamper = false;
  }
  uploads.set(id, bytes);
  await route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ id, removePassword: crypto.randomUUID() }),
  });
});
await page.route("**/api/files/*", async (route) => {
  const id = new URL(route.request().url()).pathname.split("/").at(-1);
  downloads.set(id, (downloads.get(id) ?? 0) + 1);
  if (!uploads.has(id)) return route.fulfill({ status: 404 });
  await route.fulfill({
    contentType: "application/octet-stream",
    body: uploads.get(id),
  });
});
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
    path: resolve(shots, "developer-" + name + ".png"),
    fullPage: true,
  });
}
async function diagram() {
  const frame = page.locator(".diagram-frame").last();
  await frame.waitFor();
  await frame.contentFrame().locator("svg").waitFor();
  return frame;
}
try {
  await page.goto(app.origin);
  await page.locator("#auth-switch").click();
  await page.locator("#username").fill("developer_test");
  await page.locator("#display").fill("Panda");
  await page.locator("#password").fill(crypto.randomUUID());
  await page.locator("#auth-submit").click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  await page
    .getByRole("button", { name: "サーバーを作成", exact: true })
    .click();
  await page.locator("#modal-body input").fill("開発室");
  await page.locator("#modal-submit").click();
  await page.locator("#room-name").filter({ hasText: "一般" }).waitFor();
  if (
    !process.env.TEST_DEVELOPER_FOCUS ||
    process.env.TEST_DEVELOPER_FOCUS === "code"
  ) {
    phase = "code";
    await send(
      '```json\n{"message":"<button:https://example.com>","ready":true}\n```',
    );
    const json = page.locator(".code-block").first();
    await json.locator(".hljs-attr").first().waitFor();
    assert.equal(await json.locator(".chat-link-button").count(), 0);
    await json.getByRole("button", { name: "整形", exact: true }).click();
    assert.match(await json.locator("code").textContent(), /\n  "message"/);
    await send(
      'Inline `@everyone <button:https://example.com>` and code:\n```js\nconst value = "@everyone";\nconsole.log(value);\n```',
    );
    await page.locator(".code-block .hljs-keyword").first().waitFor();
    assert.equal(await page.locator(".inline-code .mention").count(), 0);
    await capture("code");
    await page.locator("#personal-tools").click();
    await page.getByRole("tab", { name: "変換", exact: true }).click();
    await page.getByLabel("変換方法", { exact: true }).selectOption("sha256");
    await page.getByLabel("変換するテキスト", { exact: true }).fill("abc");
    await page.getByRole("button", { name: "変換", exact: true }).click();
    await page.waitForFunction(() =>
      document
        .querySelector('[aria-label="変換結果"]')
        .value.startsWith("ba7816bf"),
    );
    await capture("converter");
    await page.locator("#modal-close").click();
  }
  if (
    !process.env.TEST_DEVELOPER_FOCUS ||
    process.env.TEST_DEVELOPER_FOCUS === "diagram"
  ) {
    phase = "diagram";
    await send(
      "```mermaid\nflowchart LR\n  A[入力] --> B[処理] --> C[出力]\n```",
    );
    let frame = await diagram();
    const opaque = await frame
      .contentFrame()
      .locator("body")
      .evaluate(() => {
        try {
          parent.document;
          return false;
        } catch {
          return true;
        }
      });
    assert.equal(opaque, true);
    await capture("mermaid");
    const block = page.locator(".mermaid-block").last();
    await block.getByRole("button", { name: "コード", exact: true }).click();
    assert.equal(await block.locator(".code-source").isVisible(), true);
    await block.getByRole("button", { name: "コード", exact: true }).click();
    await block.getByRole("button", { name: "拡大", exact: true }).click();
    await page
      .locator(".diagram-expanded")
      .contentFrame()
      .locator("svg")
      .waitFor();
    const downloadEvent = page.waitForEvent("download");
    await page.locator("#modal-submit").click();
    const exported = await downloadEvent;
    assert.equal(exported.suggestedFilename(), "diagram.svg");
    assert(!readFileSync(await exported.path(), "utf8").includes("<script"));
    await send(
      "```mermaid\nsequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: OK\n```",
    );
    await diagram();
    await send("```mermaid\nthis is not a valid diagram\n```");
    await page
      .locator(".mermaid-block")
      .last()
      .locator(".code-error")
      .waitFor({ state: "visible" });
    assert.equal(
      await page
        .locator(".mermaid-block")
        .last()
        .locator(".code-source")
        .isVisible(),
      true,
    );
    await page.locator("#message-input").fill("<mermaid");
    await page.getByRole("option").filter({ hasText: "Mermaid図" }).waitFor();
    await page.locator("#message-input").press("Enter");
    assert.equal(
      await page.getByLabel("コードの言語", { exact: true }).inputValue(),
      "mermaid",
    );
    await page.locator("#modal-submit").click();
    assert.match(
      await page.locator("#message-input").inputValue(),
      /^```mermaid/,
    );
    await page.locator("#message-input").fill("");
  }
  if (
    !process.env.TEST_DEVELOPER_FOCUS ||
    process.env.TEST_DEVELOPER_FOCUS === "media"
  ) {
    phase = "media";
    const files = await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 480;
      canvas.height = 270;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#5865f2";
      ctx.fillRect(0, 0, 480, 270);
      ctx.fillStyle = "white";
      ctx.font = "bold 36px sans-serif";
      ctx.fillText("Oisiicord preview", 55, 145);
      const png = canvas.toDataURL("image/png").split(",")[1];
      const stream = canvas.captureStream(15),
        recorder = new MediaRecorder(stream, {
          mimeType: "video/webm;codecs=vp8",
        }),
        chunks = [];
      recorder.ondataavailable = (e) => chunks.push(e.data);
      const done = new Promise((resolve) => (recorder.onstop = resolve));
      recorder.start();
      let tick = 0;
      const animation = setInterval(() => {
        ctx.fillStyle = tick++ % 2 ? "#5865f2" : "#48c99b";
        ctx.fillRect(0, 0, 40, 40);
      }, 40);
      await new Promise((resolve) => setTimeout(resolve, 900));
      clearInterval(animation);
      recorder.stop();
      await done;
      stream.getTracks().forEach((t) => t.stop());
      const bytes = new Uint8Array(
        await new Blob(chunks, { type: "video/webm" }).arrayBuffer(),
      );
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);
      return { png, video: btoa(binary) };
    });
    await page.locator("#file-input").setInputFiles({
      name: "preview.png",
      mimeType: "image/png",
      buffer: Buffer.from(files.png, "base64"),
    });
    await send("画像プレビュー");
    await page.locator(".attachment-visual img").first().waitFor();
    await page.waitForFunction(
      () =>
        document.querySelector(".attachment-visual img").naturalWidth === 480,
    );
    await page
      .getByRole("button", { name: "preview.pngを拡大", exact: true })
      .click();
    await page.locator(".image-viewer").waitFor();
    await capture("image-viewer");
    await page
      .locator(".image-viewer")
      .getByRole("button", { name: "閉じる", exact: true })
      .click();
    await page.locator("#file-input").setInputFiles({
      name: "preview.webm",
      mimeType: "video/webm",
      buffer: Buffer.from(files.video, "base64"),
    });
    await send("動画プレビュー");
    await page.locator(".attachment-visual video").waitFor();
    await page.locator(".attachment-visual video").evaluate(async (v) => {
      v.muted = true;
      await v.play();
    });
    await page.waitForFunction(
      () => document.querySelector(".attachment-visual video").currentTime > 0,
    );
    await capture("media");
    const urls = await page
      .locator(".attachment-visual img,.attachment-visual video")
      .evaluateAll((nodes) => nodes.map((el) => el.src));
    assert(urls.every((url) => url.startsWith("blob:")));
    assert([...downloads.values()].every((n) => n === 1));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator(".attachment-media").last().scrollIntoViewIfNeeded();
    await capture("mobile-media");
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.setViewportSize({ width: 1440, height: 960 });
    tamper = true;
    await page.locator("#file-input").setInputFiles({
      name: "damaged.png",
      mimeType: "image/png",
      buffer: Buffer.from(files.png, "base64"),
    });
    await send("改変された添付");
    await page
      .locator(".attachment-media")
      .last()
      .locator(".preview-error")
      .waitFor();
    assert.equal(
      await page
        .locator(".attachment-media")
        .last()
        .locator("img,video")
        .count(),
      0,
    );
    await page.locator("#profile-settings").click();
    await page.getByRole("button", { name: "ログアウト", exact: true }).click();
    await page.locator("#auth").waitFor({ state: "visible" });
    assert.equal(
      await page.evaluate(
        async (urls) =>
          (
            await Promise.all(
              urls.map((url) =>
                fetch(url).then(
                  () => false,
                  () => true,
                ),
              ),
            )
          ).every(Boolean),
        urls,
      ),
      true,
    );
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      scope: process.env.TEST_DEVELOPER_FOCUS ?? "all",
      phase,
      code: true,
      isolatedMermaid: true,
      svgExport: true,
      converter: true,
      encryptedImageVideo: true,
      tamperRejected: true,
      blobCleanup: true,
    }),
  );
} catch (error) {
  console.error(
    "PHASE",
    phase,
    "UI",
    await page
      .locator("#toast")
      .textContent()
      .catch(() => ""),
    await page
      .locator(".code-error")
      .allTextContents()
      .catch(() => []),
    "CONSOLE",
    consoleErrors.slice(-8),
  );
  await page
    .screenshot({
      path: resolve(shots, "developer-diagnostic.png"),
      fullPage: true,
    })
    .catch(() => {});
  throw error;
} finally {
  await browser.close();
  app.stop();
  rmSync(temp, { recursive: true, force: true });
}
