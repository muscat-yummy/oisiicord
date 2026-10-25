import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "../src/server";
import * as C from "../public/crypto.js";

type Person = {
  id: string;
  username: string;
  keys: any;
  privateKeys: any;
  identity: any;
  cookie: string;
  auth: string;
  salt: string;
  vault: any;
};
const origin = "http://localhost:31997";
let app: ReturnType<typeof createApp>,
  fileServer: Bun.Server<any>,
  base: string;
let alice: Person,
  bob: Person,
  mallory: Person,
  guild: string,
  room: string,
  dm: string,
  roster: any;
const files = new Map<string, Uint8Array>();
async function request(
  person: Person | undefined,
  path: string,
  body?: any,
  method?: string,
  customOrigin = origin,
) {
  const response = await fetch(base + "/api" + path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      Origin: customOrigin,
      ...(person ? { Cookie: person.cookie } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    headers: response.headers,
    body: (await response.json()) as any,
  };
}
async function register(username: string): Promise<Person> {
  const ident = await C.identity(),
    id = crypto.randomUUID(),
    salt = C.b64(C.random(32)),
    auth = C.b64(C.random(32)),
    identity = await C.importIdentity(ident.privateKeys, ident.keys),
    key = C.random(32),
    vault = await C.encryptVault(ident.privateKeys, key, username);
  const r = await request(undefined, "/auth/register", {
    id,
    username,
    display: username,
    salt,
    auth,
    keys: ident.keys,
    vault,
    proof: await C.sign({ id, username, keys: ident.keys }, identity),
  });
  expect(r.status).toBe(200);
  return {
    id,
    username,
    keys: ident.keys,
    privateKeys: ident.privateKeys,
    identity: { ...identity, id },
    cookie: r.headers.get("set-cookie")!.split(";")[0],
    auth,
    salt,
    vault,
  };
}
const member = (u: Person, role = "member") => ({
  id: u.id,
  keys: u.keys,
  role,
});
async function envelope(
  person: Person,
  payload: any,
  recipients = [member(alice, "owner"), member(bob)],
  version = 2,
  id = crypto.randomUUID(),
) {
  return C.seal(payload, {
    room,
    author: person.id,
    recipients,
    identity: person.identity,
    version,
    id,
  });
}
beforeAll(async () => {
  fileServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/upload") {
        const form = await req.formData(),
          file = form.get("file") as File;
        expect(file.name.endsWith(".enc")).toBe(true);
        const id = crypto.randomUUID();
        files.set(id, new Uint8Array(await file.arrayBuffer()));
        return Response.json({
          Status: "OK",
          FileID: id,
          RemovePassword: "secret-delete",
        });
      }
      if (url.pathname === "/download") {
        const data = files.get(url.searchParams.get("id")!);
        return new Response(data ? new Uint8Array(data).buffer : null, {
          status: data ? 200 : 404,
        });
      }
      if (url.pathname === "/delete") {
        if (url.searchParams.get("password") !== "secret-delete")
          return new Response(null, { status: 403 });
        files.delete(url.searchParams.get("id")!);
        return Response.json({ Status: "OK" });
      }
      return new Response(null, { status: 404 });
    },
  });
  app = createApp({
    path: ":memory:",
    port: 31997,
    origin,
    fileOrigin: `http://127.0.0.1:${fileServer.port}`,
  });
  base = `http://127.0.0.1:${app.server.port}`;
  alice = await register("alice");
  bob = await register("bob");
  mallory = await register("mallory");
});
afterAll(() => {
  app?.stop();
  fileServer?.stop(true);
});
describe("browser cryptography", () => {
  test("password derivation separates authentication and vault keys", async () => {
    const a = await C.credentials("long-password-123456", alice.salt),
      b = await C.credentials("long-password-123456", alice.salt);
    expect(a.auth).toBe(b.auth);
    expect(a.auth).not.toBe(C.b64(a.vault));
    const box = await C.encryptVault(alice.privateKeys, a.vault, "alice");
    expect(await C.decryptVault(box, a.vault, "alice")).toEqual(
      alice.privateKeys,
    );
    await expect(C.decryptVault(box, C.random(32), "alice")).rejects.toThrow();
  });
  test("ciphertext/signature/recipient/context modification is rejected", async () => {
    const payload = { type: "message", text: "secret-body-unique", files: [] };
    const e = await C.seal(payload, {
      room: "unit-room",
      author: alice.id,
      recipients: [member(alice), member(bob)],
      identity: alice.identity,
    });
    expect(JSON.stringify(e)).not.toContain(payload.text);
    expect(await C.open(e, bob.identity, alice.keys, "unit-room")).toEqual(
      payload,
    );
    await expect(
      C.open(e, mallory.identity, alice.keys, "unit-room"),
    ).rejects.toThrow();
    await expect(
      C.open(e, bob.identity, alice.keys, "other-room"),
    ).rejects.toThrow();
    for (const path of ["payload", "boxes", "header"]) {
      const changed: any = structuredClone(e);
      if (path === "payload") changed.payload.ct = "AAAA";
      if (path === "boxes") changed.boxes[bob.id].iv = C.b64(C.random(12));
      if (path === "header") changed.header.author = mallory.id;
      await expect(
        C.open(changed, bob.identity, alice.keys, "unit-room"),
      ).rejects.toThrow();
    }
  });
  test("file encryption hides bytes and detects tampering", async () => {
    const f = new File(["private-file-contents"], "private.txt");
    const { ciphertext, descriptor } = await C.encryptFile(f);
    expect(new TextDecoder().decode(ciphertext)).not.toContain(
      "private-file-contents",
    );
    expect(
      new TextDecoder().decode(await C.decryptFile(ciphertext, descriptor)),
    ).toBe("private-file-contents");
    const changed = new Uint8Array(ciphertext);
    changed[0] ^= 1;
    await expect(C.decryptFile(changed.buffer, descriptor)).rejects.toThrow();
  });
});
describe("authorization and encrypted collaboration", () => {
  test("multiple owned guilds, signed membership, and channel permissions", async () => {
    guild = crypto.randomUUID();
    roster = {
      guild,
      owner: alice.id,
      version: 1,
      members: [member(alice, "owner")],
    };
    let r = await request(alice, "/guilds", {
      name: "検証サーバー",
      roster,
      signature: await C.sign(roster, alice.identity),
    });
    expect(r.status).toBe(200);
    const second = { ...roster, guild: crypto.randomUUID() };
    r = await request(alice, "/guilds", {
      name: "second",
      roster: second,
      signature: await C.sign(second, alice.identity),
    });
    expect(r.status).toBe(200);
    const state = await request(alice, "/state");
    room = state.body.guilds[0].channels.find((r: any) => r.kind === "text").id;
    expect((await request(bob, "/rooms/" + room + "/events")).status).toBe(403);
    expect(
      (
        await request(bob, "/guilds/" + guild + "/channels", {
          name: "bad",
          kind: "text",
        })
      ).status,
    ).toBe(403);
  });
  test("invite joins require owner approval and roster signature", async () => {
    const invite = await request(alice, "/guilds/" + guild + "/invites", {});
    expect(
      (await request(bob, "/guilds/" + guild + "/join", { token: "wrong" }))
        .status,
    ).toBe(403);
    expect(
      (
        await request(bob, "/guilds/" + guild + "/join", {
          token: invite.body.token,
        })
      ).status,
    ).toBe(200);
    expect((await request(bob, "/rooms/" + room + "/events")).status).toBe(403);
    roster = {
      ...roster,
      version: 2,
      members: [member(alice, "owner"), member(bob)],
    };
    expect(
      (
        await request(
          alice,
          "/guilds/" + guild + "/roster",
          { roster, signature: await C.sign(roster, bob.identity) },
          "PUT",
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await request(
          alice,
          "/guilds/" + guild + "/roster",
          { roster, signature: await C.sign(roster, alice.identity) },
          "PUT",
        )
      ).status,
    ).toBe(200);
    expect((await request(bob, "/rooms/" + room + "/events")).status).toBe(200);
  });
  test("messages, signed edits, replay rejection, and database confidentiality", async () => {
    const e = await envelope(alice, {
      type: "message",
      text: "top-secret-message-239",
      files: [],
    });
    expect((await request(alice, "/rooms/" + room + "/events", e)).status).toBe(
      200,
    );
    expect((await request(alice, "/rooms/" + room + "/events", e)).status).toBe(
      409,
    );
    const edit = await envelope(alice, {
      type: "edit",
      target: e.header.id,
      text: "updated-secret-239",
    });
    expect(
      (await request(alice, "/rooms/" + room + "/events", edit)).status,
    ).toBe(200);
    const batch = await request(bob, "/rooms/" + room + "/events");
    expect(batch.body.length).toBe(2);
    expect(
      await C.open(batch.body[0].envelope, bob.identity, alice.keys, room),
    ).toMatchObject({ text: "top-secret-message-239" });
    expect(
      await C.verify(
        batch.body[0].certificate.roster,
        batch.body[0].certificate.signature,
        alice.keys,
      ),
    ).toBe(true);
    const dbRows = JSON.stringify(app.db.query("SELECT * FROM events").all());
    expect(dbRows).not.toContain("top-secret-message-239");
    expect(dbRows).not.toContain("updated-secret-239");
  });
  test("forged authors, stale epochs, extra recipients, and unauthorized access fail", async () => {
    const e = await envelope(alice, { type: "message", text: "x", files: [] });
    expect((await request(bob, "/rooms/" + room + "/events", e)).status).toBe(
      400,
    );
    expect(
      (
        await request(
          alice,
          "/rooms/" + room + "/events",
          await envelope(
            alice,
            { type: "message", text: "x", files: [] },
            [member(alice)],
            2,
          ),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await request(
          alice,
          "/rooms/" + room + "/events",
          await envelope(
            alice,
            { type: "message", text: "x", files: [] },
            [member(alice), member(bob)],
            1,
          ),
        )
      ).status,
    ).toBe(409);
    expect((await request(mallory, "/rooms/" + room + "/events")).status).toBe(
      403,
    );
    expect((await request(bob, "/rooms/" + room, {}, "DELETE")).status).toBe(
      403,
    );
  });
  test("DMs are scoped to participants and deduplicated", async () => {
    const result = await request(alice, "/dms", { user: bob.id });
    dm = result.body.id;
    expect((await request(bob, "/dms", { user: alice.id })).body.id).toBe(dm);
    expect((await request(mallory, "/rooms/" + dm + "/events")).status).toBe(
      403,
    );
  });
  test("attachment adapter uploads only ciphertext and decrypts downloaded bytes", async () => {
    const encrypted = await C.encryptFile(
      new File(["mock-attachment-secret"], "file.txt"),
    );
    const r = await fetch(base + "/api/files", {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: alice.cookie,
        "Content-Type": "application/octet-stream",
      },
      body: encrypted.ciphertext,
    });
    expect(r.status).toBe(200);
    const result = (await r.json()) as any;
    expect(new TextDecoder().decode(files.get(result.id))).not.toContain(
      "mock-attachment-secret",
    );
    const download = await fetch(base + "/api/files/" + result.id, {
      headers: { Cookie: bob.cookie },
    });
    expect(
      new TextDecoder().decode(
        await C.decryptFile(await download.arrayBuffer(), encrypted.descriptor),
      ),
    ).toBe("mock-attachment-secret");
    expect(
      (
        await request(
          alice,
          "/files/" + result.id,
          { password: result.removePassword },
          "DELETE",
        )
      ).status,
    ).toBe(200);
  });
  test("removed member loses access; new events omit their key", async () => {
    roster = { ...roster, version: 3, members: [member(alice, "owner")] };
    expect(
      (
        await request(
          alice,
          "/guilds/" + guild + "/roster",
          { roster, signature: await C.sign(roster, alice.identity) },
          "PUT",
        )
      ).status,
    ).toBe(200);
    expect((await request(bob, "/rooms/" + room + "/events")).status).toBe(403);
    const e = await envelope(
      alice,
      { type: "message", text: "after-removal", files: [] },
      [member(alice)],
      3,
    );
    expect((await request(alice, "/rooms/" + room + "/events", e)).status).toBe(
      200,
    );
    await expect(C.open(e, bob.identity, alice.keys, room)).rejects.toThrow();
  });
  test("CSRF, no-auth, key proof, and session revocation", async () => {
    expect(
      (
        await request(
          alice,
          "/dms",
          { user: bob.id },
          "POST",
          "https://attacker.invalid",
        )
      ).status,
    ).toBe(403);
    expect((await request(undefined, "/state")).status).toBe(401);
    const login = await request(undefined, "/auth/login", {
      username: alice.username,
      auth: alice.auth,
    });
    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).toContain("HttpOnly");
    expect(login.headers.get("set-cookie")).toContain("SameSite=Strict");
    const session = {
      ...alice,
      cookie: login.headers.get("set-cookie")!.split(";")[0],
    };
    expect((await request(session, "/auth/logout", {})).status).toBe(200);
    expect((await request(session, "/state")).status).toBe(401);
    expect(
      (
        await request(undefined, "/auth/login", {
          username: alice.username,
          auth: C.b64(C.random(32)),
        })
      ).status,
    ).toBe(401);
  });
});

test("realtime socket authorization, presence, event delivery and logout", async () => {
  const created = await request(alice, "/dms", { user: bob.id });
  const roomId = created.body.id;
  async function connect(person: Person) {
    const socket = new WebSocket(base.replace("http:", "ws:") + "/ws", {
      headers: { Origin: origin, Cookie: person.cookie },
    });
    const messages: any[] = [];
    socket.addEventListener("message", (e) =>
      messages.push(JSON.parse(String(e.data))),
    );
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(Error("socket failed")), {
        once: true,
      });
    });
    return { socket, messages };
  }
  async function until(predicate: () => boolean) {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return;
      await Bun.sleep(10);
    }
    throw Error("socket event timeout");
  }
  const a = await connect(alice),
    b = await connect(bob),
    attacker = await connect(mallory);
  try {
    await until(() =>
      a.messages.some(
        (m) => m.type === "presence" && m.user === bob.id && m.online,
      ),
    );
    const e = await C.seal(
      { type: "message", text: "socket-secret", files: [] },
      {
        room: roomId,
        author: alice.id,
        recipients: [member(alice), member(bob)],
        identity: alice.identity,
        version: 0,
      },
    );
    expect(
      (await request(alice, "/rooms/" + roomId + "/events", e)).status,
    ).toBe(200);
    await until(() =>
      b.messages.some((m) => m.type === "event" && m.room === roomId),
    );
    expect(attacker.messages.some((m) => m.type === "event")).toBe(false);
    a.socket.send(JSON.stringify({ type: "join-voice", room: roomId }));
    b.socket.send(JSON.stringify({ type: "join-voice", room: roomId }));
    await until(() => b.messages.some((m) => m.type === "voice-peers"));
    const signaling = await C.seal(
      {
        type: "signal",
        to: bob.id,
        description: { type: "offer", sdp: "local-test-sdp" },
      },
      {
        room: roomId,
        author: alice.id,
        recipients: [member(alice), member(bob)],
        identity: alice.identity,
        version: 0,
      },
    );
    a.socket.send(
      JSON.stringify({ type: "signal", room: roomId, envelope: signaling }),
    );
    await until(() => b.messages.some((m) => m.type === "signal"));
    const received = b.messages.find((m) => m.type === "signal");
    expect(
      (await C.open(received.envelope, bob.identity, alice.keys, roomId))
        .description.sdp,
    ).toBe("local-test-sdp");
    expect(
      (await request(alice, "/rooms/" + roomId + "/events", signaling)).status,
    ).toBe(400);
    a.socket.send(
      JSON.stringify({ type: "signal", room: roomId, envelope: e }),
    );
    await until(() => a.messages.some((m) => m.type === "error"));
    expect(
      a.messages.filter((m) => m.type === "error").at(-1).message,
    ).toContain("形式が不正");

    attacker.socket.send(JSON.stringify({ type: "typing", room: roomId }));
    await until(() => attacker.messages.some((m) => m.type === "error"));
    expect((await request(bob, "/auth/logout", {})).status).toBe(200);
    await until(() => b.socket.readyState === WebSocket.CLOSED);
    await until(() =>
      a.messages.some(
        (m) => m.type === "presence" && m.user === bob.id && !m.online,
      ),
    );
    expect(b.socket.readyState).toBe(WebSocket.CLOSED);
  } finally {
    a.socket.close();
    b.socket.close();
    attacker.socket.close();
  }
});

test("profile and guild metadata validation and persistence", async () => {
  expect(
    (
      await request(
        alice,
        "/me",
        {
          display: "Alice",
          bio: "自己紹介",
          pronouns: "they/them",
          status: "idle",
          bannerColor: "#5865f2",
        },
        "PATCH",
      )
    ).status,
  ).toBe(200);
  let s = await request(alice, "/state");
  expect(s.body.me.profile).toMatchObject({
    bio: "自己紹介",
    status: "idle",
    bannerColor: "#5865f2",
  });
  expect(
    (await request(alice, "/me", { status: "invalid" }, "PATCH")).status,
  ).toBe(400);
  expect(
    (await request(alice, "/me", { avatar: { id: "../../file" } }, "PATCH"))
      .status,
  ).toBe(400);
  expect(
    (
      await request(
        alice,
        "/guilds/" + guild,
        {
          name: "プロフィール検証",
          description: "サーバーの説明",
          bannerColor: "#23a559",
        },
        "PATCH",
      )
    ).status,
  ).toBe(200);
  s = await request(alice, "/state");
  expect(s.body.guilds[0].profile.description).toBe("サーバーの説明");
  expect(
    (
      await request(
        mallory,
        "/guilds/" + guild,
        { description: "bad" },
        "PATCH",
      )
    ).status,
  ).toBe(403);
  expect((await request(mallory, "/guilds/" + guild + "/invites")).status).toBe(
    403,
  );
});
test("sessions can be listed and revoked without exposing authentication cookies", async () => {
  const login = await request(undefined, "/auth/login", {
    username: alice.username,
    auth: alice.auth,
  });
  const other = {
    ...alice,
    cookie: login.headers.get("set-cookie")!.split(";")[0],
  };
  const sessions = await request(alice, "/sessions");
  expect(sessions.status).toBe(200);
  expect(sessions.body.every((s: any) => !("token" in s))).toBe(true);
  const current = sessions.body.find((s: any) => s.current),
    target = sessions.body.find((s: any) => !s.current);
  expect(
    (await request(alice, "/sessions/" + current.id, {}, "DELETE")).status,
  ).toBe(400);
  expect(
    (await request(alice, "/sessions/" + target.id, {}, "DELETE")).status,
  ).toBe(200);
  expect((await request(other, "/state")).status).toBe(401);
});
test("password changes preserve identity and invalidate the old authentication secret", async () => {
  const salt = C.b64(C.random(32)),
    auth = C.b64(C.random(32)),
    vault = await C.encryptVault(
      alice.privateKeys,
      C.random(32),
      alice.username,
    ),
    proof = { user: alice.id, salt, auth, vault };
  expect(
    (
      await request(alice, "/auth/password", {
        ...proof,
        oldAuth: C.b64(C.random(32)),
        signature: await C.sign(proof, alice.identity),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request(alice, "/auth/password", {
        ...proof,
        oldAuth: alice.auth,
        signature: await C.sign(proof, alice.identity),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await request(undefined, "/auth/login", {
        username: alice.username,
        auth: alice.auth,
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await request(undefined, "/auth/login", {
        username: alice.username,
        auth,
      })
    ).status,
  ).toBe(200);
  expect((await request(alice, "/state")).body.me.keys).toEqual(alice.keys);
});

test("server channel settings persist, order validation is scoped, and deleted defaults clear", async () => {
  const created = await request(alice, `/guilds/${guild}/channels`, {
    name: "announcements",
    kind: "text",
    topic: "Release notes",
  });
  expect(created.status).toBe(200);
  const channel = created.body.id;
  expect(
    (
      await request(
        alice,
        `/rooms/${channel}`,
        { topic: "Updated topic" },
        "PATCH",
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await request(mallory, `/guilds/${guild}/channelorder`, {
        ids: [channel],
      })
    ).status,
  ).toBe(403);
  let data = (await request(alice, "/state")).body.guilds.find(
    (g: any) => g.id === guild,
  );
  const ids = data.channels.map((r: any) => r.id).reverse();
  expect(
    (
      await request(alice, `/guilds/${guild}/channelorder`, {
        ids: [channel, channel],
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request(alice, `/guilds/${guild}/channelorder`, {
        ids: [...ids.slice(1), dm],
      })
    ).status,
  ).toBe(400);
  expect(
    (await request(alice, `/guilds/${guild}/channelorder`, { ids })).status,
  ).toBe(200);
  expect(
    (
      await request(
        alice,
        `/guilds/${guild}`,
        { defaultChannel: channel },
        "PATCH",
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await request(
        alice,
        `/guilds/${guild}`,
        { description: "Server description" },
        "PATCH",
      )
    ).status,
  ).toBe(200);
  data = (await request(alice, "/state")).body.guilds.find(
    (g: any) => g.id === guild,
  );
  expect(data.channels.map((r: any) => r.id)).toEqual(ids);
  expect(data.channels.find((r: any) => r.id === channel).topic).toBe(
    "Updated topic",
  );
  expect(data.profile.defaultChannel).toBe(channel);
  expect(
    (await request(alice, `/guilds/${guild}`, { defaultChannel: dm }, "PATCH"))
      .status,
  ).toBe(400);
  expect(
    (
      await request(
        alice,
        `/rooms/${channel}`,
        { topic: "x".repeat(1025) },
        "PATCH",
      )
    ).status,
  ).toBe(400);
  expect((await request(alice, `/rooms/${channel}`, {}, "DELETE")).status).toBe(
    200,
  );
  expect(
    (await request(alice, "/state")).body.guilds.find(
      (g: any) => g.id === guild,
    ).profile.defaultChannel,
  ).toBe(null);
});

test("limited invitations count distinct requests atomically and can be revoked individually", async () => {
  const applicant = await register("invite_applicant"),
    second = await register("invite_second");
  const created = await request(alice, `/guilds/${guild}/invites`, {
    expiresIn: 0,
    maxUses: 1,
  });
  expect(created.status).toBe(200);
  expect(created.body.expires).toBe(null);
  const token = created.body.token;
  const results = await Promise.all([
    request(applicant, `/guilds/${guild}/join`, { token }),
    request(applicant, `/guilds/${guild}/join`, { token }),
  ]);
  expect(results.map((r) => r.status)).toEqual([200, 200]);
  expect(
    (await request(second, `/guilds/${guild}/join`, { token })).status,
  ).toBe(403);
  let invites = (await request(alice, `/guilds/${guild}/invites`)).body;
  const limited = invites.find((i: any) => i.maxUses === 1);
  expect(limited.uses).toBe(1);
  expect(limited.expires).toBe(null);
  expect(
    (await request(mallory, `/guilds/${guild}/revoke`, { id: limited.id }))
      .status,
  ).toBe(403);
  expect(
    (await request(alice, `/guilds/${guild}/revoke`, { id: limited.id }))
      .status,
  ).toBe(200);
  expect(
    (await request(applicant, `/guilds/${guild}/join`, { token })).status,
  ).toBe(403);
  const expiring = await request(alice, `/guilds/${guild}/invites`, {
    expiresIn: 3600,
    maxUses: 5,
  });
  expect(expiring.body.expires).toBeGreaterThan(Date.now());
  const expiringID = (
    await request(alice, `/guilds/${guild}/invites`)
  ).body.find((i: any) => i.maxUses === 5).id;
  app.db
    .query("UPDATE invites SET expires=? WHERE hash=?")
    .run(Date.now() - 1, expiringID);
  expect(
    (
      await request(second, `/guilds/${guild}/join`, {
        token: expiring.body.token,
      })
    ).status,
  ).toBe(403);
  expect(
    (await request(alice, `/guilds/${guild}/invites`, { expiresIn: -1 }))
      .status,
  ).toBe(400);
  expect(
    (await request(alice, `/guilds/${guild}/invites`, { maxUses: "1" })).status,
  ).toBe(400);
  const audit = await request(alice, `/guilds/${guild}/audit`);
  expect(audit.status).toBe(200);
  expect(audit.body.some((e: any) => e.action === "invite.revoke")).toBe(true);
  expect(audit.body.some((e: any) => e.action === "channel.update")).toBe(true);
  expect(JSON.stringify(audit.body)).not.toContain(token);
  expect(JSON.stringify(audit.body)).not.toContain(limited.id);
  expect((await request(mallory, `/guilds/${guild}/audit`)).status).toBe(403);
  const before = audit.body[0].id;
  expect(
    (
      await request(alice, `/guilds/${guild}/audit?before=${before}`)
    ).body.every((e: any) => e.id < before),
  ).toBe(true);
  expect(
    (await request(alice, `/guilds/${guild}/audit?before=oops`)).status,
  ).toBe(400);
});
