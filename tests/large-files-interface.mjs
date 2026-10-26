import { chromium, webkit } from "playwright";
import { createApp } from "../src/server.ts";
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const directory = mkdtempSync(resolve(tmpdir(), "oisiicord-large-files-"));
const shots = resolve(import.meta.dir, "../test-results/feedback");
mkdirSync(shots, { recursive: true });
const blobs = new Map();
let tamper = false,
  peak = 0;
const provider = Bun.serve({
  port: 0,
  maxRequestBodySize: 26 * 1024 * 1024,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/upload") {
      const form = await request.formData(),
        data = await form.get("file").arrayBuffer(),
        id = crypto.randomUUID();
      peak = Math.max(peak, data.byteLength);
      blobs.set(id, { data, password: crypto.randomUUID() });
      return Response.json({
        Status: "OK",
        FileID: id,
        RemovePassword: blobs.get(id).password,
      });
    }
    const item = blobs.get(url.searchParams.get("id"));
    if (!item) return new Response(null, { status: 404 });
    if (url.pathname === "/download") {
      const data = item.data.slice(0);
      if (tamper) new Uint8Array(data)[0] ^= 1;
      return new Response(data);
    }
    if (
      url.pathname === "/delete" &&
      item.password === url.searchParams.get("password")
    ) {
      blobs.delete(url.searchParams.get("id"));
      return Response.json({ Status: "OK" });
    }
    return new Response(null, { status: 404 });
  },
});
const app = createApp({
  port: 31979,
  origin: "http://localhost:31979",
  path: resolve(directory, "chat.sqlite"),
  settingsDirectory: resolve(directory, "settings"),
  fileOrigin: "http://127.0.0.1:" + provider.port,
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
  viewport: { width: 1180, height: 700 },
  hasTouch: true,
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.setDefaultTimeout(30000);
try {
  await page.goto(app.origin);
  await page.locator("#auth-switch").click();
  await page.locator("#username").fill("large_file_test");
  await page.locator("#display").fill("添付テスト");
  await page.locator("#password").fill(crypto.randomUUID());
  await page.locator("#auth-submit").click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  await page
    .getByRole("button", { name: "サーバーを作成", exact: true })
    .click();
  await page.locator("#modal-body input").fill("大容量添付");
  await page.locator("#modal-submit").click();
  await page.locator("#message-input").waitFor({ state: "visible" });
  // 32MiB + 123 exercises two full chunks and a final short chunk.
  const source = Buffer.alloc(32 * 1024 * 1024 + 123);
  for (let i = 0; i < source.length; i++) source[i] = (i * 13 + 7) % 251;
  await page
    .locator("#file-input")
    .setInputFiles({
      name: "大きな添付.bin",
      mimeType: "application/octet-stream",
      buffer: source,
    });
  await page.locator("#send").click();
  await page.locator(".file-card").waitFor();
  assert.equal(blobs.size, 3);
  assert.ok(peak <= 16 * 1024 * 1024 + 16);
  const downloadEvent = page.waitForEvent("download");
  await page
    .locator(".file-card")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  const download = await downloadEvent;
  assert.equal(await download.failure(), null);
  assert.equal(download.suggestedFilename(), "大きな添付.bin");
  assert.deepEqual(readFileSync(await download.path()), source);
  await page.waitForFunction(() => document.querySelector("#toast").hidden);
  await page.screenshot({
    path: resolve(shots, engine + "-large-file.png"),
    fullPage: true,
  });
  tamper = true;
  await page
    .locator(".file-card")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await page
    .getByText("添付ファイルのハッシュが一致しない", { exact: true })
    .waitFor();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      engine,
      roundtripBytes: source.length,
      uploadedParts: blobs.size,
      peakEncryptedPart: peak,
      tamperRejected: true,
      errors,
    }),
  );
} finally {
  await browser.close();
  app.server.stop(true);
  app.db.close();
  provider.stop(true);
  rmSync(directory, { recursive: true, force: true });
}
