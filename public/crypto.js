// Protocol v1. Only Web Crypto primitives; all private keys stay in the browser.
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder(),
  dec = new TextDecoder();
export const bytes = (s) => enc.encode(s);
export function b64(a) {
  let s = "";
  for (const b of new Uint8Array(a)) s += String.fromCharCode(b);
  return btoa(s);
}
export const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const random = (n) => crypto.getRandomValues(new Uint8Array(n));
export function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.keys(v)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonical(v[k]))
      .join(",") +
    "}"
  );
}
export const digest = async (data) =>
  b64(
    await subtle.digest(
      "SHA-256",
      typeof data === "string" ? bytes(data) : data,
    ),
  );
export const fingerprint = async (keys) =>
  (await digest(canonical(keys))).replaceAll("=", "");
const aes = (raw) =>
  subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
export async function lock(raw, plaintext, aad) {
  const iv = random(12);
  return {
    iv: b64(iv),
    ct: b64(
      await subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: bytes(aad) },
        await aes(raw),
        plaintext,
      ),
    ),
  };
}
export async function unlock(raw, box, aad) {
  return new Uint8Array(
    await subtle.decrypt(
      { name: "AES-GCM", iv: unb64(box.iv), additionalData: bytes(aad) },
      await aes(raw),
      unb64(box.ct),
    ),
  );
}
export async function credentials(password, salt) {
  const material = await subtle.importKey(
    "raw",
    bytes(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derive = (label) =>
    subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: bytes("oisiicord/v1/" + label + "/" + salt),
        iterations: 600000,
      },
      material,
      256,
    );
  const [auth, vault] = await Promise.all([
    derive("authentication"),
    derive("vault"),
  ]);
  return { auth: b64(auth), vault: new Uint8Array(vault) };
}
export async function identity() {
  const [sign, exchange] = await Promise.all([
    subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]),
    subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ]),
  ]);
  const keys = {
    sign: b64(await subtle.exportKey("spki", sign.publicKey)),
    exchange: b64(await subtle.exportKey("spki", exchange.publicKey)),
  };
  const privateKeys = {
    sign: b64(await subtle.exportKey("pkcs8", sign.privateKey)),
    exchange: b64(await subtle.exportKey("pkcs8", exchange.privateKey)),
  };
  return { keys, privateKeys };
}
export async function importIdentity(privateKeys, keys) {
  return {
    keys,
    sign: await subtle.importKey(
      "pkcs8",
      unb64(privateKeys.sign),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    ),
    exchange: await subtle.importKey(
      "pkcs8",
      unb64(privateKeys.exchange),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    ),
  };
}
export async function sign(value, identity) {
  return b64(
    await subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      identity.sign,
      bytes(canonical(value)),
    ),
  );
}
export async function verify(value, signature, keys) {
  try {
    const key = await subtle.importKey(
      "spki",
      unb64(keys.sign),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return await subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      unb64(signature),
      bytes(canonical(value)),
    );
  } catch {
    return false;
  }
}
async function shared(privateKey, publicKey, context) {
  const publicCrypto = await subtle.importKey(
    "spki",
    unb64(publicKey),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const bits = await subtle.deriveBits(
    { name: "ECDH", public: publicCrypto },
    privateKey,
    256,
  );
  const base = await subtle.importKey("raw", bits, "HKDF", false, [
    "deriveBits",
  ]);
  return new Uint8Array(
    await subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: bytes("oisiicord/v1/wrap"),
        info: bytes(context),
      },
      base,
      256,
    ),
  );
}
export async function seal(
  payload,
  {
    room,
    author,
    recipients,
    identity: me,
    version = 0,
    id = crypto.randomUUID(),
  },
) {
  const ephemeral = await subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const header = {
    v: 1,
    id,
    room,
    author,
    version,
    at: Date.now(),
    ephemeral: b64(await subtle.exportKey("spki", ephemeral.publicKey)),
  };
  const context = canonical(header),
    contentKey = random(32),
    boxes = {};
  for (const user of recipients) {
    const wrapping = await shared(
      ephemeral.privateKey,
      user.keys.exchange,
      context + "/" + user.id,
    );
    boxes[user.id] = await lock(wrapping, contentKey, context + "/" + user.id);
  }
  const body = {
    header,
    boxes,
    payload: await lock(contentKey, bytes(JSON.stringify(payload)), context),
  };
  return { ...body, signature: await sign(body, me) };
}
export async function open(envelope, me, authorKeys, expectedRoom) {
  const { signature, ...body } = envelope,
    { header } = body;
  if (
    header.v !== 1 ||
    header.room !== expectedRoom ||
    !(await verify(body, signature, authorKeys))
  )
    throw Error("署名が一致しないメッセージ");
  const context = canonical(header),
    box = body.boxes[me.id];
  if (!box) throw Error("この端末宛ての暗号鍵がない");
  const wrapping = await shared(
    me.exchange,
    header.ephemeral,
    context + "/" + me.id,
  );
  const key = await unlock(wrapping, box, context + "/" + me.id);
  return JSON.parse(dec.decode(await unlock(key, body.payload, context)));
}
export async function encryptVault(privateKeys, key, user) {
  return lock(
    key,
    bytes(JSON.stringify(privateKeys)),
    "oisiicord/v1/vault/" + user,
  );
}
export async function decryptVault(box, key, user) {
  return JSON.parse(
    dec.decode(await unlock(key, box, "oisiicord/v1/vault/" + user)),
  );
}
export async function encryptFile(file) {
  const key = random(32),
    iv = random(12);
  const ciphertext = await subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: bytes("oisiicord/v1/file") },
    await aes(key),
    await file.arrayBuffer(),
  );
  return {
    ciphertext,
    descriptor: {
      key: b64(key),
      iv: b64(iv),
      hash: await digest(ciphertext),
      name: file.name,
      mime: file.type,
      size: file.size,
    },
  };
}
export async function decryptFile(ciphertext, descriptor) {
  if ((await digest(ciphertext)) !== descriptor.hash)
    throw Error("添付ファイルのハッシュが一致しない");
  return subtle.decrypt(
    {
      name: "AES-GCM",
      iv: unb64(descriptor.iv),
      additionalData: bytes("oisiicord/v1/file"),
    },
    await aes(unb64(descriptor.key)),
    ciphertext,
  );
}
