import { test, expect } from "bun:test";
import { createFileAdapter, MAX_ENCRYPTED_FILE } from "../src/file-adapter";
test("file adapter requires provider success, keeps opaque bytes and rejects redirects and oversized responses", async () => {
  let mode = "normal";
  const bytes = crypto.getRandomValues(new Uint8Array(64));
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      if (mode === "redirect")
        return new Response(null, {
          status: 302,
          headers: { Location: "https://example.com/" },
        });
      if (u.pathname === "/upload") {
        const f = (await req.formData()).get("file") as File;
        expect(f.name.endsWith(".enc")).toBe(true);
        expect(new Uint8Array(await f.arrayBuffer())).toEqual(bytes);
        return Response.json(
          mode === "bad"
            ? { Status: "ERROR" }
            : {
                Status: "OK",
                FileID: "fixture-id",
                RemovePassword: "fixture-delete",
              },
        );
      }
      if (u.pathname === "/delete")
        return Response.json(
          mode === "bad" ? { Error: "failed" } : { Status: "OK" },
        );
      if (mode === "large")
        return new Response(new Uint8Array(MAX_ENCRYPTED_FILE + 1));
      return new Response(bytes);
    },
  });
  try {
    const files = createFileAdapter("http://127.0.0.1:" + server.port);
    expect((await files.upload(bytes)).id).toBe("fixture-id");
    expect(await files.download("fixture-id")).toEqual(bytes);
    await files.remove("fixture-id", "fixture-delete");
    mode = "bad";
    await expect(files.upload(bytes)).rejects.toThrow();
    await expect(
      files.remove("fixture-id", "fixture-delete"),
    ).rejects.toThrow();
    mode = "redirect";
    await expect(files.download("fixture-id")).rejects.toThrow();
    mode = "large";
    await expect(files.download("fixture-id")).rejects.toThrow();
    expect(() => createFileAdapter("https://example.com")).toThrow();
  } finally {
    server.stop(true);
  }
});
