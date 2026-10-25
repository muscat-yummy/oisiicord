import { test, expect } from "bun:test";
import { createApp } from "../src/server";
import * as C from "../public/crypto.js";
import * as M from "../public/membership.js";
test("signed departure, fresh rejoin, block enforcement and account erasure preserve history", async () => {
  const app = createApp({
    path: ":memory:",
    port: 0,
    origin: "http://localhost:31983",
  });
  const base = "http://127.0.0.1:" + app.server.port;
  async function api(
    p: any,
    path: string,
    body?: any,
    method = body === undefined ? "GET" : "POST",
  ) {
    const r = await fetch(base + "/api" + path, {
      method,
      headers: {
        Origin: app.origin,
        ...(p ? { Cookie: p.cookie } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: r.status,
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
      },
      auth = C.b64(C.random(32));
    const r = await api(null, "/auth/register", {
      id,
      username,
      display: username,
      salt: C.b64(C.random(32)),
      auth,
      keys: keys.keys,
      vault: await C.lock(C.random(32), C.bytes("fixture"), "fixture"),
      proof: await C.sign({ id, username, keys: keys.keys }, identity),
    });
    expect(r.status).toBe(200);
    return { ...identity, username, auth, cookie: r.cookie };
  }
  async function state(p: any) {
    return (await api(p, "/state")).body;
  }
  async function guild(p: any, name: string) {
    const id = crypto.randomUUID(),
      roster = {
        guild: id,
        owner: p.id,
        version: 1,
        members: [{ id: p.id, keys: p.keys, role: "owner" }],
      };
    expect(
      (
        await api(p, "/guilds", {
          id,
          name,
          roster,
          signature: await C.sign(roster, p),
        })
      ).status,
    ).toBe(200);
    return (await state(p)).guilds.find((g: any) => g.id === id);
  }
  async function invite(p: any, g: any) {
    const grant = await M.createGrant(
      {
        guild: g.id,
        owner: p.id,
        baseVersion: g.certificate.baseRoster.version,
        history: [],
      },
      p,
    );
    expect(
      (await api(p, "/guilds/" + g.id + "/invitations", grant)).status,
    ).toBe(200);
    return grant;
  }
  async function join(p: any, i: any) {
    return api(
      p,
      "/invitations/" + i.grant.id + "/join",
      await M.admit(i, i.secret, p),
    );
  }
  async function leave(p: any, g: any) {
    const proof = M.departure(g.id, p.id, g.certificate.baseRoster.version);
    return { proof, signature: await C.sign(proof, p) };
  }
  try {
    const alice = await register("life_alice"),
      bob = await register("life_bob"),
      carol = await register("life_carol");
    const initial = await guild(alice, "Main");
    const first = await invite(alice, initial);
    expect((await join(bob, first)).status).toBe(200);
    let g = (await state(alice)).guilds[0];
    expect(
      (await M.validateCertificate(g.certificate, alice.keys)).members.map(
        (m: any) => m.id,
      ),
    ).toContain(bob.id);
    const record = await leave(bob, g),
      forged = { ...record, signature: await C.sign(record.proof, carol) };
    expect((await api(bob, "/guilds/" + g.id + "/leave", forged)).status).toBe(
      400,
    );
    expect(
      (await api(alice, "/guilds/" + g.id + "/leave", await leave(alice, g)))
        .status,
    ).toBe(409);
    expect((await api(bob, "/guilds/" + g.id + "/leave", record)).status).toBe(
      200,
    );
    const after = (await state(alice)).guilds[0];
    const roster = await M.validateCertificate(after.certificate, alice.keys);
    const checkpoint = M.departureCheckpoint(after.certificate);
    expect(() =>
      M.departureCheckpoint(
        { ...g.certificate, version: after.version + 100 },
        checkpoint,
      ),
    ).toThrow();
    expect(M.departureCheckpoint(after.certificate, checkpoint)).toEqual(
      checkpoint,
    );
    expect(roster.members.map((m: any) => m.id)).not.toContain(bob.id);
    expect(after.activeInvites).toEqual([]);
    expect((await join(carol, first)).status).toBe(403);
    expect(
      (await api(bob, "/rooms/" + g.channels[0].id + "/events")).status,
    ).toBe(403);
    const oldAdmission = g.certificate.changes[0];
    await expect(
      M.validateCertificate(
        {
          ...after.certificate,
          changes: [...after.certificate.changes, oldAdmission],
        },
        alice.keys,
      ),
    ).rejects.toThrow();
    const e = await C.seal(
      { type: "message", text: "after departure", files: [] },
      {
        room: g.channels[0].id,
        author: alice.id,
        identity: alice,
        recipients: roster.members,
        version: after.version,
      },
    );
    expect(
      (await api(alice, "/rooms/" + g.channels[0].id + "/events", e)).status,
    ).toBe(200);
    await expect(
      C.open(e, bob, alice.keys, g.channels[0].id),
    ).rejects.toThrow();
    const fresh = await invite(alice, after);
    expect((await join(bob, fresh)).status).toBe(200);
    g = (await state(bob)).guilds.find((x: any) => x.id === initial.id);
    const rejoined = await M.validateCertificate(g.certificate, alice.keys);
    expect(rejoined.members.map((m: any) => m.id)).toContain(bob.id);
    const wrapped = await C.seal(
      { type: "message", text: "before deletion", files: [] },
      {
        room: g.channels[0].id,
        author: bob.id,
        identity: bob,
        recipients: rejoined.members,
        version: g.version,
        historyWrap: (key: any, eph: any, context: any) =>
          M.wrapHistoryKeys(key, eph, context, g.activeInvites, alice.keys, {
            guild: g.id,
            baseVersion: 1,
            inviteCutoff: rejoined.inviteCutoff,
          }),
      },
    );
    expect(
      (await api(bob, "/rooms/" + g.channels[0].id + "/events", wrapped))
        .status,
    ).toBe(200);
    const dm = (await api(alice, "/dms", { user: bob.id })).body.id;
    expect((await api(alice, "/blocks/" + bob.id, {}, "PUT")).status).toBe(200);
    expect((await api(bob, "/dms", { user: alice.id })).status).toBe(403);
    const dmEvent = await C.seal(
      { type: "message", text: "blocked", files: [] },
      { room: dm, author: bob.id, identity: bob, recipients: [alice, bob] },
    );
    expect((await api(bob, "/rooms/" + dm + "/events", dmEvent)).status).toBe(
      403,
    );
    expect((await api(alice, "/rooms/" + dm + "/events")).status).toBe(200);
    expect((await state(alice)).unavailableDMs).toContain(dm);
    expect((await api(bob, "/blocks/" + alice.id, {}, "DELETE")).status).toBe(
      200,
    );
    expect((await api(bob, "/rooms/" + dm + "/events", dmEvent)).status).toBe(
      403,
    );
    expect((await api(alice, "/blocks/" + bob.id, {}, "DELETE")).status).toBe(
      200,
    );
    expect((await api(bob, "/rooms/" + dm + "/events", dmEvent)).status).toBe(
      200,
    );
    const own = await guild(bob, "Owned by Bob");
    const proof = {
      v: 1,
      type: "delete-account",
      user: bob.id,
      at: Date.now(),
      nonce: crypto.randomUUID(),
      owned: [own.id],
      departures: [await leave(bob, g)],
    };
    const signature = await C.sign(proof, bob);
    expect(
      (
        await api(
          bob,
          "/me",
          { proof, signature, auth: C.b64(C.random(32)) },
          "DELETE",
        )
      ).status,
    ).toBe(401);
    expect(
      app.db.query("SELECT 1 FROM guilds WHERE id=?").get(own.id),
    ).not.toBeNull();
    const missing = { ...proof, owned: [] };
    expect(
      (
        await api(
          bob,
          "/me",
          {
            proof: missing,
            signature: await C.sign(missing, bob),
            auth: bob.auth,
          },
          "DELETE",
        )
      ).status,
    ).toBe(409);
    expect(
      (await api(bob, "/me", { proof, signature, auth: bob.auth }, "DELETE"))
        .status,
    ).toBe(200);
    expect((await api(bob, "/state")).status).toBe(401);
    expect(
      (
        await api(null, "/auth/login", {
          username: bob.username,
          auth: bob.auth,
        })
      ).status,
    ).toBe(401);
    expect(
      app.db.query("SELECT 1 FROM guilds WHERE id=?").get(own.id),
    ).toBeNull();
    expect(
      app.db.query("SELECT 1 FROM sessions WHERE user=?").get(bob.id),
    ).toBeNull();
    const tombstone = app.db
      .query("SELECT * FROM users WHERE id=?")
      .get(bob.id) as any;
    expect(tombstone.vault).toBe("{}");
    expect(tombstone.salt).toBe("");
    expect(tombstone.auth).toBe("!deleted");
    expect(tombstone.username).not.toBe(bob.username);
    const history = (
      await api(alice, "/rooms/" + g.channels[0].id + "/events")
    ).body.find((r: any) => r.id === wrapped.header.id);
    expect(history.authorUser.deleted).toBe(true);
    expect(
      (
        await C.open(
          history.envelope,
          alice,
          history.authorUser.keys,
          g.channels[0].id,
        )
      ).text,
    ).toBe("before deletion");
    expect((await api(alice, "/dms", { user: bob.id })).status).toBe(403);
    const final = (await state(alice)).guilds[0];
    expect(
      (await M.validateCertificate(final.certificate, alice.keys)).members.map(
        (m: any) => m.id,
      ),
    ).not.toContain(bob.id);
    expect(app.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    app.stop();
  }
});
