import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranding } from "../src/branding";

const temporary: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "oisiicord-branding-"));
  temporary.push(root);
  mkdirSync(join(root, "public"));
  mkdirSync(join(root, "settings"));
  writeFileSync(
    join(root, "public", "icon.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  );
  writeFileSync(
    join(root, "public", "manifest.webmanifest"),
    '{"name":"Oisiicord","icons":[]}',
  );
  const handler = createBranding(root, { "Referrer-Policy": "no-referrer" });
  const request = (
    path: string,
    init?: ConstructorParameters<typeof Request>[1],
  ) => {
    const url = new URL(path, "http://localhost");
    return handler(new Request(url.toString(), init), url);
  };
  return { root, request };
}
afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6do8AAAAASUVORK5CYII=",
  "base64",
);

test("branding falls back to the default icon and exposes only explicit routes", async () => {
  const { request } = fixture();
  const icon = (await request("/app-icon"))!;
  expect(icon.status).toBe(200);
  expect(icon.headers.get("content-type")).toBe("image/svg+xml");
  expect(icon.headers.get("referrer-policy")).toBe("no-referrer");
  expect(await (await request("/api/branding"))!.json()).toEqual({
    icon: false,
    dmSound: false,
  });
  expect((await request("/settings/dm.mp3"))!.status).toBe(404);
  expect((await request("/settings/icon.png"))!.status).toBe(404);
  expect(await request("/settings/secrets.json")).toBeUndefined();
  expect((await request("/app-icon", { method: "POST" }))!.status).toBe(405);
});
test("custom PNG and MP3 support explicit content types, HEAD and byte ranges", async () => {
  const { root, request } = fixture();
  writeFileSync(join(root, "settings", "icon.png"), png);
  writeFileSync(join(root, "settings", "dm.mp3"), "ID3test-audio");
  const icon = (await request("/app-icon"))!;
  expect(icon.headers.get("content-type")).toBe("image/png");
  expect(Buffer.from(await icon.arrayBuffer())).toEqual(png);
  const head = (await request("/settings/icon.png", { method: "HEAD" }))!;
  expect(await head.text()).toBe("");
  expect(head.headers.get("content-length")).toBe(String(png.length));
  const audio = (await request("/settings/dm.mp3", {
    headers: { Range: "bytes=3-6" },
  }))!;
  expect(audio.status).toBe(206);
  expect(audio.headers.get("content-type")).toBe("audio/mpeg");
  expect(audio.headers.get("content-range")).toBe("bytes 3-6/13");
  expect(await audio.text()).toBe("test");
  const suffix = (await request("/settings/dm.mp3", {
    headers: { Range: "bytes=-5" },
  }))!;
  expect(await suffix.text()).toBe("audio");
  expect(
    (await request("/settings/dm.mp3", { headers: { Range: "bytes=100-" } }))!
      .status,
  ).toBe(416);
  const manifest = (await (await request("/manifest.webmanifest"))!.json()) as {
    icons: { src: string; type: string }[];
  };
  expect(manifest.icons[0]).toMatchObject({
    src: "/app-icon",
    type: "image/png",
  });
  expect(await (await request("/api/branding"))!.json()).toEqual({
    icon: true,
    dmSound: true,
  });
});
test("invalid, oversized and symlinked custom files are rejected", async () => {
  const { root, request } = fixture();
  writeFileSync(join(root, "settings", "icon.png"), "not a PNG");
  expect((await request("/app-icon"))!.headers.get("content-type")).toBe(
    "image/svg+xml",
  );
  const oversized = Buffer.from(png);
  oversized.writeUInt32BE(9000, 16);
  writeFileSync(join(root, "settings", "icon.png"), oversized);
  expect((await request("/settings/icon.png"))!.status).toBe(404);
  writeFileSync(
    join(root, "settings", "dm.mp3"),
    Buffer.alloc(20 * 1024 * 1024 + 1),
  );
  expect((await request("/settings/dm.mp3"))!.status).toBe(404);
  if (process.platform !== "win32") {
    rmSync(join(root, "settings", "icon.png"));
    writeFileSync(join(root, "outside.png"), png);
    symlinkSync(join(root, "outside.png"), join(root, "settings", "icon.png"));
    expect((await request("/settings/icon.png"))!.status).toBe(404);
  }
});

test("host-written changelog is optional and read fresh without serving other settings", async () => {
  const { root, request } = fixture(),
    path = join(root, "settings", "changelog.md");
  expect(await (await request("/api/changelog"))!.json()).toEqual({
    content: "",
  });
  const content = "## 2026-10-25 自分で書いた更新\n\n本文\n- 変更点";
  writeFileSync(path, content);
  expect(await (await request("/api/changelog"))!.json()).toEqual({ content });
  writeFileSync(path, "## 書き換えた更新");
  expect(await (await request("/api/changelog"))!.json()).toEqual({
    content: "## 書き換えた更新",
  });
  expect(
    await (await request("/api/changelog", { method: "HEAD" }))!.text(),
  ).toBe("");
  expect((await request("/api/changelog", { method: "POST" }))!.status).toBe(
    405,
  );
  expect(await request("/settings/changelog.md")).toBeUndefined();
  writeFileSync(path, Buffer.alloc(128 * 1024 + 1));
  expect(await (await request("/api/changelog"))!.json()).toEqual({
    content: "",
  });
  if (process.platform !== "win32") {
    rmSync(path);
    writeFileSync(join(root, "outside.md"), "private file");
    symlinkSync(join(root, "outside.md"), path);
    expect(await (await request("/api/changelog"))!.json()).toEqual({
      content: "",
    });
  }
});
