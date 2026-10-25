import { canonical, verify } from "../public/crypto.js";
import { verifyDeparture } from "../public/membership.js";
export const LIFECYCLE_SCHEMA = `
CREATE TABLE IF NOT EXISTS user_blocks(owner TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,target TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,created INTEGER NOT NULL,PRIMARY KEY(owner,target));
CREATE INDEX IF NOT EXISTS user_blocks_target ON user_blocks(target,owner);
CREATE TABLE IF NOT EXISTS deleted_accounts(user TEXT PRIMARY KEY REFERENCES users(id),deleted INTEGER NOT NULL);
`;
type Row = Record<string, any>;
type Context = {
  db: any;
  one: (sql: string, ...args: any[]) => Row | undefined;
  all: (sql: string, ...args: any[]) => Row[];
  run: (sql: string, ...args: any[]) => any;
  json: (req: Request) => Promise<any>;
  response: (
    body: any,
    status?: number,
    headers?: Record<string, string>,
  ) => Response;
  fail: (status: number, message: string) => never;
  user: (id: string) => Row;
  changed: (guild: string) => void;
  audit: (
    guild: string,
    actor: string,
    action: string,
    target?: string,
  ) => void;
  invitations: { appendChange: (guild: string, record: any) => void };
  removeRoles: (guild: string, user: string) => void;
  emit: (ids: string[], data: any) => void;
  disconnect: (user: string, guild?: string) => void;
  cookieName: string;
  secure: boolean;
};
export function createLifecycle(ctx: Context) {
  const { db, one, all, run, json, response, fail, user } = ctx;
  const deleted = (id: string) =>
    !!one("SELECT 1 FROM deleted_accounts WHERE user=?", id);
  const blocked = (a: string, b: string) =>
    !!one(
      "SELECT 1 FROM user_blocks WHERE (owner=? AND target=?) OR (owner=? AND target=?)",
      a,
      b,
      b,
      a,
    );
  function state(id: string) {
    return {
      blockedUsers: all("SELECT target FROM user_blocks WHERE owner=?", id).map(
        (r) => user(r.target),
      ),
      blockedContacts: all(
        "SELECT target AS id FROM user_blocks WHERE owner=? UNION SELECT owner AS id FROM user_blocks WHERE target=?",
        id,
        id,
      ).map((r) => r.id),
      unavailableDMs: all(
        "SELECT p.room FROM peers p JOIN peers other ON other.room=p.room WHERE p.user=? AND other.user<>?",
        id,
        id,
      )
        .filter((r) => {
          const other = one(
            "SELECT user FROM peers WHERE room=? AND user<>?",
            r.room,
            id,
          )!;
          return deleted(other.user) || blocked(id, other.user);
        })
        .map((r) => r.room),
    };
  }
  function canContact(a: string, b: string) {
    if (deleted(a) || deleted(b) || blocked(a, b))
      fail(403, "このユーザーには送信できません");
  }
  function assertDM(room: any, id: string) {
    if (room.guild) return;
    for (const p of all(
      "SELECT user FROM peers WHERE room=? AND user<>?",
      room.id,
      id,
    ))
      canContact(id, p.user);
  }
  function membership(guild: string, id: string) {
    const g = one(
      "SELECT g.* FROM guilds g JOIN members m ON m.guild=g.id WHERE g.id=? AND m.user=?",
      guild,
      id,
    );
    if (!g) return fail(403, "このサーバーには参加していません");
    if (g.owner === id)
      fail(409, "所有者はサーバーを削除してから退出してください");
    return g;
  }
  async function validateLeave(guild: string, id: string, record: any) {
    const g = membership(guild, id);
    if (
      !record ||
      record.proof?.user !== id ||
      Math.abs(Date.now() - (record.proof?.at ?? 0)) > 300000 ||
      !(await verifyDeparture(
        record.proof,
        record.signature,
        user(id).keys,
        JSON.parse(g.roster),
      ))
    )
      fail(400, "退出の署名が不正です");
  }
  function applyLeave(guild: string, id: string, record: any) {
    const g = membership(guild, id);
    if (JSON.parse(g.roster).version !== record.proof.baseVersion)
      fail(409, "メンバーが変更されました。再試行してください");
    run("DELETE FROM members WHERE guild=? AND user=?", guild, id);
    run("DELETE FROM requests WHERE guild=? AND user=?", guild, id);
    run("DELETE FROM history_credentials WHERE guild=? AND user=?", guild, id);
    ctx.removeRoles(guild, id);
    // A departing member may still possess invite secrets: stop all old history-key deliveries.
    run("UPDATE invitation_grants SET revoked=1 WHERE guild=?", guild);
    run("DELETE FROM invites WHERE guild=?", guild);
    ctx.invitations.appendChange(guild, {
      type: "departure",
      proof: record.proof,
      signature: record.signature,
    });
    ctx.audit(guild, id, "member.leave", user(id).display);
  }
  async function handle(
    req: Request,
    url: URL,
    id: string,
  ): Promise<Response | undefined> {
    const method = req.method,
      path = url.pathname;
    if (path === "/api/blocks" && method === "GET")
      return response(state(id).blockedUsers);
    const block = path.match(/^\/api\/blocks\/([\w-]+)$/);
    if (block && ["PUT", "DELETE"].includes(method)) {
      const target = block[1];
      user(target);
      if (target === id || deleted(target))
        fail(400, "このユーザーはブロックできません");
      if (method === "PUT")
        run(
          "INSERT INTO user_blocks VALUES(?,?,?) ON CONFLICT(owner,target) DO NOTHING",
          id,
          target,
          Date.now(),
        );
      else
        run("DELETE FROM user_blocks WHERE owner=? AND target=?", id, target);
      ctx.emit([id, target], { type: "state" });
      return response({ ok: true });
    }
    const leave = path.match(/^\/api\/guilds\/([\w-]+)\/leave$/);
    if (leave && method === "POST") {
      const record = await json(req);
      await validateLeave(leave[1], id, record);
      db.transaction(() => applyLeave(leave[1], id, record))();
      ctx.disconnect(id, leave[1]);
      ctx.changed(leave[1]);
      ctx.emit([id], { type: "state" });
      return response({ ok: true });
    }
    if (path === "/api/me" && method === "DELETE") {
      const b = await json(req);
      if (!b || typeof b !== "object" || Array.isArray(b))
        fail(400, "入力値が不正です");
      const account = one("SELECT * FROM users WHERE id=?", id)!;
      if (
        typeof b.auth !== "string" ||
        b.auth.length !== 44 ||
        !(await Bun.password.verify(b.auth, account.auth))
      )
        fail(401, "パスワードが違います");
      const proof = b.proof;
      if (
        !proof ||
        proof.v !== 1 ||
        proof.type !== "delete-account" ||
        proof.user !== id ||
        !Number.isSafeInteger(proof.at) ||
        Math.abs(Date.now() - proof.at) > 300000 ||
        !Array.isArray(proof.owned) ||
        !Array.isArray(proof.departures) ||
        !(await verify(proof, b.signature, user(id).keys))
      )
        fail(400, "アカウント削除の署名が不正です");
      const owned = all(
        "SELECT id FROM guilds WHERE owner=? ORDER BY id",
        id,
      ).map((r) => r.id);
      const joined = all(
        "SELECT g.id FROM guilds g JOIN members m ON m.guild=g.id WHERE m.user=? AND g.owner<>? ORDER BY g.id",
        id,
        id,
      ).map((r) => r.id);
      if (
        canonical(proof.owned) !== canonical(owned) ||
        canonical(proof.departures.map((r: any) => r.proof?.guild).sort()) !==
          canonical(joined)
      )
        fail(409, "所属サーバーが変更されました。再試行してください");
      for (const record of proof.departures)
        await validateLeave(record.proof.guild, id, record);
      const affected = new Set<string>([id]);
      for (const r of all(
        "SELECT DISTINCT b.user FROM peers a JOIN peers b ON a.room=b.room WHERE a.user=?",
        id,
      ))
        affected.add(r.user);
      for (const gid of [...owned, ...joined])
        for (const r of all("SELECT user FROM members WHERE guild=?", gid))
          affected.add(r.user);
      db.transaction(() => {
        if (
          one("SELECT auth FROM users WHERE id=?", id)?.auth !== account.auth ||
          canonical(
            all("SELECT id FROM guilds WHERE owner=? ORDER BY id", id).map(
              (r) => r.id,
            ),
          ) !== canonical(owned) ||
          canonical(
            all(
              "SELECT g.id FROM guilds g JOIN members m ON m.guild=g.id WHERE m.user=? AND g.owner<>? ORDER BY g.id",
              id,
              id,
            ).map((r) => r.id),
          ) !== canonical(joined)
        )
          fail(409, "アカウント情報が変更されました。再試行してください");
        for (const record of proof.departures)
          applyLeave(record.proof.guild, id, record);
        for (const gid of owned) run("DELETE FROM guilds WHERE id=?", gid);
        run("DELETE FROM requests WHERE user=?", id);
        run("DELETE FROM history_credentials WHERE user=?", id);
        run("DELETE FROM profiles WHERE user=?", id);
        run("DELETE FROM user_blocks WHERE owner=? OR target=?", id, id);
        run("DELETE FROM sessions WHERE user=?", id);
        run(
          "UPDATE users SET username=?,display=?,salt=?,auth=?,vault=? WHERE id=?",
          "deleted_" + crypto.randomUUID().replaceAll("-", "").slice(0, 24),
          "削除されたユーザー",
          "",
          "!deleted",
          "{}",
          id,
        );
        run("INSERT INTO deleted_accounts VALUES(?,?)", id, Date.now());
      })();
      ctx.disconnect(id);
      for (const gid of owned) ctx.disconnect("", gid);
      ctx.emit([...affected], { type: "state" });
      return response({ ok: true }, 200, {
        "Set-Cookie": `${ctx.cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${ctx.secure ? "; Secure" : ""}`,
      });
    }
  }
  return { handle, state, blocked, deleted, canContact, assertDM };
}
