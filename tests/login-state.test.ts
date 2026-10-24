import { test, expect } from "bun:test";
import { createApp } from "../src/server";
import * as C from "../public/crypto.js";
test("remembered login metadata requires a live cookie and exposes no authentication secret", async () => {
  const app = createApp({
    path: ":memory:",
    port: 0,
    origin: "http://localhost:31992",
  });
  const base = "http://127.0.0.1:" + app.server.port;
  const request = (path: string, cookie = "", body?: any) =>
    fetch(base + "/api" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Origin: app.origin,
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    const keys = await C.identity(),
      id = crypto.randomUUID(),
      username = "remembered_test",
      salt = C.b64(C.random(32)),
      auth = C.b64(C.random(32));
    const identity = await C.importIdentity(keys.privateKeys, keys.keys),
      vault = await C.encryptVault(keys.privateKeys, C.random(32), username);
    const registration = await request("/auth/register", "", {
      id,
      username,
      display: "Panda",
      salt,
      auth,
      keys: keys.keys,
      vault,
      proof: await C.sign({ id, username, keys: keys.keys }, identity),
    });
    expect(registration.status).toBe(200);
    const cookie = registration.headers.get("set-cookie")!.split(";")[0],
      registered = (await registration.json()) as any;
    expect(cookie).toContain("oisiicord=");
    expect(registration.headers.get("set-cookie")).toContain("HttpOnly");
    expect((await request("/auth/session")).status).toBe(401);
    const response = await request("/auth/session", cookie),
      restored = (await response.json()) as any;
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(restored).toEqual(registered);
    expect(restored.user.id).toBe(id);
    expect(restored.salt).toBe(salt);
    expect(restored.vault).toEqual(vault);
    expect(restored.session.expires).toBeGreaterThan(Date.now());
    expect(restored.session.id).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(restored)).not.toContain(auth);
    expect(JSON.stringify(restored)).not.toContain(keys.privateKeys.sign);
    expect(JSON.stringify(restored)).not.toContain(keys.privateKeys.exchange);
    expect(
      (await request("/auth/session", "oisiicord=" + restored.session.id))
        .status,
    ).toBe(401);
    app.db
      .query("UPDATE sessions SET expires=? WHERE user=?")
      .run(Date.now() - 1, id);
    expect((await request("/auth/session", cookie)).status).toBe(401);
    const login = await request("/auth/login", "", { username, auth });
    const nextCookie = login.headers.get("set-cookie")!.split(";")[0];
    const next = (await login.json()) as any;
    expect(next.session.id).not.toBe(restored.session.id);
    expect((await request("/auth/logout", nextCookie, {})).status).toBe(200);
    expect((await request("/auth/session", nextCookie)).status).toBe(401);
  } finally {
    app.stop();
  }
});
