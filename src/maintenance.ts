import { existsSync } from "node:fs";
import { join } from "node:path";
import { updateArchive } from "./updater";
import {
  backupDatabase,
  prepareStorage,
  projectRoot,
  type Storage,
} from "./storage";

function command(args: string[], root: string, quiet = false) {
  const result = Bun.spawnSync(args, {
    cwd: root,
    stdout: quiet ? "pipe" : "inherit",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw Error(
      `${args[0]} ${args[1]} に失敗した\n${result.stderr.toString().trim()}`,
    );
  return result.stdout?.toString().trim() ?? "";
}

export function updateProject(root = projectRoot, storage?: Storage) {
  // No reset, clean, stash or force: local work is never discarded.
  const top = command(["git", "rev-parse", "--show-toplevel"], root, true);
  if (command(["git", "rev-parse", "--show-prefix"], root, true) || !top)
    throw Error("リポジトリの直下で更新して");
  if (command(["git", "branch", "--show-current"], root, true) !== "main")
    throw Error("main ブランチで更新して");
  if (
    command(
      ["git", "status", "--porcelain", "--untracked-files=no"],
      root,
      true,
    )
  )
    throw Error("変更したソースがあるため更新を停止した。先にコミットして");
  command(["git", "fetch", "origin", "main"], root);
  command(
    ["git", "merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD"],
    root,
    true,
  );
  const paths = storage ?? prepareStorage({ root });
  const backup = existsSync(paths.databasePath)
    ? backupDatabase(paths.databasePath, paths.backupDir, "before-update")
    : null;
  if (backup) console.log("バックアップ: " + backup);
  command(["git", "merge", "--ff-only", "FETCH_HEAD"], root);
  command([process.execPath, "install", "--frozen-lockfile"], root);
  return { backup, databasePath: paths.databasePath };
}

if (import.meta.main) {
  try {
    const action = process.argv[2];
    if (action === "update") {
      const result = existsSync(join(projectRoot, ".git"))
        ? updateProject()
        : await updateArchive(projectRoot);
      if ("updated" in result && !result.updated) console.log("既に最新版");
      else
        console.log(
          "更新完了" +
            ("revision" in result ? ": " + result.revision.slice(0, 8) : ""),
        );
      if (result.backup) console.log("DBバックアップ: " + result.backup);
      if ("sourceBackup" in result && result.sourceBackup)
        console.log("ソースのバックアップ: " + result.sourceBackup);
      if (process.argv.includes("--start")) {
        const child = Bun.spawn([process.execPath, "start"], {
          cwd: projectRoot,
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });
        process.exitCode = await child.exited;
      } else console.log("bun start で起動して");
    } else if (action === "backup") {
      const paths = prepareStorage();
      console.log(backupDatabase(paths.databasePath, paths.backupDir));
    } else if (action === "data") {
      const paths = prepareStorage();
      console.log(
        `DB: ${paths.databasePath}\n設定: ${paths.configPath}\nバックアップ: ${paths.backupDir}`,
      );
    } else throw Error("update / backup / data を指定して");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
