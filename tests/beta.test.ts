import { test, expect } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBetaSettings, matchesBetaCode } from "../src/beta";
import { createApp } from "../src/server";
import * as C from "../public/crypto.js";

test("beta defaults, exact codes, live settings, invalid configuration and existing file preservation", () => {
  const dir = mkdtempSync(join(tmpdir(), "oisiicord-beta-")),
    path = join(dir, "beta.json");
  try {
    const read = createBetaSettings(dir);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      beta_mode: false,
      code: "",
    });
    const code = crypto.randomUUID();
    for (const [beta_mode, value, required] of [
      [false, code, false],
      [true, "", false],
      [true, code, true],
    ] as const) {
      writeFileSync(path, JSON.stringify({ beta_mode, code: value }));
      expect(read().required).toBe(required);
    }
    const bomCode = " 日本語-" + code + " ";
    const json = JSON.stringify({ beta_mode: true, code: bomCode });
    const le = Buffer.from("\ufeff" + json, "utf16le");
    const be = Buffer.from(le);
    be.swap16();
    for (const data of [Buffer.from("\ufeff" + json, "utf8"), le, be]) {
      writeFileSync(path, data);
      expect(read()).toEqual({ required: true, code: bomCode });
      expect(readFileSync(path)).toEqual(data);
    }
    writeFileSync(path, JSON.stringify({ beta_mode: true, code }));
    createBetaSettings(dir);
    expect(read().code).toBe(code);
    expect(matchesBetaCode(code, code)).toBe(true);
    for (const invalid of [undefined, null, {}, code.toUpperCase(), code + " "])
      expect(matchesBetaCode(code, invalid)).toBe(false);
    for (const value of [
      "{",
      '{"beta_mode":"true","code":"abc"}',
      '{"beta_mode":true,"code":123}',
    ]) {
      writeFileSync(path, value);
      expect(read).toThrow();
    }
    unlinkSync(path);
    symlinkSync(join(dir, "missing"), path);
    expect(read).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registration enforces beta codes through the API without exposing them or blocking login", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oisiicord-beta-api-")),
    path = join(dir, "beta.json");
  const app = createApp({
    path: ":memory:",
    port: 0,
    origin: "http://localhost:31991",
    settingsDirectory: dir,
  });
  const base = "http://127.0.0.1:" + app.server.port;
  async function request(route: string, body?: unknown) {
    return fetch(base + route, {
      method: body === undefined ? "GET" : "POST",
      headers: { Origin: app.origin, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  try {
    const code = crypto.randomUUID();
    writeFileSync(path, "\ufeff" + JSON.stringify({ beta_mode: true, code }));
    const policy = await request("/api/auth/registration");
    expect(await policy.json()).toEqual({ inviteRequired: true });
    expect(policy.headers.get("cache-control")).toBe("no-store");
    expect((await request("/settings/beta.json")).status).toBe(404);
    expect((await request("/api/auth/register", {})).status).toBe(403);
    expect(
      (await request("/api/auth/register", { inviteCode: crypto.randomUUID() }))
        .status,
    ).toBe(403);
    const keys = await C.identity(),
      id = crypto.randomUUID(),
      username = "beta_person",
      auth = C.b64(C.random(32)),
      identity = await C.importIdentity(keys.privateKeys, keys.keys);
    const payload = {
      id,
      username,
      display: username,
      salt: C.b64(C.random(32)),
      auth,
      keys: keys.keys,
      vault: await C.lock(C.random(32), C.bytes("fixture"), "fixture"),
      proof: await C.sign({ id, username, keys: keys.keys }, identity),
    };
    const registered = await request("/api/auth/register", {
      ...payload,
      inviteCode: code,
    });
    expect(registered.status).toBe(200);
    writeFileSync(path, '{"beta_mode":true,"code":"' + code + '",}');
    const failed = await request("/api/auth/registration");
    expect(failed.status).toBe(503);
    const diagnostic = await failed.text();
    expect(diagnostic).toContain("JSON形式");
    expect(diagnostic).not.toContain(code);
    expect((await request("/api/auth/register", payload)).status).toBe(503);
    expect((await request("/api/auth/login", { username, auth })).status).toBe(
      200,
    );
    writeFileSync(path, JSON.stringify({ beta_mode: true, code: "" }));
    expect(await (await request("/api/auth/registration")).json()).toEqual({
      inviteRequired: false,
    });
    const second = "beta_second";
    expect(
      (
        await request("/api/auth/register", {
          ...payload,
          id: crypto.randomUUID(),
          username: second,
        })
      ).status,
    ).toBe(400); // Gate is open; invalid identity proof is still rejected.
  } finally {
    app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
