import { test, expect } from "bun:test";
import { createApp } from "../src/server";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("configured public URL is canonicalized while foreign, missing and spoofed origins stay blocked", async () => {
  const directory = mkdtempSync(join(tmpdir(), "oisiicord-origin-"));
  const app = createApp({
    path: ":memory:",
    port: 0,
    origin: "https://CHAT.Example.com:443/",
    settingsDirectory: directory,
  });
  const base = "http://127.0.0.1:" + app.server.port;
  const request = (origin: string | null, extra: Record<string, string> = {}) =>
    fetch(base + "/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(origin === null ? {} : { Origin: origin }),
        ...extra,
      },
      body: JSON.stringify({
        username: "missing_account",
        auth: "not_a_credential",
      }),
    });
  try {
    expect(app.origin).toBe("https://chat.example.com");
    expect((await request(app.origin)).status).toBe(401);
    for (const origin of [
      null,
      "null",
      "https://evil.example",
      "https://chat.example.com.evil.example",
      "http://chat.example.com",
      "https://chat.example.com:444",
    ])
      expect((await request(origin)).status).toBe(403);
    expect(
      (
        await request("https://evil.example", {
          "X-Forwarded-Host": "evil.example",
          "X-Forwarded-Proto": "https",
          Forwarded: "host=evil.example;proto=https",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(base + "/ws", {
          headers: { Origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    expect((await fetch(base + "/api/health")).status).toBe(200);
  } finally {
    app.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
