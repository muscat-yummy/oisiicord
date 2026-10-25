import { canonical, digest, verify } from "../public/crypto.js";
import {
  validGrant,
  verifyGrant,
  verifyAdmission,
} from "../public/membership.js";
type Row = Record<string, any>;
export const INVITATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS invitation_grants(id TEXT PRIMARY KEY,guild TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,grant_data TEXT NOT NULL,signature TEXT NOT NULL,snapshot TEXT NOT NULL,uses INTEGER NOT NULL DEFAULT 0,revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS guild_admissions(guild TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,user TEXT NOT NULL REFERENCES users(id),record TEXT NOT NULL,PRIMARY KEY(guild,user));
CREATE TABLE IF NOT EXISTS membership_certificates(guild TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,version INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(guild,version));
CREATE TABLE IF NOT EXISTS history_credentials(guild TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,user TEXT NOT NULL REFERENCES users(id),invite TEXT NOT NULL,envelope TEXT NOT NULL,PRIMARY KEY(guild,user,invite));
CREATE TABLE IF NOT EXISTS guild_membership_changes(guild TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,seq INTEGER NOT NULL,record TEXT NOT NULL,PRIMARY KEY(guild,seq));
CREATE INDEX IF NOT EXISTS invitation_grants_guild ON invitation_grants(guild);`;
type Context = {
  db: any;
  one: (sql: string, ...args: any[]) => Row | undefined;
  all: (sql: string, ...args: any[]) => Row[];
  run: (sql: string, ...args: any[]) => any;
  json: (req: Request, max?: number) => Promise<any>;
  response: (value: any, status?: number) => Response;
  fail: (status: number, message: string) => never;
  changed: (guild: string) => void;
  audit: (guild: string, uid: string, action: string, target?: string) => void;
  user: (uid: string) => Row;
  ensureMembershipLimit?: (uid: string) => void;
};
export function createInvitations(ctx: Context) {
  const { db, one, all, run, json, response, fail, changed, audit, user } = ctx;
  function member(guild: string, uid: string) {
    if (!one("SELECT 1 FROM members WHERE guild=? AND user=?", guild, uid))
      return fail(403, "このサーバーには参加できない");
    return one("SELECT * FROM guilds WHERE id=?", guild)!;
  }
  function owner(guild: string, uid: string) {
    const g = one("SELECT * FROM guilds WHERE id=?", guild);
    if (!g || g.owner !== uid) return fail(403, "所有者のみ操作できる");
    return g;
  }
  function certificate(guild: string, version?: number): any {
    const g = one("SELECT * FROM guilds WHERE id=?", guild);
    if (!g) return fail(404, "サーバーがない");
    const epoch = version ?? g.version;
    const stored = one(
      "SELECT data FROM membership_certificates WHERE guild=? AND version=?",
      guild,
      epoch,
    );
    if (stored) return JSON.parse(stored.data);
    const historical = one(
      "SELECT roster,signature FROM rosters WHERE guild=? AND version=?",
      guild,
      epoch,
    );
    if (!historical) return fail(404, "メンバー証明がない");
    return {
      baseRoster: JSON.parse(historical.roster),
      signature: historical.signature,
      admissions: [],
      version: epoch,
    };
  }
  function saveCertificate(guild: string) {
    const g = one("SELECT * FROM guilds WHERE id=?", guild)!;
    const data = {
      baseRoster: JSON.parse(g.roster),
      signature: g.signature,
      admissions: all(
        "SELECT record FROM guild_admissions WHERE guild=? ORDER BY rowid",
        guild,
      ).map((r) => JSON.parse(r.record)),
      changes: all(
        "SELECT record FROM guild_membership_changes WHERE guild=? ORDER BY seq",
        guild,
      ).map((r) => JSON.parse(r.record)),
      version: g.version,
    };
    run(
      "INSERT INTO membership_certificates VALUES(?,?,?) ON CONFLICT(guild,version) DO UPDATE SET data=excluded.data",
      guild,
      g.version,
      JSON.stringify(data),
    );
    return data;
  }
  function appendChange(guild: string, record: any) {
    const g = one("SELECT * FROM guilds WHERE id=?", guild)!;
    const version = g.version + 1;
    run(
      "INSERT INTO guild_membership_changes VALUES(?,?,?)",
      guild,
      version,
      JSON.stringify(record),
    );
    run("UPDATE guilds SET version=? WHERE id=?", version, guild);
    run(
      "INSERT INTO rosters VALUES(?,?,?,?)",
      guild,
      version,
      g.roster,
      g.signature,
    );
    saveCertificate(guild);
  }
  function rosterChanged(guild: string) {
    run("DELETE FROM guild_admissions WHERE guild=?", guild);
    run("DELETE FROM guild_membership_changes WHERE guild=?", guild);
    run("UPDATE invitation_grants SET revoked=1 WHERE guild=?", guild);
    saveCertificate(guild);
  }
  function state(guild: string) {
    const now = Date.now();
    const activeInvites = all(
      "SELECT grant_data,signature FROM invitation_grants WHERE guild=? AND revoked=0",
      guild,
    )
      .map((row) => ({
        grant: JSON.parse(row.grant_data),
        signature: row.signature,
      }))
      .filter((row) => row.grant.expires === null || row.grant.expires > now);
    return { certificate: certificate(guild), activeInvites };
  }
  function usable(id: string): Row & { grant: any; g: Row } {
    const row = one(
      "SELECT * FROM invitation_grants WHERE id=? AND revoked=0",
      id,
    );
    if (!row) return fail(403, "招待が無効または期限切れ");
    const grant = JSON.parse(row.grant_data),
      g = one("SELECT * FROM guilds WHERE id=?", row.guild);
    if (
      !g ||
      (grant.expires !== null && grant.expires <= Date.now()) ||
      JSON.parse(g.roster).version !== grant.baseVersion
    )
      return fail(403, "招待が無効または期限切れ");
    return { ...row, grant, g };
  }
  function object(body: any) {
    if (!body || typeof body !== "object" || Array.isArray(body))
      return fail(400, "入力値が不正");
    return body;
  }
  async function handle(
    req: Request,
    url: URL,
    uid: string,
  ): Promise<Response | undefined> {
    const path = url.pathname,
      method = req.method;
    let match = path.match(
      /^\/api\/guilds\/([\w-]+)\/invitations(?:\/([\w-]+))?$/,
    );
    if (match) {
      const guild = match[1],
        id = match[2],
        g = owner(guild, uid);
      if (!id && method === "GET")
        return response(
          all(
            "SELECT id,grant_data,uses FROM invitation_grants WHERE guild=? AND revoked=0 ORDER BY rowid DESC",
            guild,
          ).map((row) => {
            const grant = JSON.parse(row.grant_data);
            return {
              id: row.id,
              expires: grant.expires,
              maxUses: grant.maxUses,
              uses: row.uses,
              approval: grant.approval,
            };
          }),
        );
      if (!id && method === "POST") {
        const body = object(await json(req, 8 * 1024 * 1024)),
          grant = body.grant;
        if (
          !validGrant(grant) ||
          grant.guild !== guild ||
          grant.owner !== uid ||
          grant.baseVersion !== JSON.parse(g.roster).version ||
          Math.abs(grant.created - Date.now()) > 300000 ||
          !(await verifyGrant(grant, body.signature, user(uid).keys)) ||
          !body.snapshot?.iv ||
          !body.snapshot?.ct ||
          (await digest(canonical(body.snapshot))) !== grant.historyHash
        )
          return fail(400, "招待の署名または履歴が不正");
        db.transaction(() => {
          const latest = owner(guild, uid);
          if (JSON.parse(latest.roster).version !== grant.baseVersion)
            return fail(409, "メンバーが変更された。更新して再試行して");
          if (
            (one(
              "SELECT COUNT(*) AS n FROM invitation_grants WHERE guild=? AND revoked=0",
              guild,
            )?.n ?? 0) >= 100
          )
            return fail(400, "招待リンクは100件までです");
          run(
            "INSERT INTO invitation_grants(id,guild,grant_data,signature,snapshot) VALUES(?,?,?,?,?)",
            grant.id,
            guild,
            JSON.stringify(grant),
            body.signature,
            JSON.stringify(body.snapshot),
          );
          audit(guild, uid, "invite.create");
        })();
        changed(guild);
        return response({ id: grant.id });
      }
      if (method === "DELETE") {
        db.transaction(() => {
          owner(guild, uid);
          if (
            id &&
            !one(
              "SELECT 1 FROM invitation_grants WHERE id=? AND guild=? AND revoked=0",
              id,
              guild,
            )
          )
            return fail(404, "招待がない");
          if (id)
            run(
              "UPDATE invitation_grants SET revoked=1 WHERE id=? AND guild=?",
              id,
              guild,
            );
          else
            run("UPDATE invitation_grants SET revoked=1 WHERE guild=?", guild);
          audit(guild, uid, id ? "invite.revoke" : "invite.revokeAll");
        })();
        changed(guild);
        return response({ ok: true });
      }
    }
    match = path.match(/^\/api\/invitations\/([\w-]+)(?:\/(join))?$/);
    if (match) {
      const id = match[1],
        row = usable(id),
        grant = row.grant;
      if (!match[2] && method === "GET")
        return response({
          guild: {
            id: row.guild,
            name: row.g.name,
            owner: row.g.owner,
            keys: user(row.g.owner).keys,
          },
          grant,
          signature: row.signature,
          snapshot: JSON.parse(row.snapshot),
        });
      if (match[2] === "join" && method === "POST") {
        const body = object(await json(req)),
          record = {
            grant,
            grantSignature: row.signature,
            admission: body.admission,
            signature: body.signature,
          };
        if (
          body.admission?.user !== uid ||
          canonical(body.admission.keys) !== canonical(user(uid).keys) ||
          Math.abs((body.admission?.at ?? 0) - Date.now()) > 300000 ||
          !(await verifyAdmission(record))
        )
          return fail(400, "参加証明が不正");
        let approval = grant.approval,
          already = false;
        db.transaction(() => {
          const current = usable(id);
          if (
            one(
              "SELECT 1 FROM members WHERE guild=? AND user=?",
              row.guild,
              uid,
            )
          ) {
            already = true;
            approval = false;
            return;
          }
          if (
            one(
              "SELECT 1 FROM requests WHERE guild=? AND user=?",
              row.guild,
              uid,
            )
          ) {
            approval = true;
            return;
          }
          if (grant.maxUses && current.uses >= grant.maxUses)
            return fail(403, "招待の利用回数が上限に達した");
          if (ctx.ensureMembershipLimit) ctx.ensureMembershipLimit(uid);
          else if (
            (one("SELECT COUNT(*) AS n FROM members WHERE user=?", uid)?.n ??
              0) >= 30
          )
            return fail(409, "参加できるサーバーは30個までです");
          if (
            (one("SELECT COUNT(*) AS n FROM members WHERE guild=?", row.guild)
              ?.n ?? 0) >= 100
          )
            return fail(409, "メンバーは100人までです");
          run("UPDATE invitation_grants SET uses=uses+1 WHERE id=?", id);
          if (approval) run("INSERT INTO requests VALUES(?,?)", row.guild, uid);
          else {
            run("INSERT INTO members VALUES(?,?,?)", row.guild, uid, "member");
            appendChange(row.guild, { type: "admission", record });
            audit(row.guild, uid, "member.join", user(uid).display);
          }
        })();
        changed(row.guild);
        return response({
          guild: row.guild,
          approval,
          pending: approval,
          already,
          name: row.g.name,
        });
      }
    }
    match = path.match(/^\/api\/guilds\/([\w-]+)\/history-credentials$/);
    if (match) {
      const guild = match[1];
      if (method === "GET") {
        member(guild, uid);
        return response(
          all(
            "SELECT envelope FROM history_credentials WHERE guild=? AND user=?",
            guild,
            uid,
          ).map((row) => JSON.parse(row.envelope)),
        );
      }
      if (method === "POST") {
        const authorize = () => {
          if (
            !one(
              "SELECT 1 FROM members WHERE guild=? AND user=?",
              guild,
              uid,
            ) &&
            !one("SELECT 1 FROM requests WHERE guild=? AND user=?", guild, uid)
          )
            return fail(403, "このサーバーには参加できない");
        };
        authorize();
        const body = object(await json(req, 8 * 1024 * 1024)),
          envelope = body.envelope;
        if (
          typeof body.invite !== "string" ||
          !one(
            "SELECT 1 FROM invitation_grants WHERE id=? AND guild=?",
            body.invite,
            guild,
          ) ||
          envelope?.header?.room !== "history:" + guild ||
          envelope.header.author !== uid ||
          canonical(Object.keys(envelope.boxes ?? {})) !== canonical([uid])
        )
          return fail(400, "履歴の鍵が不正");
        const { signature, ...payload } = envelope;
        if (!(await verify(payload, signature, user(uid).keys)))
          return fail(400, "履歴の署名が不正");
        authorize();
        run(
          "INSERT INTO history_credentials VALUES(?,?,?,?) ON CONFLICT(guild,user,invite) DO UPDATE SET envelope=excluded.envelope",
          guild,
          uid,
          body.invite,
          JSON.stringify(envelope),
        );
        return response({ ok: true });
      }
    }
  }
  return { handle, state, certificate, rosterChanged, appendChange };
}
