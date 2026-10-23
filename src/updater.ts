import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
  backupDatabase,
  prepareStorage,
  writePrivateJSON,
  type Storage,
} from "./storage";

const repository = "muscat-yummy/oisiicord";
const marker = ".oisiicord-update.json";
const hash = (bytes: Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
type Manifest = { revision: string; files: Record<string, string> };
const managed = (path: string) =>
  /^(src|public|tests|docs|\.github)\//.test(path) ||
  [
    "package.json",
    "bun.lock",
    "bun.lockb",
    "README.md",
    "SECURITY.md",
    "AGENTS.md",
    "LICENSE",
    "LICENSE.md",
    "tsconfig.json",
    ".gitignore",
    ".env.example",
  ].includes(path);

function destination(root: string, path: string) {
  if (
    !path ||
    path.includes("\\") ||
    path.includes(":") ||
    path.split("/").some((p) => !p || p === "." || p === "..") ||
    !managed(path)
  )
    throw Error("更新ファイルのパスが不正: " + path);
  const target = resolve(root, path);
  if (!target.startsWith(resolve(root) + sep))
    throw Error("更新先がアプリ外にある");
  let current = target;
  while (current !== resolve(root)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      throw Error("更新先にシンボリックリンクがある: " + current);
    current = dirname(current);
  }
  return target;
}

async function bytes(response: Response, limit: number) {
  if (!response.ok)
    throw Error("更新のダウンロードに失敗した: HTTP " + response.status);
  const reader = response.body?.getReader();
  if (!reader) throw Error("更新データが空");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw Error("更新データのサイズ上限を超えた");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export async function updateArchive(
  root: string,
  options: { storage?: Storage; fetcher?: typeof fetch } = {},
) {
  if (typeof Bun.Archive !== "function")
    throw Error("bun upgrade で Bun 1.3.6 以降に更新してから実行して");
  const fetcher = options.fetcher ?? fetch;
  const ref = await fetcher(
    `https://api.github.com/repos/${repository}/git/ref/heads/main`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Oisiicord-Updater",
      },
      signal: AbortSignal.timeout(30000),
    },
  );
  const info = JSON.parse((await bytes(ref, 1024 * 1024)).toString()),
    revision = info?.object?.sha;
  if (typeof revision !== "string" || !/^[a-f0-9]{40}$/.test(revision))
    throw Error("更新バージョンを取得できない");
  const manifestPath = join(root, marker);
  const previous: Manifest | undefined = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8"))
    : undefined;
  if (
    previous &&
    (!previous.files ||
      typeof previous.files !== "object" ||
      Array.isArray(previous.files))
  )
    throw Error("更新記録の形式が不正");
  if (previous?.revision === revision)
    return { updated: false, revision, backup: null, sourceBackup: null };
  if (previous)
    for (const [path, expected] of Object.entries(previous.files)) {
      const target = destination(root, path);
      if (!existsSync(target) || hash(readFileSync(target)) !== expected)
        throw Error("変更したソースがあるため更新を停止した: " + path);
    }
  console.log("最新版をダウンロード中…");
  const download = await fetcher(
    `https://codeload.github.com/${repository}/tar.gz/${revision}`,
    { signal: AbortSignal.timeout(60000) },
  );
  const entries = await new Bun.Archive(
    await bytes(download, 32 * 1024 * 1024),
  ).files();
  const prefix = `oisiicord-${revision}/`,
    files = new Map<string, File>();
  let size = 0;
  for (const [entry, file] of entries) {
    if (!entry.startsWith(prefix)) throw Error("更新アーカイブの形式が不正");
    const path = entry.slice(prefix.length);
    if (!managed(path)) continue;
    destination(root, path);
    size += file.size;
    if (size > 128 * 1024 * 1024) throw Error("展開後のサイズ上限を超えた");
    files.set(path, file);
  }
  for (const required of [
    "package.json",
    "src/server.ts",
    "public/app.js",
    "public/index.html",
  ])
    if (!files.has(required))
      throw Error("更新に必要なファイルがない: " + required);
  const pkg = JSON.parse(await files.get("package.json")!.text());
  if (pkg.name !== "oisiicord") throw Error("更新対象のアプリが異なる");
  if (pkg.engines?.bun && !Bun.semver.satisfies(Bun.version, pkg.engines.bun))
    throw Error("先に bun upgrade を実行して");
  const stage = mkdtempSync(join(dirname(root), ".oisiicord-update-"));
  try {
    const next: Manifest = { revision, files: {} };
    for (const [path, file] of files) {
      const buffer = Buffer.from(await file.arrayBuffer()),
        target = destination(stage, path);
      mkdirSync(dirname(target), { recursive: true });
      await Bun.write(target, buffer);
      next.files[path] = hash(buffer);
    }
    const install = Bun.spawnSync(
      [process.execPath, "install", "--frozen-lockfile"],
      { cwd: stage, stdout: "inherit", stderr: "pipe" },
    );
    if (install.exitCode !== 0)
      throw Error(
        "依存関係の更新に失敗した。アプリは変更していない\n" +
          install.stderr.toString(),
      );
    const paths = options.storage ?? prepareStorage({ root });
    const backup = existsSync(paths.databasePath)
      ? backupDatabase(paths.databasePath, paths.backupDir, "before-update")
      : null;
    const sourceBackup = join(
      paths.backupDir,
      "source-" + Date.now() + "-" + crypto.randomUUID().slice(0, 8),
    );
    mkdirSync(sourceBackup, { recursive: true, mode: 0o700 });
    const affected = [
      ...new Set([...files.keys(), ...Object.keys(previous?.files ?? {})]),
    ];
    const originals = new Set<string>();
    for (const path of affected) {
      const source = destination(root, path);
      if (existsSync(source)) {
        const target = destination(sourceBackup, path);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(source, target);
        originals.add(path);
      }
    }
    if (existsSync(manifestPath))
      copyFileSync(manifestPath, join(sourceBackup, marker));
    const changed: string[] = [],
      nodePath = join(root, "node_modules"),
      newNodes = join(stage, "node_modules"),
      oldNodes = join(stage, "previous-node-modules");
    let movedOldNodes = false,
      installedNodes = false;
    if (existsSync(nodePath) && lstatSync(nodePath).isSymbolicLink())
      throw Error("node_modules がシンボリックリンクのため更新を停止した");
    try {
      for (const path of affected) {
        const target = destination(root, path);
        changed.push(path);
        if (files.has(path)) {
          mkdirSync(dirname(target), { recursive: true });
          renameSync(destination(stage, path), target);
        } else rmSync(target);
      }
      if (existsSync(newNodes)) {
        if (existsSync(nodePath)) {
          renameSync(nodePath, oldNodes);
          movedOldNodes = true;
        }
        renameSync(newNodes, nodePath);
        installedNodes = true;
      }
      writePrivateJSON(manifestPath, next);
    } catch (error) {
      if (installedNodes) rmSync(nodePath, { recursive: true, force: true });
      if (movedOldNodes) renameSync(oldNodes, nodePath);
      for (const path of changed.reverse()) {
        const target = destination(root, path);
        if (originals.has(path))
          copyFileSync(destination(sourceBackup, path), target);
        else if (existsSync(target)) rmSync(target, { force: true });
      }
      throw error;
    }
    return { updated: true, revision, backup, sourceBackup };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
