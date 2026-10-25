import assert from "node:assert/strict";
import { createApp } from "../src/server.ts";
import * as C from "../public/crypto.js";
// Explicit opt-in command: one synthetic encrypted upload, download and cleanup.
const app = createApp({
  path: ":memory:",
  port: 0,
  origin: "http://localhost:31982",
});
const base = "http://127.0.0.1:" + app.server.port;
let cookie = "",
  uploaded = null;
const stages = {
  upload: false,
  download: false,
  decrypt: false,
  remove: false,
};
async function api(
  path,
  body,
  method = body === undefined ? "GET" : "POST",
  binary = false,
) {
  const r = await fetch(base + "/api" + path, {
    method,
    headers: {
      Origin: app.origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined
        ? {}
        : {
            "Content-Type": binary
              ? "application/octet-stream"
              : "application/json",
          }),
    },
    body: body === undefined ? undefined : binary ? body : JSON.stringify(body),
  });
  if (r.headers.get("set-cookie"))
    cookie = r.headers.get("set-cookie").split(";")[0];
  if (!r.ok) {
    let out;
    try {
      out = await r.json();
    } catch {}
    throw Error(out?.error ?? "API " + r.status);
  }
  return path.startsWith("/files/") && method === "GET"
    ? r.arrayBuffer()
    : r.json();
}
try {
  const keys = await C.identity(),
    id = crypto.randomUUID(),
    username = "live_" + id.replaceAll("-", "").slice(0, 16),
    identity = { ...(await C.importIdentity(keys.privateKeys, keys.keys)), id };
  await api("/auth/register", {
    id,
    username,
    display: "File API probe",
    salt: C.b64(C.random(32)),
    auth: C.b64(C.random(32)),
    keys: keys.keys,
    vault: await C.lock(C.random(32), C.bytes("temporary"), "temporary"),
    proof: await C.sign({ id, username, keys: keys.keys }, identity),
  });
  const plain = C.random(128),
    file = new File([plain], "probe.bin"),
    encrypted = await C.encryptFile(file);
  uploaded = await api("/files", encrypted.ciphertext, "POST", true);
  stages.upload = true;
  const bytes = await api("/files/" + uploaded.id);
  stages.download = true;
  assert.deepEqual(
    new Uint8Array(await C.decryptFile(bytes, encrypted.descriptor)),
    plain,
  );
  stages.decrypt = true;
} catch (error) {
  console.error("Live file API:", error.message);
  process.exitCode = 1;
} finally {
  if (uploaded) {
    try {
      await api(
        "/files/" + uploaded.id,
        { password: uploaded.removePassword },
        "DELETE",
      );
      stages.remove = true;
    } catch (error) {
      console.error("Live cleanup:", error.message);
      process.exitCode = 1;
    }
  }
  app.stop();
  console.log(
    JSON.stringify({
      provider: "https://api.end2end.tech",
      syntheticPlaintextBytes: 128,
      ...stages,
    }),
  );
}
