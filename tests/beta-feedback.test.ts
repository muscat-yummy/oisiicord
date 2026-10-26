import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { RateLimiter } from "../src/rate-limit";
import * as C from "../public/crypto.js";
import * as M from "../public/membership.js";

test("token buckets return an accurate retry time, refill and bound attacker keys", () => {
  let now = 0;
  const rate = new RateLimiter(() => now, 2);
  expect(rate.consume("a", 2, 10000)).toBe(0);
  expect(rate.consume("a", 2, 10000)).toBe(0);
  expect(rate.consume("a", 2, 10000)).toBe(5);
  now = 2500;
  expect(rate.consume("a", 2, 10000)).toBe(3);
  now = 5000;
  expect(rate.consume("a", 2, 10000)).toBe(0);
  expect(rate.consume("b", 2, 10000)).toBe(0);
  expect(rate.consume("c", 2, 10000)).toBe(10);
  now = 20000;
  rate.prune();
  expect(rate.consume("c", 2, 10000)).toBe(0);
});

function fixture(paymentFetch?: typeof fetch, fileOrigin?: string) {
  const dir = mkdtempSync(join(tmpdir(), "oisiicord-feedback-"));
  const app = createApp({
    path: ":memory:",
    port: 0,
    origin: "http://localhost:31981",
    settingsDirectory: dir,
    paymentFetch,
    fileOrigin,
    allowLocalPaymentProvider: true,
  });
  const base = "http://127.0.0.1:" + app.server.port;
  async function api(
    person: any,
    path: string,
    body?: any,
    method = body === undefined ? "GET" : "POST",
  ) {
    const r = await fetch(base + "/api" + path, {
      method,
      headers: {
        Origin: app.origin,
        ...(person ? { Cookie: person.cookie } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: r.status,
      headers: r.headers,
      body: (await r.json()) as any,
      cookie: r.headers.get("set-cookie")?.split(";")[0],
    };
  }
  async function register(username: string) {
    const keys = await C.identity(),
      id = crypto.randomUUID(),
      identity = {
        ...(await C.importIdentity(keys.privateKeys, keys.keys)),
        id,
      };
    const r = await api(null, "/auth/register", {
      id,
      username,
      display: username,
      salt: C.b64(C.random(32)),
      auth: C.b64(C.random(32)),
      keys: keys.keys,
      vault: await C.lock(C.random(32), C.bytes("fixture"), "fixture"),
      proof: await C.sign({ id, username, keys: keys.keys }, identity),
    });
    expect(r.status).toBe(200);
    return { ...identity, cookie: r.cookie };
  }
  async function guild(owner: any) {
    const id = crypto.randomUUID(),
      roster = {
        guild: id,
        owner: owner.id,
        version: 1,
        members: [{ id: owner.id, keys: owner.keys, role: "owner" }],
      };
    const r = await api(owner, "/guilds", {
      id,
      name: "test",
      roster,
      signature: await C.sign(roster, owner),
    });
    expect(r.status).toBe(200);
    return id;
  }
  return {
    app,
    dir,
    base,
    api,
    register,
    guild,
    close() {
      app.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("rate-limited API returns HTTP429 and Retry-After", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 30; i++)
      expect((await f.api(null, "/auth/salt?username=test")).status).toBe(200);
    const denied = await f.api(null, "/auth/salt?username=test");
    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(denied.body.retryAfter).toBe(
      Number(denied.headers.get("retry-after")),
    );
  } finally {
    f.close();
  }
});

test("public aliases are signed, unique, free, approval-free and exchange history keys only between members", async () => {
  const f = fixture();
  try {
    const owner = await f.register("alias_owner"),
      member = await f.register("alias_member"),
      outsider = await f.register("alias_outsider");
    const gid = await f.guild(owner),
      inv = await M.createGrant(
        {
          guild: gid,
          owner: owner.id,
          baseVersion: 1,
          publicAlias: "test-link",
          approval: false,
          history: [],
        },
        owner,
      );
    const { secret, ...published } = inv;
    expect(
      (await f.api(owner, "/guilds/" + gid + "/invitations", published)).status,
    ).toBe(200);
    const resolved = await f.api(null, "/invite-aliases/test-link");
    expect(resolved.body).toEqual({
      id: inv.grant.id,
      publicAlias: "test-link",
    });
    expect(JSON.stringify(resolved.body)).not.toContain(secret);
    expect(
      (await fetch(f.base + "/test-link")).headers.get("content-type"),
    ).toContain("text/html");
    const joined = await f.api(
      member,
      "/invitations/" + inv.grant.id + "/join",
      await M.admit(inv, undefined, member),
    );
    expect(joined.status).toBe(200);
    expect(joined.body.approval).toBe(false);
    const credential = await M.createCredential(inv, secret, owner),
      read = await M.readCredential(credential, owner),
      shared = await M.shareCredential(
        read,
        { id: member.id, keys: member.keys },
        owner,
      );
    expect(
      (
        await f.api(owner, "/guilds/" + gid + "/history-credentials", {
          invite: inv.grant.id,
          target: member.id,
          envelope: shared,
        })
      ).status,
    ).toBe(200);
    const received = await f.api(
      member,
      "/guilds/" + gid + "/history-credentials",
    );
    expect(
      (await M.readCredential(received.body[0], member, owner.keys, owner.keys))
        .secret,
    ).toBe(secret);
    const invalidOwner = await M.shareCredential(
      { ...read, grantSignature: C.b64(C.random(64)) },
      { id: member.id, keys: member.keys },
      owner,
    );
    await expect(
      M.readCredential(invalidOwner, member, owner.keys, owner.keys),
    ).rejects.toThrow("招待署名");
    const invalidSnapshot = await M.shareCredential(
      { ...read, snapshot: { ...inv.snapshot, iv: C.b64(C.random(12)) } },
      { id: member.id, keys: member.keys },
      owner,
    );
    await expect(
      M.readCredential(invalidSnapshot, member, owner.keys, owner.keys),
    ).rejects.toThrow("内容が一致");
    // A peer delivery cannot replace a private credential already saved by its recipient.
    const own = await M.shareCredential(
      await M.readCredential(shared, member, owner.keys, owner.keys),
      { id: member.id, keys: member.keys },
      member,
    );
    expect(
      (
        await f.api(member, "/guilds/" + gid + "/history-credentials", {
          invite: inv.grant.id,
          envelope: own,
        })
      ).status,
    ).toBe(200);
    const privateCopy = f.app.db
      .query(
        "SELECT envelope FROM history_credentials WHERE guild=? AND user=? AND invite=?",
      )
      .get(gid, member.id, inv.grant.id) as any;
    expect(JSON.parse(privateCopy.envelope).header.author).toBe(member.id);
    expect(
      (
        await f.api(owner, "/guilds/" + gid + "/history-credentials", {
          invite: inv.grant.id,
          target: outsider.id,
          envelope: shared,
        })
      ).status,
    ).toBe(403);
    const malicious = structuredClone(inv);
    malicious.grant.publicAlias = "different";
    expect(
      await M.verifyGrant(malicious.grant, malicious.signature, owner.keys),
    ).toBe(false);
    const gid2 = await f.guild(outsider),
      duplicate = await M.createGrant(
        {
          guild: gid2,
          owner: outsider.id,
          baseVersion: 1,
          publicAlias: "test-link",
          history: [],
        },
        outsider,
      );
    const { secret: unused, ...body } = duplicate;
    expect(
      (await f.api(outsider, "/guilds/" + gid2 + "/invitations", body)).status,
    ).toBe(409);
    expect(
      (
        await f.api(
          owner,
          "/guilds/" + gid + "/invitations/" + inv.grant.id,
          {},
          "DELETE",
        )
      ).status,
    ).toBe(200);
    expect((await f.api(null, "/invite-aliases/test-link")).status).toBe(403);
  } finally {
    f.close();
  }
});

test("LTC orders verify invoice ownership, exact amount, method and settlement before granting once", async () => {
  const invoices = new Map<string, any>();
  let mode = "Processing",
    wrong = false,
    method = "LTC-CHAIN";
  const provider = (async (input: any, init: any) => {
    const url = new URL(String(input));
    if (init.method === "POST") {
      const b = JSON.parse(init.body),
        id = crypto.randomUUID();
      invoices.set(id, {
        ...b,
        id,
        checkoutLink: "http://127.0.0.1/checkout/" + id,
      });
      return Response.json(invoices.get(id));
    }
    const parts = url.pathname.split("/"),
      id = parts.at(-1) === "payment-methods" ? parts.at(-2) : parts.at(-1),
      invoice = invoices.get(id!);
    if (parts.at(-1) === "payment-methods")
      return Response.json([
        { paymentMethodId: method, totalPaid: Number(invoice.amount), due: 0 },
      ]);
    return Response.json({
      ...invoice,
      status: mode,
      amount: wrong ? "9" : Number(invoice.amount),
    });
  }) as typeof fetch;
  const f = fixture(provider);
  try {
    const alice = await f.register("store_alice"),
      bob = await f.register("store_bob"),
      gid = await f.guild(alice);
    expect((await f.api(alice, "/store")).body.enabled).toBe(false);
    writeFileSync(
      join(f.dir, "store.json"),
      JSON.stringify({
        enabled: true,
        btcpay_url: "http://127.0.0.1",
        store_id: "store",
        api_key: crypto.randomUUID(),
        plus_ltc: "0.01",
        boost_ltc: "0.00000001",
        boost_days: 30,
      }),
    );
    expect(
      (await f.api(alice, "/file-transfers", { size: 1024 * 1024 * 1024 }))
        .status,
    ).toBe(200);
    expect(
      (await f.api(alice, "/file-transfers", { size: 1024 * 1024 * 1024 + 1 }))
        .status,
    ).toBe(400);
    const order = await f.api(alice, "/store/orders", { product: "plus" });
    expect(order.status).toBe(200);
    expect(order.body.status).toBe("New");
    expect((await f.api(bob, "/store/orders/" + order.body.id)).status).toBe(
      404,
    );
    expect(
      (await f.api(alice, "/store/orders/" + order.body.id)).body.granted,
    ).toBeNull();
    const repeated = await f.api(alice, "/store/orders", { product: "plus" });
    expect(repeated.body.id).toBe(order.body.id);
    expect(invoices.size).toBe(1);
    mode = "Settled";
    wrong = true;
    expect((await f.api(alice, "/store/orders/" + order.body.id)).status).toBe(
      502,
    );
    wrong = false;
    method = "BTC-CHAIN";
    expect((await f.api(alice, "/store/orders/" + order.body.id)).status).toBe(
      409,
    );
    method = "LTC-CHAIN";
    expect(
      (await f.api(alice, "/store/orders/" + order.body.id)).body.granted,
    ).toBeGreaterThan(0);
    expect((await f.api(alice, "/state")).body.benefits).toEqual({
      plus: true,
      guildLimit: 100,
      globalEmojis: true,
      maxFileSize: 2048 * 1024 * 1024,
    });
    expect(
      (await f.api(alice, "/store/orders/" + order.body.id)).body.status,
    ).toBe("Settled");
    expect(
      (await f.api(alice, "/file-transfers", { size: 2048 * 1024 * 1024 }))
        .status,
    ).toBe(200);
    expect(
      (await f.api(alice, "/file-transfers", { size: 2048 * 1024 * 1024 + 1 }))
        .status,
    ).toBe(400);
    const boost = await f.api(alice, "/store/orders", {
      product: "boost",
      guild: gid,
    });
    expect(boost.status).toBe(200);
    expect(
      (await f.api(alice, "/store/orders/" + boost.body.id)).body.status,
    ).toBe("Settled");
    const before = (await f.api(alice, "/state")).body.guilds[0];
    expect(before.boosted).toBe(true);
    expect(before.emojiLimit).toBe(300);
    await f.api(alice, "/store/orders/" + boost.body.id);
    expect((await f.api(alice, "/state")).body.guilds[0].boostExpires).toBe(
      before.boostExpires,
    );
    expect(JSON.stringify((await f.api(alice, "/store")).body)).not.toContain(
      "api_key",
    );
  } finally {
    f.close();
  }
});

test("version four migration retains accounts and backs up before creating store and alias tables", async () => {
  const { Database } = await import("bun:sqlite"),
    { database, SCHEMA_VERSION } = await import("../src/db"),
    { readdirSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "oisiicord-v4-")),
    path = join(dir, "chat.sqlite");
  try {
    const old = new Database(path);
    old.exec(
      "CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,display TEXT NOT NULL,salt TEXT NOT NULL,auth TEXT NOT NULL,vault TEXT NOT NULL,keys TEXT NOT NULL,created INTEGER NOT NULL);INSERT INTO users VALUES('retained','retained','Retained','','','{}','{}',1);PRAGMA user_version=3",
    );
    old.close();
    const db = database(path, join(dir, "backups"));
    expect((db.query("SELECT username FROM users").get() as any).username).toBe(
      "retained",
    );
    expect((db.query("PRAGMA user_version").get() as any).user_version).toBe(
      SCHEMA_VERSION,
    );
    for (const name of [
      "store_orders",
      "public_invite_aliases",
      "history_deliveries",
    ])
      expect(
        db.query("SELECT name FROM sqlite_master WHERE name=?").get(name),
      ).not.toBeNull();
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
    expect(readdirSync(join(dir, "backups")).length).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("attachment concurrency rejects excess requests and releases slots after a provider failure", async () => {
  let entered = 0;
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const provider = Bun.serve({
    port: 0,
    async fetch(req) {
      await req.arrayBuffer();
      entered++;
      if (entered <= 2) {
        await gate;
        return new Response(null, { status: 503 });
      }
      return Response.json({
        Status: "OK",
        FileID: "after_failure",
        RemovePassword: "cleanup",
      });
    },
  });
  const f = fixture(undefined, "http://127.0.0.1:" + provider.port);
  try {
    const account = await f.register("transfer_limits");
    const post = () =>
      fetch(f.base + "/api/files", {
        method: "POST",
        headers: {
          Origin: f.app.origin,
          Cookie: account.cookie!,
          "Content-Type": "application/octet-stream",
        },
        body: new Uint8Array(17),
      });
    const first = post(),
      second = post();
    for (let i = 0; entered < 2 && i < 100; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(entered).toBe(2);
    const denied = await post();
    expect(denied.status).toBe(429);
    expect(denied.headers.get("Retry-After")).toBe("2");
    unblock();
    expect((await first).status).toBe(502);
    expect((await second).status).toBe(502);
    expect((await post()).status).toBe(200);
  } finally {
    unblock();
    f.close();
    provider.stop(true);
  }
});
