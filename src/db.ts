import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
export function database(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, display TEXT NOT NULL,
      salt TEXT NOT NULL, auth TEXT NOT NULL, vault TEXT NOT NULL, keys TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS guilds(id TEXT PRIMARY KEY, owner TEXT UNIQUE NOT NULL REFERENCES users(id), name TEXT NOT NULL,
      roster TEXT NOT NULL, signature TEXT NOT NULL, version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS rosters(guild TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE, version INTEGER NOT NULL, roster TEXT NOT NULL, signature TEXT NOT NULL, PRIMARY KEY(guild,version));
    CREATE TABLE IF NOT EXISTS members(guild TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
      user TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL, PRIMARY KEY(guild,user));
    CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY, guild TEXT REFERENCES guilds(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS peers(room TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user TEXT NOT NULL REFERENCES users(id), PRIMARY KEY(room,user));
    CREATE TABLE IF NOT EXISTS invites(hash TEXT PRIMARY KEY, guild TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS requests(guild TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
      user TEXT NOT NULL REFERENCES users(id), PRIMARY KEY(guild,user));
    CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
      room TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, author TEXT NOT NULL REFERENCES users(id),
      envelope TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS events_room ON events(room,seq);
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);`);
  return db;
}
