import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { database, SCHEMA_VERSION } from "../src/db";
import {
  backupDatabase,
  defaultDataDir,
  prepareStorage,
  snapshotDatabase,
} from "../src/storage";
import { updateProject } from "../src/maintenance";

const temporary: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), "oisiicord-storage-"));
  temporary.push(path);
  return path;
}
afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});
function scalar(db: Database, sql: string) {
  return Object.values(db.query(sql).get() as object)[0];
}
function fixture(path: string) {
  const db = database(path);
  db.query("INSERT INTO users VALUES(?,?,?,?,?,?,?,?)").run(
    "alice",
    "alice",
    "Alice",
    "salt",
    "auth-secret",
    '{"ciphertext":"encrypted-vault"}',
    '{"public":"identity"}',
    123,
  );
  return db;
}

test("legacy WAL data and host settings survive source folder replacement", () => {
  const base = directory(),
    root = join(base, "old-app"),
    dataDir = join(base, "persistent data");
  const legacy = join(root, "data", "oisiicord.sqlite");
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, ".env"),
    'DATABASE_PATH=./data/oisiicord.sqlite\nPORT=4567\nAPP_ORIGIN=https://chat.example.test\nICE_SERVERS=[{"urls":"stun:example.test:3478"}]\n',
  );
  const original = fixture(legacy);
  original.exec("PRAGMA wal_autocheckpoint=0; PRAGMA user_version=0");
  original
    .query("INSERT INTO guilds VALUES(?,?,?,?,?,?)")
    .run(
      "guild",
      "alice",
      "Friends",
      '{"members":["alice"]}',
      "signed-roster",
      1,
    );
  original
    .query("INSERT INTO members VALUES(?,?,?)")
    .run("guild", "alice", "owner");
  original
    .query("INSERT INTO rooms VALUES(?,?,?,?)")
    .run("room", "guild", "text", "general");
  original
    .query(
      "INSERT INTO events(id,room,author,envelope,created) VALUES(?,?,?,?,?)",
    )
    .run(
      "message",
      "room",
      "alice",
      '{"ciphertext":"unaltered-message","signature":"original-signature"}',
      456,
    );
  original
    .query("INSERT INTO profiles VALUES(?,?)")
    .run("alice", '{"avatar":{"id":"external-avatar"}}');
  const first = prepareStorage({ root, env: { OISIICORD_DATA_DIR: dataDir } });
  expect(first.databasePath).toBe(join(dataDir, "oisiicord.sqlite"));
  expect(existsSync(legacy)).toBe(true);
  original.close();
  const migrated = database(first.databasePath, first.backupDir);
  expect(scalar(migrated, "SELECT envelope FROM events")).toBe(
    '{"ciphertext":"unaltered-message","signature":"original-signature"}',
  );
  expect(scalar(migrated, "SELECT vault FROM users")).toBe(
    '{"ciphertext":"encrypted-vault"}',
  );
  expect(scalar(migrated, "SELECT signature FROM guilds")).toBe(
    "signed-roster",
  );
  expect(scalar(migrated, "SELECT data FROM profiles")).toBe(
    '{"avatar":{"id":"external-avatar"}}',
  );
  expect(readdirSync(first.backupDir).length).toBe(1);
  migrated.close();
  // A second startup in the old folder must not import its retained copy again.
  expect(
    prepareStorage({ root, env: { OISIICORD_DATA_DIR: dataDir } }).databasePath,
  ).toBe(first.databasePath);
  rmSync(root, { recursive: true });
  const fresh = join(base, "new-app");
  mkdirSync(fresh);
  const next = prepareStorage({
    root: fresh,
    env: { OISIICORD_DATA_DIR: dataDir },
  });
  expect(next.databasePath).toBe(first.databasePath);
  expect(next.env.PORT).toBe("4567");
  expect(next.env.APP_ORIGIN).toBe("https://chat.example.test");
  expect(next.env.ICE_SERVERS).toBe('[{"urls":"stun:example.test:3478"}]');
  const reopened = database(next.databasePath, next.backupDir);
  expect(scalar(reopened, "SELECT COUNT(*) FROM events")).toBe(1);
  expect(scalar(reopened, "PRAGMA user_version")).toBe(SCHEMA_VERSION);
  expect(readdirSync(first.backupDir).length).toBe(1);
  reopened.close();
});

test("backups include live WAL commits and never replace an existing destination", () => {
  const base = directory(),
    path = join(base, "chat.sqlite"),
    db = fixture(path);
  db.exec("PRAGMA wal_autocheckpoint=0");
  db.query("UPDATE users SET display=?").run("Saved in WAL");
  const snapshot = backupDatabase(path, join(base, "backups"));
  const backup = new Database(snapshot, { readonly: true });
  expect(scalar(backup, "SELECT display FROM users")).toBe("Saved in WAL");
  expect(scalar(backup, "PRAGMA integrity_check")).toBe("ok");
  backup.close();
  const before = readFileSync(snapshot);
  expect(() => snapshotDatabase(path, snapshot)).toThrow("既に存在");
  expect(readFileSync(snapshot)).toEqual(before);
  expect(() => snapshotDatabase(path, path)).toThrow("同じ");
  expect(readdirSync(base).some((name) => name.endsWith(".tmp"))).toBe(false);
  db.close();
});

test("ambiguous or damaged legacy databases fail without discarding either copy", () => {
  const base = directory(),
    root = join(base, "app"),
    dataDir = join(base, "persistent");
  const source = fixture(join(root, "data", "oisiicord.sqlite"));
  source.close();
  const destination = fixture(join(dataDir, "oisiicord.sqlite"));
  destination.query("UPDATE users SET display='Different database'").run();
  destination.close();
  const bytes = readFileSync(join(dataDir, "oisiicord.sqlite"));
  expect(() =>
    prepareStorage({ root, env: { OISIICORD_DATA_DIR: dataDir } }),
  ).toThrow("DBが2つ");
  expect(readFileSync(join(dataDir, "oisiicord.sqlite"))).toEqual(bytes);
  const other = join(base, "broken-app");
  mkdirSync(join(other, "data"), { recursive: true });
  writeFileSync(join(other, "data", "oisiicord.sqlite"), "damaged database");
  const failed = join(base, "failed-import");
  expect(() =>
    prepareStorage({ root: other, env: { OISIICORD_DATA_DIR: failed } }),
  ).toThrow();
  expect(existsSync(join(failed, "oisiicord.sqlite"))).toBe(false);
});

test("custom relative database paths stay anchored to the project and OS defaults are external", () => {
  const base = directory(),
    root = join(base, "app");
  mkdirSync(root);
  const dataDir = join(base, "persistent");
  const custom = prepareStorage({
    root,
    env: {
      OISIICORD_DATA_DIR: dataDir,
      DATABASE_PATH: "../custom/chat.sqlite",
      PORT: "9999",
    },
  });
  expect(custom.databasePath).toBe(join(base, "custom", "chat.sqlite"));
  expect(
    prepareStorage({
      root: join(base, "replacement"),
      env: { OISIICORD_DATA_DIR: dataDir },
    }).databasePath,
  ).toBe(custom.databasePath);
  expect(
    defaultDataDir({ LOCALAPPDATA: join(base, "Local") }, "win32", base),
  ).toBe(join(base, "Local", "Oisiicord"));
  expect(defaultDataDir({}, "darwin", base)).toBe(
    join(base, "Library", "Application Support", "Oisiicord"),
  );
  expect(
    defaultDataDir({ XDG_DATA_HOME: join(base, "xdg") }, "linux", base),
  ).toBe(join(base, "xdg", "oisiicord"));
});

test("schema failure rolls back changes and retains a pre-upgrade snapshot; newer schemas are rejected", () => {
  const base = directory(),
    path = join(base, "old.sqlite"),
    old = new Database(path, { create: true });
  old.exec(
    "CREATE TABLE events(payload TEXT); INSERT INTO events VALUES('keep-me')",
  );
  old.close();
  expect(() => database(path)).toThrow();
  const unchanged = new Database(path);
  expect(scalar(unchanged, "SELECT payload FROM events")).toBe("keep-me");
  expect(
    scalar(unchanged, "SELECT COUNT(*) FROM sqlite_master WHERE name='users'"),
  ).toBe(0);
  expect(scalar(unchanged, "PRAGMA user_version")).toBe(0);
  unchanged.close();
  expect(readdirSync(join(base, "backups")).length).toBe(1);
  const futurePath = join(base, "future.sqlite"),
    future = fixture(futurePath);
  future.exec("PRAGMA user_version=999");
  future.close();
  expect(() => database(futurePath)).toThrow("新しい版");
  const check = new Database(futurePath);
  expect(scalar(check, "PRAGMA user_version")).toBe(999);
  expect(scalar(check, "SELECT username FROM users")).toBe("alice");
  check.close();
});

function git(root: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode) throw Error(r.stderr.toString());
  return r.stdout.toString().trim();
}
test("git update backs up data and preserves local host configuration; edited source is refused", () => {
  const base = directory(),
    remote = join(base, "upstream"),
    root = join(base, "installed"),
    dataDir = join(base, "persistent");
  mkdirSync(remote);
  git(remote, "init", "--initial-branch=main");
  git(remote, "config", "user.name", "Test");
  git(remote, "config", "user.email", "test@example.test");
  writeFileSync(
    join(remote, "package.json"),
    '{"name":"storage-update-fixture","private":true}',
  );
  writeFileSync(join(remote, ".gitignore"), ".env\ndata/\nnode_modules/\n");
  writeFileSync(join(remote, "revision.txt"), "old");
  git(remote, "add", ".");
  git(remote, "commit", "-m", "old");
  git(base, "clone", "--local", remote, root);
  writeFileSync(
    join(root, ".env"),
    "PORT=4567\nAPP_ORIGIN=https://chat.example.test\n",
  );
  const paths = prepareStorage({ root, env: { OISIICORD_DATA_DIR: dataDir } }),
    db = fixture(paths.databasePath);
  db.close();
  writeFileSync(join(remote, "revision.txt"), "new");
  git(remote, "add", ".");
  git(remote, "commit", "-m", "new");
  const result = updateProject(root, paths);
  expect(readFileSync(join(root, "revision.txt"), "utf8")).toBe("new");
  expect(readFileSync(join(root, ".env"), "utf8")).toContain("PORT=4567");
  expect(result.backup).not.toBe(null);
  const check = new Database(result.backup!, { readonly: true });
  expect(scalar(check, "SELECT username FROM users")).toBe("alice");
  check.close();
  const current = new Database(paths.databasePath, { readonly: true });
  expect(scalar(current, "SELECT username FROM users")).toBe("alice");
  current.close();
  writeFileSync(join(root, "revision.txt"), "local work");
  expect(() => updateProject(root, paths)).toThrow("変更したソース");
  expect(readFileSync(join(root, "revision.txt"), "utf8")).toBe("local work");
  expect(readdirSync(paths.backupDir).length).toBe(1);
});

test("owner uniqueness migration retains guild children and permits multiple owned servers", () => {
  const base = directory(),
    path = join(base, "old-owner.sqlite"),
    old = new Database(path, { create: true });
  old.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,display TEXT NOT NULL,salt TEXT NOT NULL,auth TEXT NOT NULL,vault TEXT NOT NULL,keys TEXT NOT NULL,created INTEGER NOT NULL);
 CREATE TABLE guilds(id TEXT PRIMARY KEY,owner TEXT UNIQUE NOT NULL REFERENCES users(id),name TEXT NOT NULL,roster TEXT NOT NULL,signature TEXT NOT NULL,version INTEGER NOT NULL);
 CREATE TABLE members(guild TEXT REFERENCES guilds(id) ON DELETE CASCADE,user TEXT REFERENCES users(id),role TEXT NOT NULL,PRIMARY KEY(guild,user));
 CREATE TABLE rooms(id TEXT PRIMARY KEY,guild TEXT REFERENCES guilds(id) ON DELETE CASCADE,kind TEXT NOT NULL,name TEXT NOT NULL);
 CREATE TABLE rosters(guild TEXT REFERENCES guilds(id) ON DELETE CASCADE,version INTEGER NOT NULL,roster TEXT NOT NULL,signature TEXT NOT NULL,PRIMARY KEY(guild,version));
 INSERT INTO users VALUES('owner','owner','Owner','salt','auth','vault','keys',1);
 INSERT INTO guilds VALUES('old','owner','Old','roster','signature',1);
 INSERT INTO members VALUES('old','owner','owner');INSERT INTO rooms VALUES('room','old','text','History');INSERT INTO rosters VALUES('old',1,'roster','signature');PRAGMA user_version=1;`);
  old.close();
  const migrated = database(path);
  expect(scalar(migrated, "SELECT name FROM rooms")).toBe("History");
  expect(scalar(migrated, "SELECT signature FROM rosters")).toBe("signature");
  expect(scalar(migrated, "SELECT COUNT(*) FROM members")).toBe(1);
  migrated.exec(
    "INSERT INTO guilds VALUES('new','owner','New','roster','signature',1)",
  );
  expect(scalar(migrated, "SELECT COUNT(*) FROM guilds")).toBe(2);
  expect(migrated.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(scalar(migrated, "PRAGMA foreign_keys")).toBe(1);
  expect(readdirSync(join(base, "backups")).length).toBe(1);
  migrated.close();
});
