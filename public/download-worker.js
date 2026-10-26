import { attachmentParts, verifiedPart } from "./attachments.js";
const jobs = new Map();
self.addEventListener("install", (event) =>
  event.waitUntil(self.skipWaiting()),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);
self.addEventListener("message", (event) => {
  const { type, token, file } = event.data ?? {};
  const port = event.ports[0];
  if (
    type !== "download" ||
    !port ||
    !/^[a-f0-9-]{36}$/.test(token) ||
    !event.source?.url ||
    new URL(event.source.url).origin !== self.location.origin
  )
    return;
  try {
    if (jobs.size >= 4) throw Error("保存中のファイルが多すぎる");
    const parts = attachmentParts(file);
    if (file.v !== 2) throw Error("添付情報が不正");
    const timer = setTimeout(() => {
      jobs.delete(token);
      port.postMessage({ type: "error", message: "保存を開始できない" });
      port.close();
    }, 30000);
    jobs.set(token, { file, parts, port, timer });
    port.postMessage({ type: "ready" });
  } catch (error) {
    port.postMessage({ type: "error", message: error.message });
    port.close();
  }
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    url.origin !== self.location.origin ||
    !url.pathname.startsWith("/__oisiicord_download/")
  )
    return;
  event.respondWith(
    (async () => {
      const token = url.pathname.split("/").at(-1),
        job = jobs.get(token);
      if (!job) return new Response("保存の準備が必要", { status: 404 });
      jobs.delete(token);
      clearTimeout(job.timer);
      const { file, parts, port } = job;
      let index = 0,
        bytes = 0;
      let done;
      const completed = new Promise((resolve) => {
        done = resolve;
      });
      event.waitUntil(completed);
      const stop = (message) => {
        port.postMessage({ type: "error", message });
        port.close();
        done();
      };
      const stream = new ReadableStream(
        {
          async pull(controller) {
            try {
              const plain = await verifiedPart(parts[index++]);
              bytes += plain.byteLength;
              controller.enqueue(new Uint8Array(plain));
              port.postMessage({ type: "progress", bytes });
              if (index === parts.length) {
                controller.close();
                port.postMessage({ type: "done" });
                port.close();
                done();
              }
            } catch (error) {
              controller.error(error);
              stop(error.message);
            }
          },
          cancel() {
            stop("保存を中止した");
          },
        },
        { highWaterMark: 0 },
      );
      const filename = String(file.name ?? "download")
        .replace(/[\\/\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, "_")
        .slice(0, 200);
      return new Response(stream, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(file.size),
          "Content-Disposition":
            "attachment; filename*=UTF-8''" +
            encodeURIComponent(
              new TextDecoder().decode(new TextEncoder().encode(filename)),
            ).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16)),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    })(),
  );
});
