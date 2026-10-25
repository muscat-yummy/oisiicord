import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareStorage } from "../src/storage";
import { updateArchive } from "../src/updater";

const temporary: string[] = [];
afterEach(() => {
  for (const p of temporary.splice(0))
    rmSync(p, { recursive: true, force: true });
});
function setup() {
  const base = mkdtempSync(join(tmpdir(), "oisiicord-updater-"));
  temporary.push(base);
  const root = join(base, "app");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "public"));
  writeFileSync(
    join(root, "package.json"),
    '{"name":"oisiicord","private":true}',
  );
  writeFileSync(join(root, "src", "server.ts"), "old server");
  writeFileSync(join(root, ".env"), "PORT=4000\n");
  writeFileSync(join(root, "notes.txt"), "custom notes");
  mkdirSync(join(root, "data"));
  writeFileSync(join(root, "data", "custom-file"), "user data");
  const storage = prepareStorage({
    root,
    env: { OISIICORD_DATA_DIR: join(base, "persistent") },
  });
  const db = new Database(storage.databasePath, { create: true });
  db.exec(
    "CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES('keep me')",
  );
  db.close();
  return { root, storage };
}
async function archive(revision: string, extra: Record<string, string> = {}) {
  const source = {
    "package.json": '{"name":"oisiicord","private":true}',
    "src/server.ts": "new server " + revision,
    "public/app.js": "new client",
    "public/index.html": "<html></html>",
    ...extra,
  };
  return await new Bun.Archive(
    Object.fromEntries(
      Object.entries(source).map(([path, text]) => [
        `oisiicord-${revision}/${path}`,
        text,
      ]),
    ),
    { compress: "gzip" },
  ).bytes();
}
function fetcher(revision: string, tarball: Uint8Array, downloadStatus = 200) {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (
      url ===
      "https://api.github.com/repos/muscat-yummy/oisiicord/git/ref/heads/main"
    )
      return Response.json({ object: { sha: revision } });
    expect(url).toBe(
      `https://codeload.github.com/muscat-yummy/oisiicord/tar.gz/${revision}`,
    );
    return new Response(tarball, { status: downloadStatus });
  }) as typeof fetch;
}
test("ZIP installs update without git, preserve data/config/custom files and keep source backups", async () => {
  const { root, storage } = setup(),
    a = "a".repeat(40),
    b = "b".repeat(40);
  const first = await updateArchive(root, {
    storage,
    fetcher: fetcher(
      a,
      await archive(a, {
        "public/obsolete.js": "old asset",
        ".env": "PORT=9999",
        "data/custom-file": "erase",
      }),
    ),
  });
  expect(first.updated).toBe(true);
  expect(readFileSync(join(root, "src", "server.ts"), "utf8")).toBe(
    "new server " + a,
  );
  expect(readFileSync(join(root, ".env"), "utf8")).toBe("PORT=4000\n");
  expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("custom notes");
  expect(readFileSync(join(root, "data", "custom-file"), "utf8")).toBe(
    "user data",
  );
  expect(
    readFileSync(join(first.sourceBackup!, "src", "server.ts"), "utf8"),
  ).toBe("old server");
  const backup = new Database(first.backup!, { readonly: true });
  expect(backup.query("SELECT value FROM retained").get()).toEqual({
    value: "keep me",
  });
  backup.close();
  await updateArchive(root, { storage, fetcher: fetcher(b, await archive(b)) });
  expect(existsSync(join(root, "public", "obsolete.js"))).toBe(false);
  expect(readFileSync(join(root, "src", "server.ts"), "utf8")).toBe(
    "new server " + b,
  );
  writeFileSync(join(root, "src", "server.ts"), "local edit");
  await expect(
    updateArchive(root, {
      storage,
      fetcher: fetcher("c".repeat(40), new Uint8Array()),
    }),
  ).rejects.toThrow("変更したソース");
  expect(readFileSync(join(root, "src", "server.ts"), "utf8")).toBe(
    "local edit",
  );
});
test("download or dependency installation failure leaves the installed application intact", async () => {
  const { root, storage } = setup(),
    revision = "d".repeat(40);
  await expect(
    updateArchive(root, {
      storage,
      fetcher: fetcher(revision, new Uint8Array(), 503),
    }),
  ).rejects.toThrow("HTTP 503");
  const invalid = await archive(revision, { "bun.lock": "invalid lockfile" });
  await expect(
    updateArchive(root, { storage, fetcher: fetcher(revision, invalid) }),
  ).rejects.toThrow("依存関係");
  expect(readFileSync(join(root, "src", "server.ts"), "utf8")).toBe(
    "old server",
  );
  expect(existsSync(join(root, ".oisiicord-update.json"))).toBe(false);
  expect(
    readdirSync(join(root, "..")).some((name) =>
      name.startsWith(".oisiicord-update-"),
    ),
  ).toBe(false);
});
test("publication errors roll back replaced source files and retain user files", async () => {
  const { root, storage } = setup(),
    revision = "e".repeat(40);
  writeFileSync(join(root, "src", "nested"), "user file blocking a directory");
  await expect(
    updateArchive(root, {
      storage,
      fetcher: fetcher(
        revision,
        await archive(revision, { "src/nested/file.ts": "new" }),
      ),
    }),
  ).rejects.toThrow();
  expect(readFileSync(join(root, "src", "server.ts"), "utf8")).toBe(
    "old server",
  );
  expect(readFileSync(join(root, "src", "nested"), "utf8")).toBe(
    "user file blocking a directory",
  );
  expect(readFileSync(join(root, ".env"), "utf8")).toBe("PORT=4000\n");
});

test("ZIP updates preserve host-written changelog and beta settings even when the archive includes them", async () => {
  const { root, storage } = setup(),
    revision = "e".repeat(40),
    content = "## My update\n\nHost-written text";
  mkdirSync(join(root, "settings"));
  writeFileSync(join(root, "settings", "changelog.md"), content);
  const beta = JSON.stringify({ beta_mode: true, code: crypto.randomUUID() });
  writeFileSync(join(root, "settings", "beta.json"), beta);
  await updateArchive(root, {
    storage,
    fetcher: fetcher(
      revision,
      await archive(revision, {
        "settings/changelog.md": "replacement text",
        "settings/beta.json": JSON.stringify({ beta_mode: false, code: "" }),
      }),
    ),
  });
  expect(readFileSync(join(root, "settings", "changelog.md"), "utf8")).toBe(
    content,
  );
  expect(readFileSync(join(root, "settings", "beta.json"), "utf8")).toBe(beta);
});

test("ZIP updates ignore edited env examples from old manifests and keep the local file", async () => {
  const { root, storage } = setup(),
    revision = "f".repeat(40);
  const old = "PORT=3000\n",
    current = "PORT=8765\n";
  writeFileSync(join(root, ".env.example"), current);
  writeFileSync(
    join(root, ".oisiicord-update.json"),
    JSON.stringify({
      revision: "a".repeat(40),
      files: {
        ".env.example": new Bun.CryptoHasher("sha256")
          .update(old)
          .digest("hex"),
      },
    }),
  );
  await updateArchive(root, {
    storage,
    fetcher: fetcher(
      revision,
      await archive(revision, { ".env.example": "PORT=9999\n" }),
    ),
  });
  expect(readFileSync(join(root, ".env.example"), "utf8")).toBe(current);
  expect(
    JSON.parse(readFileSync(join(root, ".oisiicord-update.json"), "utf8"))
      .files,
  ).not.toHaveProperty(".env.example");
  expect(readFileSync(join(root, ".env"), "utf8")).toBe("PORT=4000\n");
});
