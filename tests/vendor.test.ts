import { test, expect } from "bun:test";
import { resolve } from "node:path";
import { createVendor } from "../src/vendor";
test("sandbox renderer assets use the configured HTTPS origin behind an HTTP reverse proxy", async () => {
  const handler = createVendor(
    resolve(import.meta.dir, ".."),
    { "Content-Security-Policy": "style-src 'self'" },
    "https://chat.example",
  );
  const get = (path: string, method = "GET") => {
    const url = new URL(path, "http://127.0.0.1:3000");
    return handler(new Request(url.toString(), { method }), url);
  };
  const frame = (await get("/mermaid-frame.html"))!;
  expect(frame.headers.get("content-security-policy")).toContain(
    "script-src https://chat.example;",
  );
  expect(frame.headers.get("content-security-policy")).toContain(
    "connect-src 'none'",
  );
  const script = (await get("/mermaid-frame.js"))!;
  expect(script.headers.get("access-control-allow-origin")).toBe("*");
  expect(script.headers.get("content-security-policy")).toBe(
    "style-src 'self'",
  );
  expect(await get("/api/state")).toBeUndefined();
  expect(
    await get("/vendor/mermaid/../../settings/secrets.json"),
  ).toBeUndefined();
  expect((await get("/diagram-view.html", "POST"))!.status).toBe(405);
  expect(await (await get("/diagram-view.html", "HEAD"))!.text()).toBe("");
});
