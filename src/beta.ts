import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";

const defaults = { beta_mode: false, code: "" };
export function createBetaSettings(directory: string) {
  mkdirSync(directory, { recursive: true });
  function checkDirectory() {
    const folder = lstatSync(directory);
    if (!folder.isDirectory() || folder.isSymbolicLink())
      throw Error("beta.jsonの設定が不正です");
  }
  checkDirectory();
  const path = join(directory, "beta.json");
  try {
    writeFileSync(path, JSON.stringify(defaults, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error: any) {
    if (error.code !== "EEXIST") throw error;
  }
  return () => {
    try {
      checkDirectory();
      const file = lstatSync(path);
      if (!file.isFile() || file.isSymbolicLink() || file.size > 64 * 1024)
        throw Error();
      const value = JSON.parse(readFileSync(path, "utf8"));
      if (
        !value ||
        typeof value.beta_mode !== "boolean" ||
        typeof value.code !== "string"
      )
        throw Error();
      return {
        required: value.beta_mode && value.code.length > 0,
        code: value.code,
      };
    } catch (error: any) {
      if (error.code === "ENOENT") return { required: false, code: "" };
      throw Error("beta.jsonの設定が不正です");
    }
  };
}
export function matchesBetaCode(expected: string, candidate: unknown) {
  if (typeof candidate !== "string") return false;
  const hash = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(expected), hash(candidate));
}
