import { COMMERCE_SCHEMA } from "./commerce";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { backupDatabase } from "./storage";
import { dirname } from "node:path";
import { COMMUNITY_SCHEMA } from "./community";
import { INVITATION_SCHEMA } from "./invitations";
import { LIFECYCLE_SCHEMA } from "./lifecycle";
export const SCHEMA_VERSION = 4;
export function database(path: string, backupDir?: string) {
  const existing = path !== ":memory:" && existsSync(path);
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  try {
    const version = (
      db.query("PRAGMA user_version").get() as { user_version: number }
    ).user_version;
    if (version > SCHEMA_VERSION)
      throw Error("このDBは新しい版で作成されている。アプリを最新版に更新して");
    if (existing && version < SCHEMA_VERSION)
      console.log(
        "更新前のDBバックアップ: " +
          backupDatabase(path, backupDir, "before-schema-v" + SCHEMA_VERSION),
      );
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=OFF; PRAGMA busy_timeout=5000",
    );
    db.transaction(() => {
      const oldGuilds = db
        .query(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='guilds'",
        )
        .get() as { sql: string } | null;
      if (oldGuilds && /owner\s+TEXT\s+UNIQUE/i.test(oldGuilds.sql))
        db.exec(
          `CREATE TABLE guilds_v2(id TEXT PRIMARY KEY,owner TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,roster TEXT NOT NULL,signature TEXT NOT NULL,version INTEGER NOT NULL); INSERT INTO guilds_v2 SELECT * FROM guilds; DROP TABLE guilds; ALTER TABLE guilds_v2 RENAME TO guilds;`,
        );
      db.exec(`CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, display TEXT NOT NULL,
      salt TEXT NOT NULL, auth TEXT NOT NULL, vault TEXT NOT NULL, keys TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS profiles(user TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS guild_profiles(guild TEXT PRIMARY KEY REFERENCES guilds(id) ON DELETE CASCADE, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS guilds(id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
      roster TEXT NOT NULL, signature TEXT NOT NULL, version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS rosters(guild TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE, version INTEGER NOT NULL, roster TEXT NOT NULL, signature TEXT NOT NULL, PRIMARY KEY(guild,version));
    CREATE TABLE IF NOT EXISTS members(guild TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
      user TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL, PRIMARY KEY(guild,user));
    CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY, guild TEXT REFERENCES guilds(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS peers(room TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user TEXT NOT NULL REFERENCES users(id), PRIMARY KEY(room,user));
    CREATE TABLE IF NOT EXISTS invites(hash TEXT PRIMARY KEY, guild TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS room_preferences(room TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE, topic TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS invite_settings(invite TEXT PRIMARY KEY REFERENCES invites(hash) ON DELETE CASCADE, max_uses INTEGER NOT NULL DEFAULT 0, uses INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS guild_audit(id INTEGER PRIMARY KEY AUTOINCREMENT, guild TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE, actor TEXT NOT NULL REFERENCES users(id), action TEXT NOT NULL, target TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS guild_audit_page ON guild_audit(guild,id);
    CREATE TABLE IF NOT EXISTS requests(guild TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
      user TEXT NOT NULL REFERENCES users(id), PRIMARY KEY(guild,user));
    CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
      room TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, author TEXT NOT NULL REFERENCES users(id),
      envelope TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS events_room ON events(room,seq);
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);`);
      db.exec(COMMUNITY_SCHEMA);
      db.exec(INVITATION_SCHEMA);
      db.exec(LIFECYCLE_SCHEMA);
      db.exec(COMMERCE_SCHEMA);
      db.exec("CREATE INDEX IF NOT EXISTS guilds_owner ON guilds(owner)");
      if (db.query("PRAGMA foreign_key_check").all().length)
        throw Error("DBの参照整合性を確認できない");
      db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    })();
    db.exec("PRAGMA foreign_keys=ON");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
