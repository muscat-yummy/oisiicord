export const MAX_ENCRYPTED_FILE = 25 * 1024 * 1024 + 16;
const idPattern = /^[a-zA-Z0-9_-]{1,100}$/;
export class FileServiceError extends Error {}
export function createFileAdapter(origin = "https://api.end2end.tech") {
  const base = new URL(origin);
  if (
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    (base.origin !== "https://api.end2end.tech" &&
      !(
        base.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)
      ))
  )
    throw Error("添付APIの接続先が不正です");
  async function request(path: string, options: RequestInit = {}) {
    try {
      const response = await fetch(new URL(path, base), {
        ...options,
        redirect: "error",
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok)
        throw new FileServiceError(
          "添付APIに失敗しました (" + response.status + ")",
        );
      return response;
    } catch (error) {
      if (error instanceof FileServiceError) throw error;
      throw new FileServiceError("添付サービスに接続できません");
    }
  }
  async function json(response: Response) {
    try {
      const raw = await read(response, 65536);
      const out = JSON.parse(new TextDecoder().decode(raw));
      if (!out || typeof out !== "object" || Array.isArray(out)) throw Error();
      return out;
    } catch (error) {
      if (error instanceof FileServiceError) throw error;
      throw new FileServiceError("添付APIの応答が不正です");
    }
  }
  async function read(response: Response, max: number) {
    if (Number(response.headers.get("content-length")) > max) {
      await response.body?.cancel();
      throw new FileServiceError("添付APIのサイズ制限を超えています");
    }
    const reader = response.body?.getReader();
    if (!reader) return new Uint8Array();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel();
        throw new FileServiceError("添付APIのサイズ制限を超えています");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }
  return {
    async upload(data: Uint8Array) {
      if (!data.length || data.length > MAX_ENCRYPTED_FILE)
        throw new FileServiceError("添付のサイズが不正です");
      const form = new FormData();
      form.append("file", new Blob([data]), crypto.randomUUID() + ".enc");
      const out = await json(
        await request("/upload", { method: "POST", body: form }),
      );
      if (
        out.Status !== "OK" ||
        typeof out.FileID !== "string" ||
        !idPattern.test(out.FileID) ||
        typeof out.RemovePassword !== "string" ||
        !out.RemovePassword.length ||
        out.RemovePassword.length > 256 ||
        /[\x00-\x1f\x7f]/.test(out.RemovePassword)
      )
        throw new FileServiceError("添付APIのアップロードに失敗しました");
      return { id: out.FileID, removePassword: out.RemovePassword };
    },
    async download(id: string) {
      if (!idPattern.test(id)) throw new FileServiceError("添付IDが不正です");
      return read(
        await request("/download?id=" + encodeURIComponent(id)),
        MAX_ENCRYPTED_FILE,
      );
    },
    async remove(id: string, password: string) {
      if (!idPattern.test(id) || !password || password.length > 256)
        throw new FileServiceError("添付の削除情報が不正です");
      const params = new URLSearchParams({ id, password });
      const out = await json(await request("/delete?" + params));
      if (out.Status !== "OK" || out.Error)
        throw new FileServiceError("添付APIの削除に失敗しました");
    },
  };
}
