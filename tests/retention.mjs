import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  rmSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
const source = fileURLToPath(new URL("..", import.meta.url)),
  temp = mkdtempSync(join(tmpdir(), "oisiicord-live-upgrade-"));
const env = {
  ...process.env,
  OISIICORD_DATA_DIR: join(temp, "user-data"),
  PORT: "31995",
  APP_ORIGIN: "http://localhost:31995",
};
let child;
async function start(root, runtimeEnv) {
  child = Bun.spawn([process.execPath, join(root, "src/server.ts")], {
    cwd: temp,
    env: runtimeEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  let out = "";
  let timer;
  try {
    const result = await Promise.race([
      (async () => {
        while (true) {
          const value = await reader.read();
          if (value.done)
            throw Error(
              "server exited: " + (await new Response(child.stderr).text()),
            );
          out += new TextDecoder().decode(value.value);
          if (out.includes("Oisiicord:")) return out;
        }
      })(),
      new Promise(
        (_, reject) =>
          (timer = setTimeout(() => reject(Error("startup timeout")), 8000)),
      ),
    ]);
    return result;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}
async function stop() {
  child.kill();
  await child.exited;
  child = null;
}
try {
  const before = join(temp, "app-old"),
    after = join(temp, "app-new");
  for (const root of [before, after]) {
    mkdirSync(root);
    for (const name of ["src", "public"])
      cpSync(join(source, name), join(root, name), { recursive: true });
  }
  writeFileSync(
    join(before, ".env"),
    "PORT=31995\nAPP_ORIGIN=http://localhost:31995\nICE_SERVERS=[]\n",
  );
  await start(before, env);
  const C = await import(join(source, "public/crypto.js"));
  const identity = await C.identity(),
    user = crypto.randomUUID(),
    username = "upgrade_live",
    pass = "upgrade-live-password-2026",
    salt = C.b64(C.random(32));
  const credentials = await C.credentials(pass, salt),
    keys = await C.importIdentity(identity.privateKeys, identity.keys),
    vault = await C.encryptVault(
      identity.privateKeys,
      credentials.vault,
      username,
    );
  const api = async (path, body, cookie) => {
    const result = await fetch("http://localhost:31995/api" + path, {
      method: body ? "POST" : "GET",
      headers: {
        Origin: "http://localhost:31995",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await result.json();
    assert.equal(result.status, 200, JSON.stringify(data));
    return { data, cookie: result.headers.get("set-cookie")?.split(";")[0] };
  };
  const registered = await api("/auth/register", {
    id: user,
    username,
    display: "Upgrade test",
    salt,
    auth: credentials.auth,
    keys: identity.keys,
    vault,
    proof: await C.sign({ id: user, username, keys: identity.keys }, keys),
  });
  const guild = crypto.randomUUID(),
    roster = {
      guild,
      owner: user,
      version: 1,
      members: [{ id: user, keys: identity.keys, role: "owner" }],
    };
  await api(
    "/guilds",
    { name: "Preserved server", roster, signature: await C.sign(roster, keys) },
    registered.cookie,
  );
  const initial = (await api("/state", null, registered.cookie)).data;
  const room = initial.guilds[0].channels.find((r) => r.kind === "text").id;
  const payload = {
    type: "message",
    text: "Preserved encrypted message",
    files: [],
  };
  const envelope = await C.seal(payload, {
    room,
    author: user,
    recipients: roster.members,
    identity: keys,
    version: 1,
  });
  await api("/rooms/" + room + "/events", envelope, registered.cookie);
  await stop();
  rmSync(before, { recursive: true });
  const nextEnv = { ...env };
  delete nextEnv.PORT;
  delete nextEnv.APP_ORIGIN;
  const output = await start(after, nextEnv);
  assert(output.includes("http://localhost:31995"));
  const logged = await api("/auth/login", { username, auth: credentials.auth });
  const state = (await api("/state", null, logged.cookie)).data;
  assert.equal(state.me.id, user);
  assert.equal(state.guilds[0].id, guild);
  assert.deepEqual(state.guilds[0].roster, initial.guilds[0].roster);
  const privateKeys = await C.decryptVault(
    logged.data.vault,
    credentials.vault,
    username,
  );
  const restoredIdentity = {
    ...(await C.importIdentity(privateKeys, state.me.keys)),
    id: user,
  };
  const history = (await api("/rooms/" + room + "/events", null, logged.cookie))
    .data;
  assert.equal(history.length, 1);
  assert.deepEqual(
    await C.open(history[0].envelope, restoredIdentity, state.me.keys, room),
    payload,
  );
  await stop();
  const backup = Bun.spawnSync(
    [process.execPath, join(after, "src/maintenance.ts"), "backup"],
    { cwd: temp, env: nextEnv },
  );
  assert.equal(backup.exitCode, 0, backup.stderr.toString());
  assert.equal(
    readdirSync(join(temp, "user-data", "backups")).filter((x) =>
      x.endsWith(".sqlite"),
    ).length,
    1,
  );
  console.log(
    "Live startup from another working directory, encrypted login after source replacement, guild/roster retention, persistent origin/port and backup CLI passed",
  );
} finally {
  if (child) await stop();
  rmSync(temp, { recursive: true, force: true });
}
