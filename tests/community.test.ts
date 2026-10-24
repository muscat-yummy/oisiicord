import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createCommunity, COMMUNITY_SCHEMA } from "../src/community";
const opened: Database[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});
function setup() {
  const db = new Database(":memory:");
  opened.push(db);
  db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE users(id TEXT PRIMARY KEY);
 CREATE TABLE guilds(id TEXT PRIMARY KEY,owner TEXT,name TEXT);
 CREATE TABLE members(guild TEXT REFERENCES guilds(id),user TEXT REFERENCES users(id),role TEXT,PRIMARY KEY(guild,user));
 CREATE TABLE rooms(id TEXT PRIMARY KEY,guild TEXT REFERENCES guilds(id),kind TEXT,name TEXT);
 CREATE TABLE events(id TEXT PRIMARY KEY,room TEXT,author TEXT,envelope TEXT,created INTEGER);
 INSERT INTO users VALUES('alice'),('bob'),('mallory');
 INSERT INTO guilds VALUES('g','alice','Guild'),('other','mallory','Other');
 INSERT INTO members VALUES('g','alice','owner'),('g','bob','member'),('other','mallory','owner');
 INSERT INTO rooms VALUES('text','g','text','general'),('rules','g','rules','rules'),('ann','g','announcement','announcements'),('other-room','other','text','other');`);
  db.exec(COMMUNITY_SCHEMA);
  const one = (sql: string, ...args: any[]) =>
    db.query(sql).get(...args) as any;
  const all = (sql: string, ...args: any[]) =>
    db.query(sql).all(...args) as any[];
  const run = (sql: string, ...args: any[]) => db.query(sql).run(...args);
  const fail = (status: number, message: string): never => {
    throw Object.assign(Error(message), { status });
  };
  const module = createCommunity({
    db,
    one,
    all,
    run,
    json: (r) => r.json(),
    response: (v) => Response.json(v),
    fail,
    text: (v, max = 100) => {
      if (typeof v !== "string" || !v.trim() || v.length > max)
        return fail(400, "invalid");
      return v.trim();
    },
    changed: () => {},
    audit: () => {},
  });
  async function call(
    path: string,
    body: any = {},
    method = "POST",
    user = "alice",
  ) {
    try {
      const req = new Request("http://localhost/api/guilds/" + path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: method === "GET" ? undefined : JSON.stringify(body),
      });
      const r = await module.handle(req, new URL(req.url), user);
      return {
        status: r?.status ?? 404,
        data: r ? ((await r.json()) as any) : null,
      };
    } catch (e: any) {
      return { status: e.status ?? 500, data: { error: e.message } };
    }
  }
  return { db, module, one, all, run, call };
}
const image = {
  id: "fileid",
  key: Buffer.alloc(32, 1).toString("base64"),
  iv: Buffer.alloc(12, 2).toString("base64"),
  hash: Buffer.alloc(32, 3).toString("base64"),
  mime: "image/webp",
  size: 200,
};

test("role grants affect permissions, role ownership stays scoped and default role cannot escalate", async () => {
  const { module, call } = setup();
  expect(module.can("g", "bob", "manageChannels")).toBe(false);
  expect(module.can("g", "bob", "sendMessages")).toBe(true);
  const created = await call("g/roles", {
    name: "Moderator",
    permissions: ["manageChannels", "manageEmojis"],
    color: "#5865f2",
  });
  expect(created.status).toBe(200);
  const role = created.data.id;
  expect(
    (await call("g/memberroles/bob", { roles: [role] }, "PUT")).status,
  ).toBe(200);
  expect(module.can("g", "bob", "manageChannels")).toBe(true);
  expect(
    (
      await call(
        "g/roles",
        { name: "Escalation", permissions: ["administrator"] },
        "POST",
        "bob",
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await call(
        "other/memberroles/mallory",
        { roles: [role] },
        "PUT",
        "mallory",
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await call(
        "g/roles/everyone-g",
        { permissions: ["administrator"] },
        "PATCH",
      )
    ).status,
  ).toBe(400);
  expect((await call("g/roles/" + role, { position: 3 }, "PATCH")).status).toBe(
    200,
  );
  expect((await call("g/roles/" + role, {}, "DELETE")).status).toBe(200);
  expect(module.can("g", "bob", "manageChannels")).toBe(false);
  expect((await call("g/roles/everyone-g", {}, "DELETE")).status).toBe(400);
});

test("category edits are scoped, ordering works and deleting a category preserves its channels", async () => {
  const { module, call, one } = setup();
  const first = (await call("g/categories", { name: "Welcome" })).data.id,
    second = (await call("g/categories", { name: "Chat" })).data.id;
  expect(
    (
      await call(
        "g/channelmeta/text",
        { category: first, slowmode: 10 },
        "PATCH",
      )
    ).status,
  ).toBe(200);
  expect(module.decorateChannels("g", [{ id: "text" }])[0]).toMatchObject({
    category: first,
    slowmode: 10,
  });
  expect(
    (await call("g/categories/order", { ids: [second, first] }, "PUT")).status,
  ).toBe(200);
  expect(module.state("g", "alice").categories.map((c) => c.id)).toEqual([
    second,
    first,
  ]);
  expect(
    (await call("g/channelmeta/other-room", { category: first }, "PATCH"))
      .status,
  ).toBe(404);
  expect(
    (await call("g/channelmeta/text", { category: "not-a-category" }, "PATCH"))
      .status,
  ).toBe(400);
  expect((await call("g/categories/" + first, {}, "DELETE")).status).toBe(200);
  expect(one("SELECT id FROM rooms WHERE id='text'").id).toBe("text");
  expect(module.decorateChannels("g", [{ id: "text" }])[0].category).toBe(null);
});

test("rules consent is versioned, announcement posting is restricted and rule plaintext is absent", async () => {
  const { module, call, one, run } = setup();
  expect(
    (
      await call(
        "g/rules",
        { channel: "rules", requireAcceptance: true },
        "PATCH",
      )
    ).status,
  ).toBe(200);
  expect(module.state("g", "bob").rulesAccepted).toBe(false);
  expect(() =>
    module.assertCanPost({ id: "text", guild: "g", kind: "text" }, "bob"),
  ).toThrow("ルール");
  const version = module.state("g", "bob").rules.version;
  expect(
    (await call("g/rules/accept", { version }, "POST", "bob")).status,
  ).toBe(200);
  expect(module.canPost({ id: "text", guild: "g", kind: "text" }, "bob")).toBe(
    true,
  );
  expect(() =>
    module.assertCanPost(
      { id: "ann", guild: "g", kind: "announcement" },
      "bob",
    ),
  ).toThrow("投稿");
  expect(() =>
    module.assertCanPost(
      { id: "ann", guild: "g", kind: "announcement" },
      "bob",
      "reaction",
    ),
  ).not.toThrow();
  module.rulesChanged({ id: "rules", guild: "g" }, "message");
  expect(module.state("g", "bob").rulesAccepted).toBe(false);
  expect(
    (await call("g/rules/accept", { version }, "POST", "bob")).status,
  ).toBe(409);
  expect(
    Object.keys(one("SELECT * FROM community_rules WHERE guild='g'")),
  ).not.toContain("body");
  run("DELETE FROM rooms WHERE id='rules'");
  expect(module.state("g", "bob").rules.requireAcceptance).toBe(false);
  expect(module.state("g", "bob").rulesAccepted).toBe(true);
});

test("custom emoji names, encrypted descriptors and ownership are validated", async () => {
  const { call, module } = setup();
  expect(
    (await call("g/emojis", { name: "panda", image }, "POST", "bob")).status,
  ).toBe(403);
  const created = await call("g/emojis", { name: "panda", image });
  expect(created.status).toBe(200);
  expect(module.state("g", "bob").emojis[0].image).toMatchObject(image);
  expect((await call("g/emojis", { name: "PANDA", image })).status).toBe(409);
  expect((await call("g/emojis", { name: "x", image })).status).toBe(400);
  expect(
    (
      await call("g/emojis", {
        name: "bad",
        image: { ...image, mime: "image/svg+xml" },
      })
    ).status,
  ).toBe(400);
  expect(
    (await call("other/emojis/" + created.data.id, {}, "DELETE", "mallory"))
      .status,
  ).toBe(404);
  expect((await call("g/emojis/" + created.data.id, {}, "DELETE")).status).toBe(
    200,
  );
  expect(module.state("g", "alice").emojis).toEqual([]);
});

test("slowmode ignores reactions and quotas include all thirty memberships", async () => {
  const { module, call, run } = setup();
  await call("g/channelmeta/text", { slowmode: 30 }, "PATCH");
  run(
    "INSERT INTO events VALUES(?,?,?,?,?)",
    "old-message",
    "text",
    "bob",
    JSON.stringify({ header: { type: "message" } }),
    Date.now() - 60000,
  );
  run(
    "INSERT INTO events VALUES(?,?,?,?,?)",
    "new-reaction",
    "text",
    "bob",
    JSON.stringify({ header: { type: "reaction" } }),
    Date.now(),
  );
  expect(() =>
    module.assertCanPost({ id: "text", guild: "g", kind: "text" }, "bob"),
  ).not.toThrow();
  run(
    "INSERT INTO events VALUES(?,?,?,?,?)",
    "new-message",
    "text",
    "bob",
    JSON.stringify({ header: { type: "message" } }),
    Date.now(),
  );
  expect(() =>
    module.assertCanPost({ id: "text", guild: "g", kind: "text" }, "bob"),
  ).toThrow("スローモード");
  for (let i = 0; i < 29; i++) {
    run("INSERT INTO guilds VALUES(?,?,?)", "quota" + i, "alice", "Quota");
    run("INSERT INTO members VALUES(?,?,?)", "quota" + i, "bob", "member");
  }
  expect(() => module.ensureMembershipLimit("bob")).toThrow("30個");
});

test("non-object JSON is rejected and permissions are rechecked after JSON reads", async () => {
  const { module, call, db, one, all, run } = setup();
  expect((await call("g/categories", null)).status).toBe(400);
  expect((await call("g/roles", [])).status).toBe(400);
  const granted = (
    await call("g/roles", { name: "Manager", permissions: ["manageChannels"] })
  ).data.id;
  await call("g/memberroles/bob", { roles: [granted] }, "PUT");
  const race = createCommunity({
    db,
    one,
    all,
    run,
    json: async (req) => {
      const b = await req.json();
      run("DELETE FROM community_member_roles WHERE user='bob'");
      return b;
    },
    response: (v) => Response.json(v),
    fail: (status, message) => {
      throw Object.assign(Error(message), { status });
    },
    text: (v) => v,
    changed: () => {},
    audit: () => {},
  });
  const req = new Request("http://localhost/api/guilds/g/categories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Should fail" }),
  });
  await expect(race.handle(req, new URL(req.url), "bob")).rejects.toMatchObject(
    { status: 403 },
  );
  expect(one("SELECT COUNT(*) AS n FROM community_categories").n).toBe(0);
});
