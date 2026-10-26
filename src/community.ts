import type { Database } from "bun:sqlite";
type Row = Record<string, any>;
export const COMMUNITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS community_roles(id TEXT PRIMARY KEY,guild TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,name TEXT NOT NULL,color TEXT NOT NULL,position INTEGER NOT NULL,permissions TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS community_roles_guild ON community_roles(guild,position);
CREATE TABLE IF NOT EXISTS community_member_roles(guild TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,role TEXT NOT NULL REFERENCES community_roles(id) ON DELETE CASCADE,PRIMARY KEY(guild,user,role));
CREATE TABLE IF NOT EXISTS community_categories(id TEXT PRIMARY KEY,guild TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,name TEXT NOT NULL,position INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS community_channel_meta(room TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,category TEXT REFERENCES community_categories(id) ON DELETE SET NULL,slowmode INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS community_emojis(id TEXT PRIMARY KEY,guild TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,name TEXT NOT NULL COLLATE NOCASE,image TEXT NOT NULL,created INTEGER NOT NULL,UNIQUE(guild,name));
CREATE TABLE IF NOT EXISTS community_rules(guild TEXT PRIMARY KEY REFERENCES guilds(id) ON DELETE CASCADE,channel TEXT REFERENCES rooms(id) ON DELETE SET NULL,require_acceptance INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS community_rules_acceptance(guild TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,version INTEGER NOT NULL,accepted INTEGER NOT NULL,PRIMARY KEY(guild,user));
`;
export const communityPermissions = [
  "administrator",
  "manageChannels",
  "manageMessages",
  "manageEmojis",
  "manageRoles",
  "sendMessages",
  "connect",
] as const;
export type CommunityPermission = (typeof communityPermissions)[number];
type Context = {
  userLimit?: (user: string) => number;
  guildLimits?: (guild: string) => { emojiLimit: number };
  db: Database;
  one: (sql: string, ...args: any[]) => Row | undefined;
  all: (sql: string, ...args: any[]) => Row[];
  run: (sql: string, ...args: any[]) => unknown;
  json: (req: Request, max?: number) => Promise<any>;
  response: (value: any, status?: number) => Response;
  fail: (status: number, message: string) => never;
  text: (value: any, max?: number) => string;
  changed: (guild: string) => void;
  audit: (guild: string, user: string, action: string, target?: string) => void;
};
export function createCommunity(ctx: Context) {
  const { db, one, all, run, json, response, fail, text, changed, audit } = ctx;
  const uuid = () => crypto.randomUUID(),
    defaultId = (guild: string) => "everyone-" + guild;
  function guildInfo(guild: string) {
    return (
      one("SELECT * FROM guilds WHERE id=?", guild) ??
      fail(404, "サーバーがない")
    );
  }
  function isMember(guild: string, user: string) {
    return !!one("SELECT 1 FROM members WHERE guild=? AND user=?", guild, user);
  }
  function member(guild: string, user: string) {
    const g = guildInfo(guild);
    if (!isMember(guild, user))
      return fail(403, "このサーバーには参加できない");
    return g;
  }
  function owner(guild: string, user: string) {
    const g = member(guild, user);
    if (g.owner !== user) return fail(403, "所有者のみ操作できる");
    return g;
  }
  function ensureDefault(guild: string) {
    guildInfo(guild);
    run(
      "INSERT OR IGNORE INTO community_roles VALUES(?,?,?,?,?,?)",
      defaultId(guild),
      guild,
      "@everyone",
      "#949ba4",
      0,
      JSON.stringify(["sendMessages", "connect"]),
    );
  }
  function roles(guild: string): Row[] {
    ensureDefault(guild);
    return all(
      "SELECT * FROM community_roles WHERE guild=? ORDER BY position,id",
      guild,
    ).map((r) => ({
      ...r,
      permissions: JSON.parse(r.permissions),
      isDefault: r.id === defaultId(guild),
    }));
  }
  function permissions(guild: string, user: string) {
    const result: Record<string, boolean> = Object.fromEntries(
      communityPermissions.map((p) => [p, false]),
    );
    const g = guildInfo(guild);
    if (!isMember(guild, user)) return result;
    if (g.owner === user)
      return Object.fromEntries(communityPermissions.map((p) => [p, true]));
    ensureDefault(guild);
    const selected = all(
      "SELECT r.permissions FROM community_roles r WHERE r.guild=? AND (r.id=? OR EXISTS(SELECT 1 FROM community_member_roles a WHERE a.guild=r.guild AND a.role=r.id AND a.user=?))",
      guild,
      defaultId(guild),
      user,
    );
    for (const r of selected)
      for (const p of JSON.parse(r.permissions))
        if (communityPermissions.includes(p)) result[p] = true;
    if (result.administrator)
      for (const p of communityPermissions) result[p] = true;
    return result;
  }
  function can(guild: string, user: string, permission: CommunityPermission) {
    return !!permissions(guild, user)[permission];
  }
  function requirePermission(
    guild: string,
    user: string,
    permission: CommunityPermission,
  ) {
    member(guild, user);
    if (!can(guild, user, permission))
      return fail(403, "この操作を行う権限がない");
  }
  function ruleConfig(guild: string) {
    const row = one("SELECT * FROM community_rules WHERE guild=?", guild);
    return {
      channel: row?.channel ?? null,
      requireAcceptance: !!row?.channel && !!row?.require_acceptance,
      version: row?.version ?? 1,
    };
  }
  function rulesAccepted(guild: string, user: string) {
    const rules = ruleConfig(guild);
    return (
      !rules.requireAcceptance ||
      can(guild, user, "administrator") ||
      one(
        "SELECT version FROM community_rules_acceptance WHERE guild=? AND user=?",
        guild,
        user,
      )?.version === rules.version
    );
  }
  function state(guild: string, user: string) {
    const roleAssignments: Record<string, string[]> = {};
    for (const r of all(
      "SELECT user,role FROM community_member_roles WHERE guild=? ORDER BY role",
      guild,
    ))
      (roleAssignments[r.user] ??= []).push(r.role);
    const rules = ruleConfig(guild);
    return {
      roles: roles(guild),
      roleAssignments,
      categories: all(
        "SELECT * FROM community_categories WHERE guild=? ORDER BY position,id",
        guild,
      ),
      emojis: all(
        "SELECT id,name,image FROM community_emojis WHERE guild=? ORDER BY created,id",
        guild,
      ).map((e) => ({ ...e, image: JSON.parse(e.image) })),
      rules,
      rulesChannel: rules.channel,
      rulesAccepted: rulesAccepted(guild, user),
      myPermissions: permissions(guild, user),
    };
  }
  function decorateChannels(guild: string, channels: Row[]) {
    const map = new Map(
      all(
        "SELECT m.* FROM community_channel_meta m JOIN rooms r ON r.id=m.room WHERE r.guild=?",
        guild,
      ).map((m) => [m.room, m]),
    );
    return channels.map((r) => ({
      ...r,
      category: map.get(r.id)?.category ?? null,
      slowmode: map.get(r.id)?.slowmode ?? 0,
    }));
  }
  function canPost(room: Row, user: string) {
    if (!room.guild) return true;
    if (!isMember(room.guild, user)) return false;
    if (["announcement", "rules"].includes(room.kind))
      return can(room.guild, user, "manageMessages");
    return (
      can(room.guild, user, "sendMessages") && rulesAccepted(room.guild, user)
    );
  }
  function assertCanPost(room: Row, user: string, type = "message") {
    if (room.guild) {
      member(room.guild, user);
      if (type === "reaction") return;
      if (type === "pin") {
        requirePermission(room.guild, user, "manageMessages");
        return;
      }
    }
    if (!canPost(room, user))
      return fail(
        403,
        room.guild && !rulesAccepted(room.guild, user)
          ? "ルールに同意してから送信して"
          : "このチャンネルには投稿できない",
      );
    if (
      type !== "message" ||
      !room.guild ||
      can(room.guild, user, "manageMessages")
    )
      return;
    const seconds =
      one("SELECT slowmode FROM community_channel_meta WHERE room=?", room.id)
        ?.slowmode ?? 0;
    const latest =
      one(
        "SELECT MAX(created) AS at FROM events WHERE room=? AND author=? AND (json_extract(envelope,'$.header.type')='message' OR json_extract(envelope,'$.header.type') IS NULL)",
        room.id,
        user,
      )?.at ?? 0;
    if (seconds && latest + seconds * 1000 > Date.now())
      return fail(429, "スローモードの待ち時間中");
  }
  function rulesChanged(room: Row, type = "message") {
    if (
      !room.guild ||
      !["message", "edit", "delete"].includes(type) ||
      ruleConfig(room.guild).channel !== room.id
    )
      return;
    run(
      "UPDATE community_rules SET version=version+1 WHERE guild=?",
      room.guild,
    );
    changed(room.guild);
  }
  function ensureMembershipLimit(user: string) {
    if (
      (one("SELECT COUNT(*) AS n FROM members WHERE user=?", user)?.n ?? 0) >=
      (ctx.userLimit?.(user) ?? 30)
    )
      return fail(
        409,
        `参加できるサーバーは${ctx.userLimit?.(user) ?? 30}個までです`,
      );
  }
  function removeMember(guild: string, user: string) {
    run(
      "DELETE FROM community_member_roles WHERE guild=? AND user=?",
      guild,
      user,
    );
    run(
      "DELETE FROM community_rules_acceptance WHERE guild=? AND user=?",
      guild,
      user,
    );
  }
  async function body(req: Request) {
    const b = await json(req);
    if (!b || typeof b !== "object" || Array.isArray(b))
      return fail(400, "入力値が不正");
    return b;
  }
  function color(v: any) {
    if (typeof v !== "string" || !/^#[0-9a-fA-F]{6}$/.test(v))
      return fail(400, "カラーが不正");
    return v;
  }
  function permissionList(v: any) {
    if (
      !Array.isArray(v) ||
      v.length > communityPermissions.length ||
      new Set(v).size !== v.length ||
      v.some((p) => !communityPermissions.includes(p))
    )
      return fail(400, "権限が不正");
    return v as string[];
  }
  function role(guild: string, id: string) {
    return (
      one("SELECT * FROM community_roles WHERE id=? AND guild=?", id, guild) ??
      fail(404, "ロールがない")
    );
  }
  function category(guild: string, id: any) {
    if (id === null || id === "") return null;
    if (
      typeof id !== "string" ||
      !one(
        "SELECT 1 FROM community_categories WHERE id=? AND guild=?",
        id,
        guild,
      )
    )
      return fail(400, "カテゴリが不正");
    return id;
  }
  function room(guild: string, id: string) {
    return (
      one("SELECT * FROM rooms WHERE id=? AND guild=?", id, guild) ??
      fail(404, "チャンネルがない")
    );
  }
  function imageDescriptor(v: any) {
    const b64 = (s: any, n: number) =>
      typeof s === "string" &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(s) &&
      Buffer.from(s, "base64").length === n;
    if (
      !v ||
      typeof v !== "object" ||
      !/^[\w-]{1,100}$/.test(v.id) ||
      !b64(v.key, 32) ||
      !b64(v.iv, 12) ||
      !b64(v.hash, 32) ||
      v.mime !== "image/webp" ||
      !Number.isInteger(v.size) ||
      v.size < 1 ||
      v.size > 65536
    )
      return fail(400, "絵文字の画像データが不正");
    return {
      id: v.id,
      key: v.key,
      iv: v.iv,
      hash: v.hash,
      size: v.size,
      mime: "image/webp",
      name: "emoji.webp",
    };
  }
  function reordered(ids: any, existing: Row[]) {
    if (
      !Array.isArray(ids) ||
      ids.length !== existing.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !existing.some((e) => e.id === id))
    )
      return fail(400, "並び順が不正");
    return ids as string[];
  }
  async function handle(
    req: Request,
    url: URL,
    user: string,
  ): Promise<Response | undefined> {
    const match = url.pathname.match(
      /^\/api\/guilds\/([\w-]+)\/(roles|memberroles|categories|channelmeta|emojis|rules)(?:\/([\w-]+))?$/,
    );
    if (!match) return;
    const guild = match[1],
      action = match[2],
      id = match[3],
      method = req.method;
    member(guild, user);
    if (method === "GET") {
      if (action === "roles" && !id) return response(roles(guild));
      if (action === "categories" && !id)
        return response(state(guild, user).categories);
      if (action === "emojis" && !id)
        return response(state(guild, user).emojis);
      if (action === "rules" && !id)
        return response({
          ...ruleConfig(guild),
          accepted: rulesAccepted(guild, user),
        });
      return;
    }
    if (action === "roles") {
      owner(guild, user);
      ensureDefault(guild);
      if (!id && method === "POST") {
        const b = await body(req);
        owner(guild, user);
        const name = text(b.name, 40),
          permissions = permissionList(b.permissions ?? []),
          shade = color(b.color ?? "#5865f2");
        if (roles(guild).length >= 50) return fail(400, "ロールは50個までです");
        const rid = uuid(),
          position = Math.max(...roles(guild).map((r) => r.position)) + 1;
        run(
          "INSERT INTO community_roles VALUES(?,?,?,?,?,?)",
          rid,
          guild,
          name,
          shade,
          position,
          JSON.stringify(permissions),
        );
        audit(guild, user, "role.create", name);
        changed(guild);
        return response({ id: rid });
      }
      if (id === "order" && ["PATCH", "PUT"].includes(method)) {
        const b = await body(req);
        owner(guild, user);
        const order = reordered(
          b.ids,
          roles(guild).filter((r) => !r.isDefault),
        );
        db.transaction(() =>
          order.forEach((rid, i) =>
            run(
              "UPDATE community_roles SET position=? WHERE id=? AND guild=?",
              i + 1,
              rid,
              guild,
            ),
          ),
        )();
        audit(guild, user, "role.order");
        changed(guild);
        return response({ ok: true });
      }
      if (id && method === "PATCH") {
        const b = await body(req);
        owner(guild, user);
        const old = role(guild, id),
          isDefault = id === defaultId(guild);
        const name = isDefault
            ? "@everyone"
            : b.name === undefined
              ? old.name
              : text(b.name, 40),
          shade = b.color === undefined ? old.color : color(b.color),
          permissions =
            b.permissions === undefined
              ? JSON.parse(old.permissions)
              : permissionList(b.permissions);
        if (
          isDefault &&
          permissions.some(
            (p: string) => !["sendMessages", "connect"].includes(p),
          )
        )
          return fail(400, "全員ロールには送信・接続のみ設定できる");
        const position = isDefault
          ? 0
          : b.position === undefined
            ? old.position
            : b.position;
        if (
          !Number.isInteger(position) ||
          position < 0 ||
          position > 49 ||
          (!isDefault && position === 0)
        )
          return fail(400, "ロールの表示順が不正");
        run(
          "UPDATE community_roles SET name=?,color=?,permissions=?,position=? WHERE id=? AND guild=?",
          name,
          shade,
          JSON.stringify(permissions),
          position,
          id,
          guild,
        );
        audit(guild, user, "role.update", name);
        changed(guild);
        return response({ ok: true });
      }
      if (id && method === "DELETE") {
        const old = role(guild, id);
        if (id === defaultId(guild))
          return fail(400, "全員ロールは削除できない");
        run("DELETE FROM community_roles WHERE id=? AND guild=?", id, guild);
        audit(guild, user, "role.delete", old.name);
        changed(guild);
        return response({ ok: true });
      }
    }
    if (action === "memberroles" && id && method === "PUT") {
      owner(guild, user);
      const b = await body(req);
      owner(guild, user);
      member(guild, id);
      if (
        !Array.isArray(b.roles) ||
        new Set(b.roles).size !== b.roles.length ||
        b.roles.length > 50
      )
        return fail(400, "ロールが不正");
      for (const rid of b.roles) {
        if (typeof rid !== "string" || rid === defaultId(guild))
          return fail(400, "ロールが不正");
        role(guild, rid);
      }
      db.transaction(() => {
        run(
          "DELETE FROM community_member_roles WHERE guild=? AND user=?",
          guild,
          id,
        );
        for (const rid of b.roles)
          run(
            "INSERT INTO community_member_roles VALUES(?,?,?)",
            guild,
            id,
            rid,
          );
      })();
      audit(guild, user, "role.assign", id);
      changed(guild);
      return response({ ok: true });
    }
    if (action === "categories") {
      requirePermission(guild, user, "manageChannels");
      if (!id && method === "POST") {
        const b = await body(req);
        requirePermission(guild, user, "manageChannels");
        const name = text(b.name, 60),
          cid = uuid();
        if (
          (one(
            "SELECT COUNT(*) AS n FROM community_categories WHERE guild=?",
            guild,
          )?.n ?? 0) >= 50
        )
          return fail(400, "カテゴリは50個までです");
        const position =
          (one(
            "SELECT MAX(position) AS n FROM community_categories WHERE guild=?",
            guild,
          )?.n ?? -1) + 1;
        run(
          "INSERT INTO community_categories VALUES(?,?,?,?)",
          cid,
          guild,
          name,
          position,
        );
        audit(guild, user, "category.create", name);
        changed(guild);
        return response({ id: cid });
      }
      if (id === "order" && ["PATCH", "PUT"].includes(method)) {
        const b = await body(req);
        requirePermission(guild, user, "manageChannels");
        const order = reordered(
          b.ids,
          all("SELECT id FROM community_categories WHERE guild=?", guild),
        );
        db.transaction(() =>
          order.forEach((cid, i) =>
            run(
              "UPDATE community_categories SET position=? WHERE id=? AND guild=?",
              i,
              cid,
              guild,
            ),
          ),
        )();
        audit(guild, user, "category.order");
        changed(guild);
        return response({ ok: true });
      }
      if (id && method === "PATCH") {
        const b = await body(req);
        requirePermission(guild, user, "manageChannels");
        category(guild, id);
        const old = one(
          "SELECT * FROM community_categories WHERE id=? AND guild=?",
          id,
          guild,
        )!;
        const name = b.name === undefined ? old.name : text(b.name, 60),
          position = b.position === undefined ? old.position : b.position;
        if (!Number.isInteger(position) || position < 0 || position > 49)
          return fail(400, "カテゴリの表示順が不正");
        run(
          "UPDATE community_categories SET name=?,position=? WHERE id=? AND guild=?",
          name,
          position,
          id,
          guild,
        );
        audit(guild, user, "category.update", name);
        changed(guild);
        return response({ ok: true });
      }
      if (id && method === "DELETE") {
        category(guild, id);
        run(
          "DELETE FROM community_categories WHERE id=? AND guild=?",
          id,
          guild,
        );
        audit(guild, user, "category.delete");
        changed(guild);
        return response({ ok: true });
      }
    }
    if (action === "channelmeta" && id && method === "PATCH") {
      requirePermission(guild, user, "manageChannels");
      const b = await body(req);
      requirePermission(guild, user, "manageChannels");
      const old = room(guild, id),
        meta = one("SELECT * FROM community_channel_meta WHERE room=?", id),
        group =
          b.category === undefined
            ? (meta?.category ?? null)
            : category(guild, b.category),
        slowmode =
          b.slowmode === undefined ? (meta?.slowmode ?? 0) : b.slowmode,
        kind = b.kind ?? old.kind;
      if (
        !["text", "voice", "announcement", "rules"].includes(kind) ||
        !Number.isInteger(slowmode) ||
        slowmode < 0 ||
        slowmode > 21600
      )
        return fail(400, "チャンネル設定が不正");
      db.transaction(() => {
        run("UPDATE rooms SET kind=? WHERE id=? AND guild=?", kind, id, guild);
        run(
          "INSERT INTO community_channel_meta VALUES(?,?,?) ON CONFLICT(room) DO UPDATE SET category=excluded.category,slowmode=excluded.slowmode",
          id,
          group,
          slowmode,
        );
        if (kind !== "rules")
          run(
            "UPDATE community_rules SET channel=NULL,require_acceptance=0,version=version+1 WHERE guild=? AND channel=?",
            guild,
            id,
          );
      })();
      audit(guild, user, "channel.update", old.name);
      changed(guild);
      return response({ ok: true });
    }
    if (action === "emojis") {
      requirePermission(guild, user, "manageEmojis");
      if (!id && method === "POST") {
        const b = await body(req);
        requirePermission(guild, user, "manageEmojis");
        if (typeof b.name !== "string" || !/^[A-Za-z0-9_]{2,32}$/.test(b.name))
          return fail(400, "絵文字名は英数字と_で2〜32文字");
        const image = imageDescriptor(b.image),
          eid = uuid();
        if (
          (one(
            "SELECT COUNT(*) AS n FROM community_emojis WHERE guild=?",
            guild,
          )?.n ?? 0) >= (ctx.guildLimits?.(guild).emojiLimit ?? 100)
        )
          return fail(
            400,
            `絵文字は${ctx.guildLimits?.(guild).emojiLimit ?? 100}個までです`,
          );
        if (
          one(
            "SELECT 1 FROM community_emojis WHERE guild=? AND name=? COLLATE NOCASE",
            guild,
            b.name,
          )
        )
          return fail(409, "同じ名前の絵文字がある");
        run(
          "INSERT INTO community_emojis VALUES(?,?,?,?,?)",
          eid,
          guild,
          b.name,
          JSON.stringify(image),
          Date.now(),
        );
        audit(guild, user, "emoji.create", b.name);
        changed(guild);
        return response({ id: eid });
      }
      if (id && method === "DELETE") {
        const old = one(
          "SELECT name FROM community_emojis WHERE id=? AND guild=?",
          id,
          guild,
        );
        if (!old) return fail(404, "絵文字がない");
        run("DELETE FROM community_emojis WHERE id=? AND guild=?", id, guild);
        audit(guild, user, "emoji.delete", old.name);
        changed(guild);
        return response({ ok: true });
      }
    }
    if (action === "rules") {
      if (id === "accept" && method === "POST") {
        const b = await body(req);
        member(guild, user);
        const rules = ruleConfig(guild);
        if (!rules.channel) return fail(400, "ルールチャンネルがない");
        if (b.version !== undefined && b.version !== rules.version)
          return fail(409, "ルールが更新された");
        run(
          "INSERT INTO community_rules_acceptance VALUES(?,?,?,?) ON CONFLICT(guild,user) DO UPDATE SET version=excluded.version,accepted=excluded.accepted",
          guild,
          user,
          rules.version,
          Date.now(),
        );
        changed(guild);
        return response({ ok: true });
      }
      if (!id && method === "PATCH") {
        requirePermission(guild, user, "manageChannels");
        const b = await body(req);
        requirePermission(guild, user, "manageChannels");
        const old = ruleConfig(guild),
          channel = b.channel === undefined ? old.channel : b.channel,
          required =
            b.requireAcceptance === undefined
              ? old.requireAcceptance
              : b.requireAcceptance;
        if (
          channel !== null &&
          (typeof channel !== "string" || room(guild, channel).kind !== "rules")
        )
          return fail(400, "ルールチャンネルを選んで");
        if (typeof required !== "boolean" || (required && !channel))
          return fail(400, "ルール設定が不正");
        run(
          "INSERT INTO community_rules VALUES(?,?,?,?) ON CONFLICT(guild) DO UPDATE SET channel=excluded.channel,require_acceptance=excluded.require_acceptance,version=excluded.version",
          guild,
          channel,
          required ? 1 : 0,
          old.version + 1,
        );
        audit(guild, user, "rules.update");
        changed(guild);
        return response({ ok: true });
      }
    }
  }
  return {
    handle,
    state,
    roles,
    permissions,
    can,
    requirePermission,
    decorateChannels,
    canPost,
    assertCanPost,
    rulesChanged,
    ensureMembershipLimit,
    removeMember,
  };
}
