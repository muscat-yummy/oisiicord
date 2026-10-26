import * as C from "./crypto.js";
/** @typedef {(path: string, options?: RequestInit) => Promise<Response>} FileRequest */
export const STANDARD_FILE_SIZE = 1024 * 1024 * 1024;
export const MAX_FILE_SIZE = 2048 * 1024 * 1024;
export const CHUNK_SIZE = 16 * 1024 * 1024;
const SINGLE_SIZE = 25 * 1024 * 1024;
export function attachmentParts(file) {
  if (file?.v !== 2) return [file];
  if (
    !Number.isSafeInteger(file.size) ||
    file.size <= SINGLE_SIZE ||
    file.size > MAX_FILE_SIZE ||
    !Array.isArray(file.chunks) ||
    file.chunks.length !== Math.ceil(file.size / CHUNK_SIZE)
  )
    throw Error("添付情報が不正");
  let total = 0;
  for (const [i, part] of file.chunks.entries()) {
    const size = Math.min(CHUNK_SIZE, file.size - total);
    if (
      part?.v === 2 ||
      part.size !== size ||
      !/^[\w-]{1,100}$/.test(part.id) ||
      !/^[A-Za-z0-9+/]{43}=$/.test(part.key) ||
      !/^[A-Za-z0-9+/]{16}$/.test(part.iv) ||
      !/^[A-Za-z0-9+/]{43}=$/.test(part.hash) ||
      part.index !== i
    )
      throw Error("添付情報が不正");
    total += part.size;
  }
  return file.chunks;
}
/** @param {FileRequest} request */
export async function fileRequest(path, options = {}, request = fetch) {
  for (let attempt = 0; ; attempt++) {
    const response = await request(path, options);
    if (response.status !== 429 || attempt >= 3) return response;
    const seconds = Number(response.headers.get("Retry-After"));
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60)
      return response;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(1, seconds) * 1000),
    );
  }
}
/** @param {FileRequest} request */
export async function removeAttachment(file, request = fetch) {
  let failed = false;
  for (const part of attachmentParts(file)) {
    if (!part?.removePassword) continue;
    try {
      if (!/^[\w-]{1,100}$/.test(part.id)) throw Error();
      const response = await fileRequest(
        "/api/files/" + part.id,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: part.removePassword }),
        },
        request,
      );
      if (!response.ok) throw Error();
    } catch {
      failed = true;
    }
  }
  if (failed) throw Error("外部APIで添付の削除に失敗した");
}
/** @param {{request?: FileRequest, progress?: (bytes: number, total: number) => void, maximum?: number}} options */
export async function uploadAttachment(file, options = {}) {
  const {
    request = fetch,
    progress = () => {},
    maximum = STANDARD_FILE_SIZE,
  } = options;
  if (
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    file.size > Math.min(maximum, MAX_FILE_SIZE)
  )
    throw Error(
      `1ファイル${Math.min(maximum, MAX_FILE_SIZE) / 1024 / 1024} MiBまでです`,
    );
  const chunks = [];
  const split = file.size > SINGLE_SIZE;
  let transfer = null;
  if (split) {
    const response = await fileRequest(
      "/api/file-transfers",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ size: file.size }),
      },
      request,
    );
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw Error(result.error ?? "添付の送信を開始できない");
    }
    transfer = await response.json();
    if (!/^[\w-]{1,100}$/.test(transfer.id) || transfer.size !== file.size)
      throw Error("添付APIの応答が不正");
  }
  try {
    for (
      let offset = 0;
      offset < Math.max(1, file.size);
      offset += split ? CHUNK_SIZE : Math.max(1, file.size)
    ) {
      const source = split
        ? new File([file.slice(offset, offset + CHUNK_SIZE)], "", {
            type: "application/octet-stream",
          })
        : file;
      const { ciphertext, descriptor } = await C.encryptFile(source);
      const response = await fileRequest(
        "/api/files",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            ...(transfer
              ? {
                  "X-File-Transfer": transfer.id,
                  "X-File-Offset": String(offset),
                }
              : {}),
          },
          body: ciphertext,
        },
        request,
      );
      if (!response.ok) throw Error("添付を送信できない");
      const result = await response.json();
      if (
        !/^[\w-]{1,100}$/.test(result.id) ||
        typeof result.removePassword !== "string"
      )
        throw Error("添付APIの応答が不正");
      chunks.push({
        ...descriptor,
        id: result.id,
        removePassword: result.removePassword,
        ...(split ? { index: chunks.length } : {}),
      });
      progress(Math.min(file.size, offset + source.size), file.size);
    }
    return split
      ? { v: 2, name: file.name, mime: file.type, size: file.size, chunks }
      : chunks[0];
  } catch (error) {
    for (const chunk of chunks)
      await removeAttachment(chunk, request).catch(() => {});
    throw error;
  } finally {
    if (transfer)
      await request("/api/file-transfers/" + transfer.id, {
        method: "DELETE",
      }).catch(() => {});
  }
}
/** @param {FileRequest} request */
export async function verifiedPart(part, request = fetch) {
  if (
    !/^[\w-]{1,100}$/.test(part.id) ||
    !Number.isSafeInteger(part.size) ||
    part.size < 0 ||
    part.size > SINGLE_SIZE
  )
    throw Error("添付情報が不正");
  const response = await fileRequest("/api/files/" + part.id, {}, request);
  if (!response.ok) throw Error("添付を取得できない");
  // The server caps ciphertext size. Also bound browser-side reads, including malformed peers.
  const reader = response.body.getReader();
  const buffers = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > part.size + 16) throw Error("添付のサイズが一致しない");
      buffers.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  if (size !== part.size + 16) throw Error("添付のサイズが一致しない");
  const plain = await C.decryptFile(
    await new Blob(buffers).arrayBuffer(),
    part,
  );
  if (plain.byteLength !== part.size) throw Error("添付のサイズが一致しない");
  return plain;
}
/** @param {(bytes: number, total: number) => void} progress */
export async function streamDownload(file, progress = () => {}) {
  attachmentParts(file);
  if (!navigator.serviceWorker)
    throw Error("大容量ファイルの保存にはHTTPS接続が必要");
  const registration = await navigator.serviceWorker.register(
    "/download-worker.js",
    { type: "module", scope: "/" },
  );
  const worker =
    registration.installing ?? registration.waiting ?? registration.active;
  if (worker.state !== "activated")
    await new Promise((resolve, reject) => {
      worker.addEventListener("statechange", () => {
        if (worker.state === "activated") resolve();
        if (worker.state === "redundant") reject(Error("保存の準備に失敗した"));
      });
    });
  const token = crypto.randomUUID(),
    channel = new MessageChannel();
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.hidden = true;
    const timeout = setTimeout(
      () => finish(Error("保存の準備がタイムアウトした")),
      15000,
    );
    function finish(error) {
      clearTimeout(timeout);
      channel.port1.close();
      frame.remove();
      error ? reject(error) : resolve();
    }
    channel.port1.onmessage = ({ data }) => {
      if (data.type === "ready") {
        clearTimeout(timeout);
        frame.src = "/__oisiicord_download/" + token;
        document.body.append(frame);
      } else if (data.type === "progress") progress(data.bytes, file.size);
      else if (data.type === "done") finish();
      else if (data.type === "error") finish(Error(data.message));
    };
    worker.postMessage({ type: "download", token, file }, [channel.port2]);
  });
}
