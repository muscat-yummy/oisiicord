import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const settingKeys = [
  "PORT",
  "HOST",
  "APP_ORIGIN",
  "DATABASE_PATH",
  "ICE_SERVERS",
] as const;
type Environment = Record<string, string | undefined>;
export type Storage = {
  databasePath: string;
  dataDir: string;
  backupDir: string;
  configPath: string;
  env: Environment;
};

export function defaultDataDir(
  env: Environment = process.env,
  platform = process.platform,
  home = homedir(),
) {
  if (platform === "win32")
    return join(
      env.LOCALAPPDATA || join(home, "AppData", "Local"),
      "Oisiicord",
    );
  if (platform === "darwin")
    return join(home, "Library", "Application Support", "Oisiicord");
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "oisiicord");
}

function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

export function writePrivateJSON(path: string, value: unknown) {
  privateDirectory(dirname(path));
  const temporary = path + "." + crypto.randomUUID() + ".tmp";
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

// VACUUM INTO includes committed WAL pages and produces a standalone snapshot.
// The temporary snapshot is checked before it becomes the destination file.
export function snapshotDatabase(source: string, destination: string) {
  if (resolve(source) === resolve(destination))
    throw Error("バックアップ先が元のDBと同じ");
  if (existsSync(destination))
    throw Error("バックアップ先は既に存在する: " + destination);
  privateDirectory(dirname(destination));
  const temporary = destination + "." + crypto.randomUUID() + ".tmp";
  const db = new Database(source, { readonly: true, strict: true });
  try {
    db.exec("PRAGMA busy_timeout=5000");
    db.query("VACUUM INTO ?").run(temporary);
    chmodSync(temporary, 0o600);
    const check = new Database(temporary, { readonly: true });
    try {
      if (
        (check.query("PRAGMA integrity_check").get() as any)
          ?.integrity_check !== "ok"
      )
        throw Error("DBの整合性確認に失敗した");
    } finally {
      check.close();
    }
    // Atomic, exclusive publication; never replace an existing database.
    linkSync(temporary, destination);
  } finally {
    db.close();
    rmSync(temporary, { force: true });
  }
  return destination;
}

export function backupDatabase(
  path: string,
  directory = join(dirname(path), "backups"),
  label = "manual",
) {
  if (path === ":memory:" || !existsSync(path))
    throw Error("保存済みのDBがない: " + path);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return snapshotDatabase(
    path,
    join(
      directory,
      `${label}-${stamp}-${crypto.randomUUID().slice(0, 8)}.sqlite`,
    ),
  );
}

export function prepareStorage(
  options: {
    root?: string;
    env?: Environment;
    platform?: NodeJS.Platform;
    home?: string;
  } = {},
): Storage {
  const root = resolve(options.root ?? projectRoot),
    environment = options.env ?? process.env;
  const localPath = join(root, ".env");
  const local = existsSync(localPath)
    ? parseEnv(readFileSync(localPath, "utf8"))
    : {};
  const dataDir = resolve(
    root,
    environment.OISIICORD_DATA_DIR ||
      local.OISIICORD_DATA_DIR ||
      defaultDataDir(environment, options.platform, options.home),
  );
  const configPath = join(dataDir, "config.json"),
    backupDir = join(dataDir, "backups");
  privateDirectory(dataDir);
  const saved = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, "utf8"))
    : {};
  if (!saved || typeof saved !== "object" || Array.isArray(saved))
    throw Error("保存済み設定の形式が不正: " + configPath);
  const env: Environment = {};
  for (const key of settingKeys) {
    if (saved[key] !== undefined && typeof saved[key] !== "string")
      throw Error("保存済み設定の形式が不正: " + key);
    env[key] = environment[key] ?? local[key] ?? saved[key];
  }
  const legacyPath = join(root, "data", "oisiicord.sqlite"),
    defaultPath = join(dataDir, "oisiicord.sqlite");
  const configured = env.DATABASE_PATH?.trim();
  // The old .env.example explicitly set this relative path. Adopt it too.
  const legacySetting =
    configured &&
    !isAbsolute(configured) &&
    resolve(root, configured) === legacyPath;
  const databasePath =
    !configured || legacySetting
      ? defaultPath
      : configured === ":memory:"
        ? configured
        : resolve(root, configured);
  const importedPath = join(dataDir, "imported.json");
  const imported: string[] = existsSync(importedPath)
    ? JSON.parse(readFileSync(importedPath, "utf8"))
    : [];
  if (!Array.isArray(imported) || imported.some((p) => typeof p !== "string"))
    throw Error("引き継ぎ記録の形式が不正");
  if (
    databasePath === defaultPath &&
    resolve(legacyPath) !== resolve(defaultPath) &&
    existsSync(legacyPath) &&
    !imported.includes(legacyPath)
  ) {
    if (existsSync(defaultPath))
      throw Error(
        `DBが2つ見つかった。上書きせず停止した。保存先: ${defaultPath} / 旧DB: ${legacyPath}`,
      );
    snapshotDatabase(legacyPath, defaultPath);
    writePrivateJSON(importedPath, [...imported, legacyPath]);
    console.log("既存データを引き継いだ: " + defaultPath);
  }
  const config: Record<string, string> = {};
  for (const key of settingKeys)
    if (env[key] !== undefined) config[key] = env[key]!;
  if (databasePath !== ":memory:") config.DATABASE_PATH = databasePath;
  writePrivateJSON(configPath, config);
  return { databasePath, dataDir, backupDir, configPath, env };
}
