import { canonical } from "./crypto.js";
const databaseName = "oisiicord-device";
function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("login");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(Error("ブラウザの保存領域を開けない"));
  });
}
async function record(mode, action) {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("login", mode);
      const request = action(tx.objectStore("login"));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () =>
        reject(tx.error ?? Error("ログイン状態を保存できない"));
    });
  } finally {
    db.close();
  }
}
function validKey(key, name, usage) {
  return (
    key instanceof CryptoKey &&
    key.type === "private" &&
    !key.extractable &&
    key.algorithm.name === name &&
    key.algorithm.namedCurve === "P-256" &&
    key.usages.includes(usage)
  );
}
export async function rememberLogin(identity, session) {
  if (
    !session?.id ||
    !Number.isFinite(session.expires) ||
    !validKey(identity.sign, "ECDSA", "sign") ||
    !validKey(identity.exchange, "ECDH", "deriveBits")
  )
    throw Error("ログイン状態を保存できない");
  await record("readwrite", (store) =>
    store.put(
      {
        session: session.id,
        expires: session.expires,
        user: identity.id,
        keys: identity.keys,
        sign: identity.sign,
        exchange: identity.exchange,
      },
      "current",
    ),
  );
}
export async function restoreLogin(result) {
  const saved = await record("readonly", (store) => store.get("current"));
  if (!saved) return null;
  if (
    saved.session !== result.session?.id ||
    saved.user !== result.user?.id ||
    saved.expires <= Date.now() ||
    result.session.expires <= Date.now() ||
    canonical(saved.keys) !== canonical(result.user.keys) ||
    !validKey(saved.sign, "ECDSA", "sign") ||
    !validKey(saved.exchange, "ECDH", "deriveBits")
  ) {
    await forgetLogin();
    return null;
  }
  return {
    id: saved.user,
    keys: saved.keys,
    sign: saved.sign,
    exchange: saved.exchange,
  };
}
export async function forgetLogin(sessionId) {
  const db = await database();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction("login", "readwrite"),
        store = tx.objectStore("login");
      const read = store.get("current");
      read.onsuccess = () => {
        if (!sessionId || read.result?.session === sessionId)
          store.delete("current");
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
