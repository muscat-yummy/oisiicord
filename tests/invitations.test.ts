import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as C from "../public/crypto.js";
import * as M from "../public/membership.js";
import { createInvitations, INVITATION_SCHEMA } from "../src/invitations";

async function fixture() {
  const db = new Database(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,keys TEXT NOT NULL,display TEXT NOT NULL);
    CREATE TABLE guilds(id TEXT PRIMARY KEY,owner TEXT NOT NULL,name TEXT NOT NULL,roster TEXT NOT NULL,signature TEXT NOT NULL,version INTEGER NOT NULL);
    CREATE TABLE members(guild TEXT REFERENCES guilds(id),user TEXT REFERENCES users(id),role TEXT NOT NULL,PRIMARY KEY(guild,user));
    CREATE TABLE requests(guild TEXT REFERENCES guilds(id),user TEXT REFERENCES users(id),PRIMARY KEY(guild,user));
    CREATE TABLE rosters(guild TEXT REFERENCES guilds(id),version INTEGER NOT NULL,roster TEXT NOT NULL,signature TEXT NOT NULL,PRIMARY KEY(guild,version));`);
  db.exec(INVITATION_SCHEMA);
  const people: Record<string, any> = {};
  for (const id of ["owner", "newcomer", "other"]) {
    const identity = await C.identity();
    people[id] = {
      ...(await C.importIdentity(identity.privateKeys, identity.keys)),
      id,
      display: id,
    };
    db.query("INSERT INTO users VALUES(?,?,?)").run(
      id,
      JSON.stringify(identity.keys),
      id,
    );
  }
  const owner = people.owner;
  const baseRoster = {
    guild: "guild",
    owner: owner.id,
    version: 1,
    members: [{ id: owner.id, keys: owner.keys, role: "owner" }],
  };
  const signature = await C.sign(baseRoster, owner);
  db.query("INSERT INTO guilds VALUES(?,?,?,?,?,?)").run(
    "guild",
    owner.id,
    "Friends",
    JSON.stringify(baseRoster),
    signature,
    1,
  );
  db.query("INSERT INTO members VALUES(?,?,?)").run("guild", owner.id, "owner");
  db.query("INSERT INTO rosters VALUES(?,?,?,?)").run(
    "guild",
    1,
    JSON.stringify(baseRoster),
    signature,
  );
  const one = (sql: string, ...args: any[]) =>
    db.query(sql).get(...args) as any;
  const all = (sql: string, ...args: any[]) =>
    db.query(sql).all(...args) as any[];
  const run = (sql: string, ...args: any[]) => db.query(sql).run(...args);
  const module = createInvitations({
    db,
    one,
    all,
    run,
    json: async (req) => await req.json(),
    response: (value, status = 200) => Response.json(value, { status }),
    fail: (status, message): never => {
      throw Object.assign(Error(message), { status });
    },
    changed: () => {},
    audit: () => {},
    user: (uid) => ({
      id: uid,
      keys: JSON.parse(one("SELECT keys FROM users WHERE id=?", uid).keys),
      display: uid,
    }),
  });
  async function request(
    uid: string,
    path: string,
    body?: any,
    method?: string,
  ) {
    try {
      const url = new URL("http://localhost/api" + path);
      const req = new Request(url.toString(), {
        method: method ?? (body === undefined ? "GET" : "POST"),
        ...(body === undefined
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }),
      });
      const response = await module.handle(req, url, uid);
      if (!response) throw Error("No handler");
      return { status: response.status, body: (await response.json()) as any };
    } catch (error: any) {
      return { status: error.status ?? 500, body: { error: error.message } };
    }
  }
  async function publish(options: any = {}) {
    const created = await M.createGrant(
      { guild: "guild", owner: owner.id, baseVersion: 1, ...options },
      owner,
    );
    const { secret, ...body } = created;
    const result = await request(owner.id, "/guilds/guild/invitations", body);
    expect(result.status).toBe(200);
    const invite = (
      await request("newcomer", "/invitations/" + created.grant.id)
    ).body;
    return { created, invite };
  }
  return { db, people, module, request, publish, baseRoster, one, run };
}

test("short automatic invitations transfer original and later offline history without server plaintext", async () => {
  const f = await fixture();
  try {
    const owner = f.people.owner,
      newcomer = f.people.newcomer;
    const old = await C.seal(
      { type: "message", text: "before-invite-confidential", files: [] },
      {
        room: "room",
        author: owner.id,
        recipients: f.baseRoster.members,
        identity: owner,
        version: 1,
      },
    );
    const history = await M.buildHistory(
      [{ envelope: old, authorUser: owner }],
      owner,
    );
    const { created, invite } = await f.publish({ history });
    expect((created.grant.id + "." + created.secret).length).toBe(60);
    expect(created.grant.approval).toBe(false);
    const later = await C.seal(
      { type: "message", text: "after-invite-confidential", files: [] },
      {
        room: "room",
        author: owner.id,
        recipients: f.baseRoster.members,
        identity: owner,
        version: 1,
        historyWrap: (key: any, ephemeral: any, context: any) =>
          M.wrapHistoryKeys(
            key,
            ephemeral,
            context,
            [{ grant: created.grant, signature: created.signature }],
            owner.keys,
          ),
      },
    );
    const proof = await M.admit(invite, created.secret, newcomer);
    expect(
      (
        await f.request(
          newcomer.id,
          "/invitations/" + created.grant.id + "/join",
          proof,
        )
      ).body.approval,
    ).toBe(false);
    const effective = await M.validateCertificate(
      f.module.certificate("guild"),
      owner.keys,
    );
    expect(effective.members.map((m: any) => m.id)).toEqual([
      owner.id,
      newcomer.id,
    ]);
    expect(effective.version).toBe(2);
    const credential = await M.createCredential(
      invite,
      created.secret,
      newcomer,
    );
    expect(
      (
        await f.request(newcomer.id, "/guilds/guild/history-credentials", {
          invite: created.grant.id,
          envelope: credential,
        })
      ).status,
    ).toBe(200);
    const stored = (
      await f.request(newcomer.id, "/guilds/guild/history-credentials")
    ).body;
    const reopened = await M.readCredential(stored[0], newcomer);
    expect(
      await M.openEvent(old, newcomer, owner.keys, "room", [reopened]),
    ).toMatchObject({ text: "before-invite-confidential" });
    expect(
      await M.openEvent(later, newcomer, owner.keys, "room", [reopened]),
    ).toMatchObject({ text: "after-invite-confidential" });
    const visible =
      JSON.stringify(f.db.query("SELECT * FROM invitation_grants").all()) +
      JSON.stringify(f.db.query("SELECT * FROM history_credentials").all());
    expect(visible).not.toContain(created.secret);
    expect(visible).not.toContain("before-invite-confidential");
    expect(visible).not.toContain(history[0].key);
    const altered = structuredClone(later) as any;
    altered.historyBoxes[created.grant.id].ct = C.b64(C.random(64));
    await expect(
      M.openEvent(altered, newcomer, owner.keys, "room", [reopened]),
    ).rejects.toThrow();
  } finally {
    f.db.close();
  }
});

test("admissions bind identity, consume unique joins once, and reject exhausted or revoked invitations", async () => {
  const f = await fixture();
  try {
    const { created, invite } = await f.publish({ maxUses: 1 });
    const proof = await M.admit(invite, created.secret, f.people.newcomer);
    expect(
      (
        await f.request(
          "other",
          "/invitations/" + created.grant.id + "/join",
          proof,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await f.request(
          "newcomer",
          "/invitations/" + created.grant.id + "/join",
          proof,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await f.request(
          "newcomer",
          "/invitations/" + created.grant.id + "/join",
          proof,
        )
      ).body.already,
    ).toBe(true);
    expect(
      f.one("SELECT uses FROM invitation_grants WHERE id=?", created.grant.id)
        .uses,
    ).toBe(1);
    const other = await M.admit(invite, created.secret, f.people.other);
    expect(
      (
        await f.request(
          "other",
          "/invitations/" + created.grant.id + "/join",
          other,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await f.request(
          "newcomer",
          "/guilds/guild/invitations/" + created.grant.id,
          undefined,
          "DELETE",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await f.request(
          "owner",
          "/guilds/guild/invitations/" + created.grant.id,
          undefined,
          "DELETE",
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await f.request(
          "other",
          "/invitations/" + created.grant.id + "/join",
          other,
        )
      ).status,
    ).toBe(403);
  } finally {
    f.db.close();
  }
});

test("approval is opt-in, pending credentials stay private, and owner updates revoke old capabilities", async () => {
  const f = await fixture();
  try {
    const { created, invite } = await f.publish({ approval: true });
    const proof = await M.admit(invite, created.secret, f.people.newcomer);
    expect(
      (
        await f.request(
          "newcomer",
          "/invitations/" + created.grant.id + "/join",
          proof,
        )
      ).body.pending,
    ).toBe(true);
    expect(f.one("SELECT 1 FROM members WHERE user='newcomer'")).toBeNull();
    const credential = await M.createCredential(
      invite,
      created.secret,
      f.people.newcomer,
    );
    expect(
      (
        await f.request("newcomer", "/guilds/guild/history-credentials", {
          invite: created.grant.id,
          envelope: credential,
        })
      ).status,
    ).toBe(200);
    expect(
      (await f.request("newcomer", "/guilds/guild/history-credentials")).status,
    ).toBe(403);
    const next = { ...f.baseRoster, version: 2 };
    const signature = await C.sign(next, f.people.owner);
    f.run(
      "UPDATE guilds SET roster=?,signature=?,version=2 WHERE id='guild'",
      JSON.stringify(next),
      signature,
    );
    f.run(
      "INSERT INTO rosters VALUES(?,?,?,?)",
      "guild",
      2,
      JSON.stringify(next),
      signature,
    );
    f.module.rosterChanged("guild");
    expect(f.module.state("guild").activeInvites).toEqual([]);
    expect(
      (await f.request("newcomer", "/invitations/" + created.grant.id)).status,
    ).toBe(403);
    expect(
      (
        await M.validateCertificate(
          f.module.certificate("guild"),
          f.people.owner.keys,
        )
      ).version,
    ).toBe(2);
  } finally {
    f.db.close();
  }
});

test("membership quota rejects joins atomically without consuming invitation usage", async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 30; index++) {
      const guild = "other-" + index;
      f.run(
        "INSERT INTO guilds VALUES(?,?,?,?,?,?)",
        guild,
        "newcomer",
        guild,
        "{}",
        "signature",
        1,
      );
      f.run("INSERT INTO members VALUES(?,?,?)", guild, "newcomer", "owner");
    }
    const { created, invite } = await f.publish();
    const proof = await M.admit(invite, created.secret, f.people.newcomer);
    expect(
      (
        await f.request(
          "newcomer",
          "/invitations/" + created.grant.id + "/join",
          proof,
        )
      ).status,
    ).toBe(409);
    expect(
      f.one("SELECT uses FROM invitation_grants WHERE id=?", created.grant.id)
        .uses,
    ).toBe(0);
    expect(
      f.one("SELECT COUNT(*) AS n FROM members WHERE user='newcomer'").n,
    ).toBe(30);
  } finally {
    f.db.close();
  }
});
