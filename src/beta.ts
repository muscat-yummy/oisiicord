import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";

const defaults = { beta_mode: false, code: "" };
export class BetaSettingsError extends Error {}
function decodeSettings(data: Uint8Array) {
  const encoding =
    data[0] === 0xff && data[1] === 0xfe
      ? "utf-16le"
      : data[0] === 0xfe && data[1] === 0xff
        ? "utf-16be"
        : "utf-8";
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(data);
  } catch {
    throw new BetaSettingsError(
      "beta.jsonの文字コードをUTF-8またはBOM付きUTF-16にしてください",
    );
  }
}
export function createBetaSettings(directory: string) {
  mkdirSync(directory, { recursive: true });
  function checkDirectory() {
    const folder = lstatSync(directory);
    if (!folder.isDirectory() || folder.isSymbolicLink())
      throw new BetaSettingsError("settingsを通常のフォルダにしてください");
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
      if (!file.isFile() || file.isSymbolicLink())
        throw new BetaSettingsError("beta.jsonを通常のファイルにしてください");
      if (file.size > 64 * 1024)
        throw new BetaSettingsError("beta.jsonは64 KiBまでです");
      let value;
      const raw = decodeSettings(readFileSync(path));
      try {
        value = JSON.parse(raw);
      } catch {
        throw new BetaSettingsError("beta.jsonのJSON形式が不正です");
      }
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new BetaSettingsError(
          "beta.jsonに設定オブジェクトを指定してください",
        );
      if (typeof value.beta_mode !== "boolean")
        throw new BetaSettingsError(
          "beta.jsonのbeta_modeはtrueかfalseで指定してください",
        );
      if (typeof value.code !== "string")
        throw new BetaSettingsError(
          "beta.jsonのcodeは文字列で指定してください",
        );
      return {
        required: value.beta_mode && value.code.length > 0,
        code: value.code,
      };
    } catch (error: any) {
      if (error.code === "ENOENT") return { required: false, code: "" };
      if (error instanceof BetaSettingsError) throw error;
      if (["EACCES", "EPERM"].includes(error.code))
        throw new BetaSettingsError(
          "beta.jsonの読み取り権限を確認してください",
        );
      throw new BetaSettingsError("beta.jsonを読み取れません");
    }
  };
}
export function matchesBetaCode(expected: string, candidate: unknown) {
  if (typeof candidate !== "string") return false;
  const hash = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(expected), hash(candidate));
}
