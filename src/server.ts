import { database } from "./db";
import { canonical, verify, fingerprint } from "../public/crypto.js";
import { resolve } from "node:path";

type Row = Record<string, any>;
type WSData = {
  user: string;
  session: string;
  expires: number;
  voice: string | null;
};
const idPattern = /^[a-zA-Z0-9_-]{1,100}$/;
const sha = (s: string) =>
  new Bun.CryptoHasher("sha256").update(s).digest("hex");
const uuid = () => crypto.randomUUID();
class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const fail = (status: number, message: string): never => {
  throw new HttpError(status, message);
};
export function createApp(
  options: {
    path?: string;
    port?: number;
    origin?: string;
    hostname?: string;
    fileOrigin?: string;
  } = {},
) {
  const db = database(
    options.path ?? process.env.DATABASE_PATH ?? "./data/oisiicord.sqlite",
  );
  const origin =
    options.origin ?? process.env.APP_ORIGIN ?? "http://localhost:3000";
  const site = new URL(origin);
  if (
    site.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(site.hostname)
  )
    throw Error("APP_ORIGIN requires HTTPS outside localhost");
  const secure = site.protocol === "https:";
  const cookieName = secure ? "__Host-oisiicord" : "oisiicord";
  const fileOrigin = options.fileOrigin ?? "https://api.end2end.tech";
  const sockets = new Set<Bun.ServerWebSocket<WSData>>();
  const buckets = new Map<string, { n: number; reset: number }>();
  const one = (sql: string, ...args: any[]): Row | undefined =>
    db.query(sql).get(...args) as Row | undefined;
  const all = (sql: string, ...args: any[]): Row[] =>
    db.query(sql).all(...args) as Row[];
  const run = (sql: string, ...args: any[]) => db.query(sql).run(...args);
  function limit(key: string, max: number, window = 60000) {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.reset < now) {
      b = { n: 0, reset: now + window };
      buckets.set(key, b);
    }
    if (++b.n > max) fail(429, "操作が多すぎる。しばらく待って再試行して");
  }
  const maintenance = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k);
    run("DELETE FROM sessions WHERE expires < ?", now);
    for (const ws of sockets)
      if (!sessionValid(ws.data)) ws.close(4001, "Session expired");
  }, 60000);
  maintenance.unref();
  function sessionValid(data: WSData) {
    return !!one(
      "SELECT token FROM sessions WHERE token=? AND expires>?",
      data.session,
      Date.now(),
    );
  }
  function auth(req: Request) {
    const token = req.headers
      .get("cookie")
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(cookieName + "="))
      ?.slice(cookieName.length + 1);
    const session =
      token &&
      one(
        "SELECT * FROM sessions WHERE token=? AND expires>?",
        sha(token),
        Date.now(),
      );
    if (!session) return fail(401, "ログインが必要");
    return session as Row;
  }
  const user = (id: string) => {
    const row = one(
      "SELECT id,username,display,keys FROM users WHERE id=?",
      id,
    );
    if (!row) return fail(404, "ユーザーが見つからない");
    return {
      ...row,
      keys: JSON.parse(row.keys),
      profile: JSON.parse(
        one("SELECT data FROM profiles WHERE user=?", id)?.data ?? "{}",
      ),
    };
  };
  function roomAccess(roomId: string, uid: string) {
    const r = one("SELECT * FROM rooms WHERE id=?", roomId);
    if (!r) return fail(404, "チャンネルが見つからない");
    if (
      r.guild
        ? !one("SELECT 1 FROM members WHERE guild=? AND user=?", r.guild, uid)
        : !one("SELECT 1 FROM peers WHERE room=? AND user=?", r.id, uid)
    )
      fail(403, "このチャンネルには参加できない");
    return r;
  }
  const members = (r: Row) =>
    r.guild
      ? all("SELECT user FROM members WHERE guild=?", r.guild).map(
          (x) => x.user,
        )
      : all("SELECT user FROM peers WHERE room=?", r.id).map((x) => x.user);
  function emitUsers(ids: string[], data: any) {
    const raw = JSON.stringify(data);
    for (const ws of sockets)
      if (ids.includes(ws.data.user) && sessionValid(ws.data)) ws.send(raw);
  }
  function changed(guild: string) {
    emitUsers(
      all("SELECT user FROM members WHERE guild=?", guild).map((x) => x.user),
      { type: "state" },
    );
  }
  function owner(guild: string, uid: string) {
    const g = one("SELECT * FROM guilds WHERE id=?", guild);
    if (!g || g.owner !== uid) return fail(403, "所有者のみ操作できる");
    return g;
  }
  async function json(req: Request, max = 300000) {
    if (!req.headers.get("content-type")?.startsWith("application/json"))
      return fail(415, "JSONが必要");
    const raw = await bounded(req, max);
    try {
      return JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return fail(400, "JSONが不正");
    }
  }
  async function bounded(req: Request, max: number) {
    if (Number(req.headers.get("content-length")) > max)
      return fail(413, "サイズ制限を超えている");
    const reader = req.body?.getReader();
    if (!reader) return new Uint8Array();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel();
        return fail(413, "サイズ制限を超えている");
      }
      chunks.push(value);
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) {
      result.set(c, offset);
      offset += c.length;
    }
    return result;
  }
  const text = (v: any, max = 100) => {
    if (typeof v !== "string" || !v.trim() || v.length > max)
      return fail(400, "入力値が不正");
    return v.trim();
  };
  async function publicKeys(keys: any) {
    try {
      if (Object.keys(keys).sort().join(",") !== "exchange,sign") throw 0;
      await crypto.subtle.importKey(
        "spki",
        Uint8Array.from(atob(keys.sign), (c) => c.charCodeAt(0)),
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      await crypto.subtle.importKey(
        "spki",
        Uint8Array.from(atob(keys.exchange), (c) => c.charCodeAt(0)),
        { name: "ECDH", namedCurve: "P-256" },
        false,
        [],
      );
    } catch {
      fail(400, "公開鍵が不正");
    }
  }
  async function validateEnvelope(e: any, r: Row, uid: string) {
    const h = e?.header;
    if (
      !h ||
      h.v !== 1 ||
      h.room !== r.id ||
      h.author !== uid ||
      !idPattern.test(h.id) ||
      !Number.isSafeInteger(h.at) ||
      Math.abs(Date.now() - h.at) > 300000
    )
      fail(400, "暗号化メッセージの形式が不正");
    if (
      r.guild &&
      h.version !==
        one("SELECT version FROM guilds WHERE id=?", r.guild)?.version
    )
      fail(409, "メンバーが変更された。更新して再送信して");
    if (
      canonical(Object.keys(e.boxes ?? {}).sort()) !==
      canonical(members(r).sort())
    )
      fail(409, "宛先が現在のメンバーと一致しない");
    const { signature, ...body } = e;
    if (!(await verify(body, signature, user(uid).keys)))
      fail(400, "署名の検証に失敗");
    // Signature verification yields; recheck authorization after it to close membership races.
    roomAccess(r.id, uid);
    if (
      r.guild &&
      h.version !==
        one("SELECT version FROM guilds WHERE id=?", r.guild)?.version
    )
      fail(409, "メンバーが変更された。更新して再送信して");
  }
  function state(uid: string) {
    const guilds = all(
      "SELECT g.* FROM guilds g JOIN members m ON m.guild=g.id WHERE m.user=?",
      uid,
    ).map((g) => ({
      ...g,
      roster: JSON.parse(g.roster),
      profile: JSON.parse(
        one("SELECT data FROM guild_profiles WHERE guild=?", g.id)?.data ??
          "{}",
      ),
      channels: all("SELECT * FROM rooms WHERE guild=? ORDER BY rowid", g.id),
      requests:
        g.owner === uid
          ? all("SELECT user FROM requests WHERE guild=?", g.id).map((x) =>
              user(x.user),
            )
          : [],
    }));
    const dms = all(
      "SELECT r.* FROM rooms r JOIN peers p ON p.room=r.id WHERE p.user=?",
      uid,
    ).map((r) => ({ ...r, id: r.id, users: members(r) }));
    const ids = new Set([
      uid,
      ...guilds.flatMap((g) => g.roster.members.map((m: any) => m.id)),
      ...dms.flatMap((r) => r.users),
    ]);
    return {
      me: user(uid),
      guilds,
      dms,
      users: [...ids].map(user),
      online: [
        ...new Set(
          [...sockets]
            .filter((s) => sessionValid(s.data))
            .map((s) => s.data.user),
        ),
      ].filter((id) => ids.has(id)),
      iceServers: JSON.parse(process.env.ICE_SERVERS ?? "[]"),
      voice: [...sockets]
        .filter((s) => s.data.voice && sessionValid(s.data))
        .map((s) => ({ room: s.data.voice, user: s.data.user }))
        .filter(
          (s) =>
            guilds.some((g) => g.channels.some((r: Row) => r.id === s.room)) ||
            dms.some((r) => r.id === s.room),
        ),
    };
  }
  const common = {
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "Permissions-Policy":
      "camera=(self), microphone=(self), display-capture=(self)",
    ...(secure
      ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" }
      : {}),
  };
  const response = (
    value: any,
    status = 200,
    headers: Record<string, string> = {},
  ) => Response.json(value, { status, headers: { ...common, ...headers } });
  function sessionResponse(uid: string) {
    const token =
      Bun.randomUUIDv7() +
      btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const expires = Date.now() + 7 * 86400000;
    run("INSERT INTO sessions VALUES(?,?,?)", sha(token), uid, expires);
    return response(
      {
        user: user(uid),
        vault: JSON.parse(
          one("SELECT vault FROM users WHERE id=?", uid)!.vault,
        ),
      },
      200,
      {
        "Set-Cookie": `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${secure ? "; Secure" : ""}`,
      },
    );
  }
  async function api(req: Request, url: URL, server: Bun.Server<WSData>) {
    const p = url.pathname,
      method = req.method,
      ip = server.requestIP(req)?.address ?? "unknown";
    if ((method !== "GET" && method !== "HEAD") || p === "/ws")
      if (req.headers.get("origin") !== origin) fail(403, "Originが一致しない");
    if (p === "/api/health") return response({ ok: true });
    if (p === "/api/auth/salt" && method === "GET") {
      limit("salt:" + ip, 30);
      const name = (url.searchParams.get("username") ?? "").toLowerCase();
      return response({
        salt:
          one("SELECT salt FROM users WHERE username=?", name)?.salt ??
          sha("unknown/" + name).slice(0, 44),
      });
    }
    if (p === "/api/auth/register" && method === "POST") {
      limit("register:" + ip, 5, 3600000);
      const b = await json(req);
      const username = text(b.username, 32).toLowerCase();
      if (
        !/^[a-z0-9_]{3,32}$/.test(username) ||
        !idPattern.test(b.id) ||
        typeof b.auth !== "string" ||
        b.auth.length !== 44 ||
        typeof b.salt !== "string" ||
        b.salt.length !== 44 ||
        !b.vault?.ct ||
        !b.vault?.iv
      )
        fail(400, "登録情報が不正");
      await publicKeys(b.keys);
      if (
        !(await verify({ id: b.id, username, keys: b.keys }, b.proof, b.keys))
      )
        fail(400, "鍵の所有証明が不正");
      const hash = await Bun.password.hash(b.auth, {
        algorithm: "argon2id",
        memoryCost: 65536,
        timeCost: 3,
      });
      try {
        run(
          "INSERT INTO users VALUES(?,?,?,?,?,?,?,?)",
          b.id,
          username,
          text(b.display, 40),
          b.salt,
          hash,
          JSON.stringify(b.vault),
          JSON.stringify(b.keys),
          Date.now(),
        );
      } catch {
        return fail(409, "ユーザー名は使用済み");
      }
      return sessionResponse(b.id);
    }
    if (p === "/api/auth/login" && method === "POST") {
      limit("login:" + ip, 12, 300000);
      const b = await json(req);
      const name = text(b.username, 32).toLowerCase();
      limit("account:" + name, 12, 300000);
      const u = one("SELECT * FROM users WHERE username=?", name);
      // Always perform a memory-hard verification to avoid cheap username timing probes.
      const verifier = u?.auth ?? dummyHash;
      if (
        typeof b.auth !== "string" ||
        b.auth.length !== 44 ||
        !(await Bun.password.verify(b.auth, verifier)) ||
        !u
      )
        fail(401, "ユーザー名またはパスワードが違う");
      return sessionResponse(u!.id);
    }
    const session = auth(req),
      uid = session.user;
    limit("api:" + uid, 180);
    if (
      p === "/ws" &&
      [...sockets].filter((s) => s.data.user === uid).length >= 4
    )
      fail(429, "接続できる端末は同時に4つまで");
    if (p === "/ws")
      return server.upgrade(req, {
        data: {
          user: uid,
          session: session.token,
          expires: session.expires,
          voice: null,
        },
      })
        ? undefined
        : response({ error: "WebSocket upgrade required" }, 400);
    if (p === "/api/auth/logout" && method === "POST") {
      run("DELETE FROM sessions WHERE token=?", session.token);
      for (const ws of sockets)
        if (ws.data.session === session.token) ws.close(4001, "Logged out");
      return response({ ok: true }, 200, {
        "Set-Cookie": `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`,
      });
    }
    if (p === "/api/state" && method === "GET") return response(state(uid));
    function avatarDescriptor(value: any) {
      if (value == null) return null;
      if (
        typeof value !== "object" ||
        !idPattern.test(value.id) ||
        typeof value.key !== "string" ||
        value.key.length !== 44 ||
        typeof value.iv !== "string" ||
        value.iv.length !== 16 ||
        typeof value.hash !== "string" ||
        value.hash.length !== 44 ||
        value.mime !== "image/webp" ||
        !Number.isInteger(value.size) ||
        value.size < 1 ||
        value.size > 65536
      )
        fail(400, "画像データが不正");
      return {
        id: value.id,
        key: value.key,
        iv: value.iv,
        hash: value.hash,
        mime: "image/webp",
        name: "avatar.webp",
        size: value.size,
      };
    }
    if (p === "/api/me" && method === "PATCH") {
      const b = await json(req),
        previous = user(uid),
        old = previous.profile;
      const profile = {
        bio:
          b.bio === undefined ? (old.bio ?? "") : String(b.bio).slice(0, 190),
        pronouns:
          b.pronouns === undefined
            ? (old.pronouns ?? "")
            : String(b.pronouns).slice(0, 40),
        status: b.status === undefined ? (old.status ?? "online") : b.status,
        bannerColor:
          b.bannerColor === undefined
            ? (old.bannerColor ?? "#8b7cf8")
            : b.bannerColor,
        avatar:
          b.avatar === undefined
            ? (old.avatar ?? null)
            : avatarDescriptor(b.avatar),
      };
      if (
        !["online", "idle", "dnd", "invisible"].includes(profile.status) ||
        !/^#[0-9a-fA-F]{6}$/.test(profile.bannerColor)
      )
        fail(400, "プロフィール設定が不正");
      db.transaction(() => {
        if (b.display !== undefined)
          run(
            "UPDATE users SET display=? WHERE id=?",
            text(b.display, 40),
            uid,
          );
        run(
          "INSERT INTO profiles VALUES(?,?) ON CONFLICT(user) DO UPDATE SET data=excluded.data",
          uid,
          JSON.stringify(profile),
        );
      })();
      emitUsers(contacts(uid), { type: "state" });
      return response({ ok: true });
    }
    if (p === "/api/sessions" && method === "GET")
      return response(
        all(
          "SELECT token,expires FROM sessions WHERE user=? AND expires>?",
          uid,
          Date.now(),
        ).map((s) => ({
          id: sha(s.token),
          expires: s.expires,
          current: s.token === session.token,
        })),
      );
    const sessionMatch = p.match(/^\/api\/sessions\/([a-f0-9]{64})$/);
    if (sessionMatch && method === "DELETE") {
      const target = all("SELECT token FROM sessions WHERE user=?", uid).find(
        (s) => sha(s.token) === sessionMatch[1],
      );
      if (!target) fail(404, "セッションが見つからない");
      if (target!.token === session.token)
        fail(400, "現在の端末はログアウトを使って");
      run("DELETE FROM sessions WHERE token=?", target!.token);
      for (const ws of sockets)
        if (ws.data.session === target!.token)
          ws.close(4001, "Session revoked");
      return response({ ok: true });
    }
    if (p === "/api/auth/password" && method === "POST") {
      limit("password:" + uid, 5, 300000);
      const b = await json(req),
        old = one("SELECT * FROM users WHERE id=?", uid)!;
      if (
        typeof b.oldAuth !== "string" ||
        !(await Bun.password.verify(b.oldAuth, old.auth))
      )
        fail(403, "現在のパスワードが違う");
      if (
        typeof b.auth !== "string" ||
        b.auth.length !== 44 ||
        typeof b.salt !== "string" ||
        b.salt.length !== 44 ||
        typeof b.vault?.iv !== "string" ||
        typeof b.vault?.ct !== "string" ||
        b.vault.ct.length > 10000
      )
        fail(400, "更新情報が不正");
      const proof = { user: uid, auth: b.auth, salt: b.salt, vault: b.vault };
      if (!(await verify(proof, b.signature, user(uid).keys)))
        fail(400, "署名が不正");
      const hash = await Bun.password.hash(b.auth, {
        algorithm: "argon2id",
        memoryCost: 65536,
        timeCost: 3,
      });
      db.transaction(() => {
        const result = run(
          "UPDATE users SET auth=?,salt=?,vault=? WHERE id=? AND auth=?",
          hash,
          b.salt,
          JSON.stringify(b.vault),
          uid,
          old.auth,
        );
        if (!result.changes) fail(409, "パスワード更新が競合した");
        run(
          "DELETE FROM sessions WHERE user=? AND token<>?",
          uid,
          session.token,
        );
      })();
      for (const ws of sockets)
        if (ws.data.user === uid && ws.data.session !== session.token)
          ws.close(4001, "Password changed");
      return response({ ok: true });
    }
    if (p === "/api/users" && method === "GET") {
      const u = one(
        "SELECT id FROM users WHERE username=?",
        (url.searchParams.get("username") ?? "").toLowerCase(),
      );
      if (!u) fail(404, "ユーザーが見つからない");
      return response(user(u!.id));
    }
    if (p === "/api/guilds" && method === "POST") {
      const b = await json(req),
        r = b.roster;
      if (
        !r ||
        !idPattern.test(r.guild) ||
        r.owner !== uid ||
        r.version !== 1 ||
        r.members?.length !== 1 ||
        r.members[0].id !== uid ||
        r.members[0].role !== "owner" ||
        canonical(r.members[0].keys) !== canonical(user(uid).keys) ||
        !(await verify(r, b.signature, user(uid).keys))
      )
        fail(400, "メンバー署名が不正");
      try {
        db.transaction(() => {
          run(
            "INSERT INTO guilds VALUES(?,?,?,?,?,?)",
            r.guild,
            uid,
            text(b.name, 60),
            JSON.stringify(r),
            b.signature,
            1,
          );
          run("INSERT INTO members VALUES(?,?,?)", r.guild, uid, "owner");
          run(
            "INSERT INTO rosters VALUES(?,?,?,?)",
            r.guild,
            1,
            JSON.stringify(r),
            b.signature,
          );
          for (const [name, kind] of [
            ["一般", "text"],
            ["ボイスラウンジ", "voice"],
          ])
            run(
              "INSERT INTO rooms VALUES(?,?,?,?)",
              uuid(),
              r.guild,
              kind,
              name,
            );
        })();
      } catch (e) {
        if (one("SELECT id FROM guilds WHERE owner=?", uid))
          fail(409, "作成できるサーバーは1人1個");
        throw e;
      }
      return response({ id: r.guild });
    }
    let m = p.match(/^\/api\/guilds\/([\w-]+)(?:\/(\w+))?$/);
    if (m) {
      const gid = m[1],
        action = m[2];
      if (action === "join" && method === "POST") {
        const b = await json(req);
        if (
          !one(
            "SELECT 1 FROM invites WHERE hash=? AND guild=? AND expires>?",
            sha(text(b.token, 100)),
            gid,
            Date.now(),
          )
        )
          fail(403, "招待が無効または期限切れ");
        if (!one("SELECT 1 FROM members WHERE guild=? AND user=?", gid, uid))
          run("INSERT OR IGNORE INTO requests VALUES(?,?)", gid, uid);
        const g = one("SELECT owner,name FROM guilds WHERE id=?", gid)!;
        emitUsers([g.owner], { type: "state" });
        return response({ name: g.name });
      }
      const g = owner(gid, uid);
      if (action === "invites" && method === "GET")
        return response(
          all(
            "SELECT hash AS id,expires FROM invites WHERE guild=? AND expires>?",
            gid,
            Date.now(),
          ),
        );
      if (action === "invites" && method === "POST") {
        const token = crypto.getRandomValues(new Uint8Array(32));
        const value = Buffer.from(token).toString("base64url");
        run(
          "INSERT INTO invites VALUES(?,?,?)",
          sha(value),
          gid,
          Date.now() + 86400000,
        );
        return response({ token: value });
      }
      if (action === "invites" && method === "DELETE") {
        run("DELETE FROM invites WHERE guild=?", gid);
        return response({ ok: true });
      }
      if (action === "roster" && method === "PUT") {
        const b = await json(req),
          r = b.roster;
        if (
          !r ||
          r.guild !== gid ||
          r.owner !== uid ||
          r.version !== g.version + 1 ||
          !Array.isArray(r.members) ||
          r.members.length > 100 ||
          !(await verify(r, b.signature, user(uid).keys))
        )
          fail(409, "メンバー更新署名またはバージョンが不正");
        const seen = new Set();
        for (const member of r.members) {
          if (
            seen.has(member.id) ||
            canonical(member.keys) !== canonical(user(member.id).keys) ||
            !["owner", "member"].includes(member.role) ||
            (member.id === uid) !== (member.role === "owner")
          )
            fail(400, "メンバー情報が不正");
          seen.add(member.id);
          if (
            !one(
              "SELECT 1 FROM members WHERE guild=? AND user=?",
              gid,
              member.id,
            ) &&
            !one(
              "SELECT 1 FROM requests WHERE guild=? AND user=?",
              gid,
              member.id,
            )
          )
            fail(403, "参加申請がない");
        }
        if (!seen.has(uid)) fail(400, "所有者は削除できない");
        if (
          one("SELECT version FROM guilds WHERE id=?", gid)?.version !==
          g.version
        )
          fail(409, "メンバー更新が競合した。更新して再試行して");
        const previous = all("SELECT user FROM members WHERE guild=?", gid).map(
          (x) => x.user,
        );
        db.transaction(() => {
          run("DELETE FROM members WHERE guild=?", gid);
          for (const member of r.members) {
            run(
              "INSERT INTO members VALUES(?,?,?)",
              gid,
              member.id,
              member.role,
            );
            run(
              "DELETE FROM requests WHERE guild=? AND user=?",
              gid,
              member.id,
            );
          }
          run(
            "UPDATE guilds SET roster=?,signature=?,version=? WHERE id=?",
            JSON.stringify(r),
            b.signature,
            r.version,
            gid,
          );
          run(
            "INSERT INTO rosters VALUES(?,?,?,?)",
            gid,
            r.version,
            JSON.stringify(r),
            b.signature,
          );
        })();
        for (const ws of sockets)
          if (
            ws.data.voice &&
            one("SELECT guild FROM rooms WHERE id=?", ws.data.voice)?.guild ===
              gid &&
            !seen.has(ws.data.user)
          )
            leaveVoice(ws);
        emitUsers([...new Set([...previous, ...seen] as string[])], {
          type: "state",
        });
        return response({ ok: true });
      }
      if (action === "reject" && method === "POST") {
        const b = await json(req);
        run("DELETE FROM requests WHERE guild=? AND user=?", gid, b.user);
        return response({ ok: true });
      }
      if (action === "channels" && method === "POST") {
        const b = await json(req);
        if (!["text", "voice"].includes(b.kind)) fail(400, "種類が不正");
        if (all("SELECT id FROM rooms WHERE guild=?", gid).length >= 100)
          fail(400, "チャンネル上限");
        const id = uuid();
        run(
          "INSERT INTO rooms VALUES(?,?,?,?)",
          id,
          gid,
          b.kind,
          text(b.name, 60),
        );
        changed(gid);
        return response({ id });
      }
      if (!action && method === "PATCH") {
        const b = await json(req);
        const old = JSON.parse(
          one("SELECT data FROM guild_profiles WHERE guild=?", gid)?.data ??
            "{}",
        );
        const profile = {
          description:
            b.description === undefined
              ? (old.description ?? "")
              : String(b.description).slice(0, 300),
          icon:
            b.icon === undefined
              ? (old.icon ?? null)
              : avatarDescriptor(b.icon),
          bannerColor:
            b.bannerColor === undefined
              ? (old.bannerColor ?? "#8b7cf8")
              : b.bannerColor,
        };
        if (!/^#[0-9a-fA-F]{6}$/.test(profile.bannerColor))
          fail(400, "カラーが不正");
        db.transaction(() => {
          if (b.name !== undefined)
            run("UPDATE guilds SET name=? WHERE id=?", text(b.name, 60), gid);
          run(
            "INSERT INTO guild_profiles VALUES(?,?) ON CONFLICT(guild) DO UPDATE SET data=excluded.data",
            gid,
            JSON.stringify(profile),
          );
        })();
        changed(gid);
        return response({ ok: true });
      }
      if (!action && method === "DELETE") {
        const ids = all("SELECT user FROM members WHERE guild=?", gid).map(
          (x) => x.user,
        );
        db.transaction(() => run("DELETE FROM guilds WHERE id=?", gid))();
        emitUsers(ids, { type: "state" });
        return response({ ok: true });
      }
    }
    if (p === "/api/dms" && method === "POST") {
      const b = await json(req);
      user(b.user);
      if (b.user === uid) fail(400, "自分宛てのDMは作成できない");
      const existing = one(
        "SELECT a.room FROM peers a JOIN peers b ON a.room=b.room WHERE a.user=? AND b.user=?",
        uid,
        b.user,
      );
      if (existing) return response({ id: existing.room });
      const id = uuid();
      db.transaction(() => {
        run("INSERT INTO rooms VALUES(?,NULL,?,?)", id, "dm", "DM");
        run("INSERT INTO peers VALUES(?,?)", id, uid);
        run("INSERT INTO peers VALUES(?,?)", id, b.user);
      })();
      emitUsers([uid, b.user], { type: "state" });
      return response({ id });
    }
    m = p.match(/^\/api\/rooms\/([\w-]+)(?:\/(events))?$/);
    if (m) {
      const r = roomAccess(m[1], uid);
      if (m[2] === "events" && method === "GET") {
        const after = Number(url.searchParams.get("after") ?? 0);
        if (!Number.isSafeInteger(after) || after < 0)
          fail(400, "カーソルが不正");
        return response(
          all(
            "SELECT * FROM events WHERE room=? AND seq>? ORDER BY seq LIMIT 100",
            r.id,
            after,
          ).map((e) => {
            const envelope = JSON.parse(e.envelope);
            const cert = r.guild
              ? one(
                  "SELECT roster,signature FROM rosters WHERE guild=? AND version=?",
                  r.guild,
                  envelope.header.version,
                )
              : null;
            return {
              ...e,
              envelope,
              authorUser: user(e.author),
              certificate: cert
                ? { roster: JSON.parse(cert.roster), signature: cert.signature }
                : null,
            };
          }),
        );
      }
      if (m[2] === "events" && method === "POST") {
        limit("send:" + uid, 60);
        const e = await json(req);
        await validateEnvelope(e, r, uid);
        try {
          run(
            "INSERT INTO events(id,room,author,envelope,created) VALUES(?,?,?,?,?)",
            e.header.id,
            r.id,
            uid,
            JSON.stringify(e),
            Date.now(),
          );
        } catch {
          fail(409, "送信済みのメッセージID");
        }
        const event = one("SELECT seq FROM events WHERE id=?", e.header.id)!;
        emitUsers(members(r), {
          type: "event",
          room: r.id,
          seq: event.seq,
          author: uid,
        });
        return response({ seq: event.seq });
      }
      if (!m[2] && ["PATCH", "DELETE"].includes(method)) {
        if (!r.guild) fail(403, "DMは変更できない");
        owner(r.guild, uid);
        if (method === "PATCH") {
          const b = await json(req);
          run("UPDATE rooms SET name=? WHERE id=?", text(b.name, 60), r.id);
        } else {
          run("DELETE FROM rooms WHERE id=?", r.id);
          for (const ws of sockets) if (ws.data.voice === r.id) leaveVoice(ws);
        }
        changed(r.guild);
        return response({ ok: true });
      }
    }
    if (p === "/api/files" && method === "POST") {
      limit("upload:" + uid, 8, 60000);
      if (req.headers.get("content-type") !== "application/octet-stream")
        fail(415, "暗号化バイナリが必要");
      const data = await bounded(req, 25 * 1024 * 1024 + 16);
      const form = new FormData();
      form.append("file", new Blob([data]), uuid() + ".enc");
      const result = await fetch(fileOrigin + "/upload", {
        method: "POST",
        body: form,
        redirect: "error",
        signal: AbortSignal.timeout(60000),
      });
      const out = (await result.json()) as Row;
      if (
        !result.ok ||
        out.Status !== "OK" ||
        !idPattern.test(out.FileID) ||
        typeof out.RemovePassword !== "string"
      )
        fail(502, "添付APIのアップロードに失敗");
      return response({ id: out.FileID, removePassword: out.RemovePassword });
    }
    m = p.match(/^\/api\/files\/([a-zA-Z0-9_-]+)$/);
    if (m && method === "GET") {
      limit("download:" + uid, 40);
      const upstream = await fetch(
        fileOrigin + "/download?id=" + encodeURIComponent(m[1]),
        { signal: AbortSignal.timeout(60000), redirect: "error" },
      );
      if (!upstream.ok) fail(502, "添付ファイルを取得できない");
      const data = await bounded(
        new Request(origin, {
          method: "POST",
          body: upstream.body,
          duplex: "half",
        } as RequestInit),
        25 * 1024 * 1024 + 16,
      );
      return new Response(data, {
        headers: { ...common, "Content-Type": "application/octet-stream" },
      });
    }
    if (m && method === "DELETE") {
      const b = await json(req);
      const u = new URL(fileOrigin + "/delete");
      u.searchParams.set("id", m[1]);
      u.searchParams.set("password", text(b.password, 256));
      const upstream = await fetch(u, {
        signal: AbortSignal.timeout(30000),
        redirect: "error",
      });
      if (!upstream.ok) fail(502, "削除APIに失敗");
      return response({ ok: true });
    }
    return fail(404, "APIが見つからない");
  }
  function leaveVoice(ws: Bun.ServerWebSocket<WSData>) {
    const room = ws.data.voice;
    ws.data.voice = null;
    if (room)
      try {
        emitUsers(members(one("SELECT * FROM rooms WHERE id=?", room)!), {
          type: "voice-left",
          room,
          user: ws.data.user,
        });
      } catch {}
  }
  function contacts(uid: string) {
    return [
      ...new Set(
        all(
          `SELECT b.user FROM members a JOIN members b ON a.guild=b.guild WHERE a.user=?
      UNION SELECT b.user FROM peers a JOIN peers b ON a.room=b.room WHERE a.user=?`,
          uid,
          uid,
        ).map((r) => r.user),
      ),
    ];
  }
  const dummyHash = Bun.password.hashSync("unmatchable-" + uuid(), {
    algorithm: "argon2id",
    memoryCost: 65536,
    timeCost: 3,
  });
  const server = Bun.serve<WSData>({
    port: options.port ?? Number(process.env.PORT ?? 3000),
    hostname: options.hostname ?? process.env.HOST ?? "127.0.0.1",
    maxRequestBodySize: 26 * 1024 * 1024,
    async fetch(req, server) {
      try {
        const url = new URL(req.url);
        if (url.pathname.startsWith("/api/") || url.pathname === "/ws")
          return await api(req, url, server);
        if (req.method !== "GET" && req.method !== "HEAD")
          return response({ error: "Method not allowed" }, 405);
        const allowed: Record<string, string> = {
          "/": "index.html",
          "/app.js": "app.js",
          "/crypto.js": "crypto.js",
          "/icons.js": "icons.js",
          "/preferences.js": "preferences.js",
          "/settings.js": "settings.js",
          "/style.css": "style.css",
          "/icon.svg": "icon.svg",
          "/manifest.webmanifest": "manifest.webmanifest",
        };
        const file = allowed[url.pathname];
        if (!file) return response({ error: "Not found" }, 404);
        return new Response(
          Bun.file(resolve(import.meta.dir, "../public", file)),
          { headers: common },
        );
      } catch (e) {
        if (!(e instanceof HttpError))
          console.error(
            "request failed",
            e instanceof Error ? e.message : "unknown",
          );
        return response(
          { error: e instanceof HttpError ? e.message : "サーバー処理に失敗" },
          e instanceof HttpError ? e.status : 500,
        );
      }
    },
    websocket: {
      maxPayloadLength: 300000,
      idleTimeout: 120,
      backpressureLimit: 1024 * 1024,
      closeOnBackpressureLimit: true,
      open(ws) {
        sockets.add(ws);
        ws.send(JSON.stringify({ type: "ready" }));
        emitUsers(contacts(ws.data.user), {
          type: "presence",
          user: ws.data.user,
          online: true,
        });
      },
      close(ws) {
        leaveVoice(ws);
        sockets.delete(ws);
        if (
          ![...sockets].some(
            (s) => s.data.user === ws.data.user && sessionValid(s.data),
          )
        )
          emitUsers(contacts(ws.data.user), {
            type: "presence",
            user: ws.data.user,
            online: false,
          });
      },
      async message(ws, raw) {
        try {
          if (!sessionValid(ws.data)) {
            ws.close(4001);
            return;
          }
          limit("ws:" + ws.data.user, 120);
          const m = JSON.parse(String(raw));
          if (m.type === "ping") {
            ws.send(JSON.stringify({ type: "pong" }));
            return;
          }
          if (m.type === "leave-voice") {
            leaveVoice(ws);
            return;
          }
          const r = roomAccess(m.room, ws.data.user);
          if (m.type === "join-voice") {
            if (!["voice", "dm"].includes(r.kind))
              fail(400, "音声チャンネルではない");
            for (const other of sockets)
              if (
                other !== ws &&
                other.data.user === ws.data.user &&
                other.data.voice
              ) {
                leaveVoice(other);
                other.send(JSON.stringify({ type: "voice-replaced" }));
              }
            const peers = [...sockets].filter(
              (s) => s.data.voice === r.id && s !== ws && sessionValid(s.data),
            );
            if (peers.length >= 5) fail(409, "音声通話は最大6接続");
            leaveVoice(ws);
            ws.data.voice = r.id;
            emitUsers(members(r), {
              type: "voice-presence",
              room: r.id,
              users: [
                ...new Set(
                  [...sockets]
                    .filter(
                      (s) => s.data.voice === r.id && sessionValid(s.data),
                    )
                    .map((s) => s.data.user),
                ),
              ],
            });
            ws.send(
              JSON.stringify({
                type: "voice-peers",
                room: r.id,
                users: peers.map((s) => s.data.user),
              }),
            );
            return;
          }
          if (m.type === "signal") {
            if (ws.data.voice !== r.id)
              fail(403, "音声チャンネルに参加していない");
            await validateEnvelope(m.envelope, r, ws.data.user);
            emitUsers(
              [...sockets]
                .filter((s) => s.data.voice === r.id && s !== ws)
                .map((s) => s.data.user),
              { type: "signal", room: r.id, envelope: m.envelope },
            );
            return;
          }
          if (m.type === "typing")
            emitUsers(
              members(r).filter((x) => x !== ws.data.user),
              { type: "typing", room: r.id, user: ws.data.user },
            );
        } catch (e) {
          ws.send(
            JSON.stringify({
              type: "error",
              message:
                e instanceof HttpError ? e.message : "WebSocket処理に失敗",
            }),
          );
        }
      },
    },
  });
  return {
    server,
    db,
    stop() {
      clearInterval(maintenance);
      server.stop(true);
      db.close();
    },
  };
}
if (import.meta.main) {
  const app = createApp();
  console.log(
    `Oisiicord: ${process.env.APP_ORIGIN ?? "http://localhost:3000"} (port ${app.server.port})`,
  );
}
