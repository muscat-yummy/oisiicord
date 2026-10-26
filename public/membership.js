import * as C from "./crypto.js";
const subtle = globalThis.crypto.subtle;
const decode = new TextDecoder();
const url64 = (data) =>
  C.b64(data).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const aad = (grant) => "oisiicord/invite/" + grant.guild + "/" + grant.id;
const historyContext = (context, id) => context + "/history/" + id;
const publicJwk = (jwk) => ({ kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y });

async function inviteIdentity(grant, secret) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret))
    throw Error("招待リンクの形式が不正");
  const jwk = { ...grant.publicKey, d: secret };
  const [sign, exchange] = await Promise.all([
    subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    ),
    subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, [
      "deriveBits",
    ]),
  ]);
  return { sign, exchange, id: grant.id };
}
export function validGrant(grant) {
  return (
    !!grant &&
    (grant.publicAlias === undefined ||
      (typeof grant.publicAlias === "string" &&
        /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(grant.publicAlias) &&
        !grant.approval &&
        !grant.maxUses &&
        grant.expires === null)) &&
    grant.v === 1 &&
    grant.type === "invite" &&
    /^[A-Za-z0-9_-]{16}$/.test(grant.id) &&
    typeof grant.guild === "string" &&
    typeof grant.owner === "string" &&
    Number.isSafeInteger(grant.baseVersion) &&
    grant.baseVersion > 0 &&
    Number.isSafeInteger(grant.created) &&
    (grant.expires === null ||
      (Number.isSafeInteger(grant.expires) && grant.expires > grant.created)) &&
    [0, 1, 5, 10, 25, 100].includes(grant.maxUses) &&
    typeof grant.approval === "boolean" &&
    typeof grant.historyHash === "string" &&
    grant.historyHash.length === 44 &&
    grant.publicKey?.kty === "EC" &&
    grant.publicKey.crv === "P-256" &&
    /^[A-Za-z0-9_-]{43}$/.test(grant.publicKey.x) &&
    /^[A-Za-z0-9_-]{43}$/.test(grant.publicKey.y) &&
    Object.keys(grant.publicKey).sort().join(",") === "crv,kty,x,y"
  );
}
export async function verifyGrant(grant, signature, ownerKeys) {
  return validGrant(grant) && (await C.verify(grant, signature, ownerKeys));
}
export async function verifyAdmission(record) {
  try {
    const { grant, admission } = record;
    if (
      !validGrant(grant) ||
      !admission ||
      admission.v !== 1 ||
      admission.type !== "admission" ||
      admission.guild !== grant.guild ||
      admission.invite !== grant.id ||
      typeof admission.user !== "string" ||
      !admission.keys?.sign ||
      !admission.keys?.exchange ||
      !Number.isSafeInteger(admission.at) ||
      admission.at < grant.created - 5000 ||
      (grant.expires !== null && admission.at >= grant.expires)
    )
      return false;
    if (grant.publicAlias)
      return await C.verify(admission, record.signature, admission.keys);
    const key = await subtle.importKey(
      "jwk",
      grant.publicKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return await subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      C.unb64(record.signature),
      C.bytes(C.canonical(admission)),
    );
  } catch {
    return false;
  }
}
export async function validateCertificate(
  certificate,
  ownerKeys,
  minimumBaseVersion = 0,
) {
  if (
    !certificate?.baseRoster ||
    certificate.baseRoster.version < minimumBaseVersion ||
    !Number.isSafeInteger(certificate.version) ||
    certificate.version < certificate.baseRoster.version ||
    !(await C.verify(certificate.baseRoster, certificate.signature, ownerKeys))
  )
    throw Error("メンバー証明が不正");
  const base = certificate.baseRoster,
    members = [...base.members];
  const owner = members.find((m) => m.id === base.owner && m.role === "owner");
  if (!owner || C.canonical(owner.keys) !== C.canonical(ownerKeys))
    throw Error("所有者の証明が不正");
  const seen = new Set(members.map((m) => m.id));
  if (seen.size !== members.length) throw Error("メンバー証明が重複している");
  let inviteCutoff = 0;
  async function add(record) {
    if (
      record.grant.guild !== base.guild ||
      record.grant.owner !== base.owner ||
      record.grant.baseVersion !== base.version ||
      record.grant.approval ||
      record.grant.created <= inviteCutoff ||
      !(await verifyGrant(record.grant, record.grantSignature, ownerKeys)) ||
      !(await verifyAdmission(record)) ||
      seen.has(record.admission.user)
    )
      throw Error("参加証明が不正");
    seen.add(record.admission.user);
    members.push({
      id: record.admission.user,
      keys: record.admission.keys,
      role: "member",
    });
  }
  for (const record of certificate.admissions ?? []) await add(record);
  const nonces = new Set();
  for (const change of certificate.changes ?? []) {
    if (change.type === "admission") {
      await add(change.record);
      continue;
    }
    if (change.type !== "departure") throw Error("メンバー変更が不正");
    const proof = change.proof,
      member = members.find((m) => m.id === proof?.user);
    if (
      !member ||
      member.role === "owner" ||
      nonces.has(proof.nonce) ||
      !(await verifyDeparture(proof, change.signature, member.keys, base))
    )
      throw Error("退出証明が不正");
    nonces.add(proof.nonce);
    members.splice(members.indexOf(member), 1);
    seen.delete(member.id);
    inviteCutoff = Math.max(inviteCutoff, proof.at);
  }
  if (members.length > 300) throw Error("メンバーの上限を超えている");
  return { ...base, version: certificate.version, members, inviteCutoff };
}
export function departureCheckpoint(
  certificate,
  previous = /** @type {any} */ (null),
) {
  const baseVersion = certificate.baseRoster.version;
  const nonces = (certificate.changes ?? [])
    .filter((change) => change.type === "departure")
    .map((change) => change.proof.nonce);
  if (
    previous &&
    (previous.baseVersion > baseVersion ||
      (previous.baseVersion === baseVersion &&
        previous.nonces.some((nonce) => !nonces.includes(nonce))))
  )
    throw Error("退出情報の巻き戻しを検知");
  return { baseVersion, nonces };
}
export function departure(guild, user, baseVersion) {
  return {
    v: 1,
    type: "departure",
    guild,
    user,
    baseVersion,
    at: Date.now(),
    nonce: crypto.randomUUID(),
  };
}
export async function verifyDeparture(proof, signature, keys, base) {
  return (
    !!proof &&
    proof.v === 1 &&
    proof.type === "departure" &&
    proof.guild === base.guild &&
    proof.baseVersion === base.version &&
    proof.user !== base.owner &&
    typeof proof.user === "string" &&
    Number.isSafeInteger(proof.at) &&
    proof.at > 0 &&
    typeof proof.nonce === "string" &&
    /^[a-zA-Z0-9_-]{1,100}$/.test(proof.nonce) &&
    (await C.verify(proof, signature, keys))
  );
}
export async function grantExchange(grant) {
  const key = await subtle.importKey(
    "jwk",
    grant.publicKey,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    [],
  );
  return C.b64(await subtle.exportKey("spki", key));
}
export async function createGrant(options, me) {
  const pair = await subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const privateJwk = await subtle.exportKey("jwk", pair.privateKey),
    secret = privateJwk.d;
  const grant = {
    v: 1,
    type: "invite",
    id: url64(C.random(12)),
    guild: options.guild,
    owner: options.owner,
    baseVersion: options.baseVersion,
    publicKey: publicJwk(privateJwk),
    created: Date.now(),
    expires: options.expires ?? null,
    maxUses: options.maxUses ?? 0,
    approval: options.approval ?? false,
    historyHash: "",
    ...(options.publicAlias ? { publicAlias: options.publicAlias } : {}),
  };
  const snapshot = await C.lock(
    C.unb64(await C.digest(secret)),
    C.bytes(JSON.stringify(options.history ?? [])),
    aad(grant),
  );
  grant.historyHash = await C.digest(C.canonical(snapshot));
  return { grant, signature: await C.sign(grant, me), snapshot, secret };
}
export async function admit(invite, secret, me) {
  const admission = {
    v: 1,
    type: "admission",
    guild: invite.grant.guild,
    invite: invite.grant.id,
    user: me.id,
    keys: me.keys,
    at: Date.now(),
  };
  return {
    admission,
    signature: await C.sign(
      admission,
      invite.grant.publicAlias
        ? me
        : await inviteIdentity(invite.grant, secret),
    ),
  };
}
export async function wrapHistoryKeys(
  contentKey,
  ephemeralPrivate,
  context,
  activeInvites,
  ownerKeys,
  expected = /** @type {any} */ (null),
) {
  const boxes = {};
  for (const invite of activeInvites ?? []) {
    const { grant } = invite;
    if (
      expected &&
      (grant.guild !== expected.guild ||
        grant.baseVersion !== expected.baseVersion ||
        grant.created <= (expected.inviteCutoff ?? 0))
    )
      throw Error("招待のサーバーまたはメンバー証明が一致しない");
    if (!(await verifyGrant(grant, invite.signature, ownerKeys)))
      throw Error("招待の署名が不正");
    if (grant.expires !== null && grant.expires <= Date.now()) continue;
    const binding = historyContext(context, grant.id);
    const wrapping = await C.shared(
      ephemeralPrivate,
      await grantExchange(grant),
      binding,
    );
    boxes[grant.id] = await C.lock(wrapping, contentKey, binding);
  }
  return boxes;
}
export async function eventContentKey(envelope, me, credentials = []) {
  if (envelope.boxes?.[me.id]) return C.contentKey(envelope, me);
  const context = C.canonical(envelope.header);
  for (const credential of credentials) {
    const archived = credential.history.get(
      envelope.header.room + "/" + envelope.header.id,
    );
    if (archived) return C.unb64(archived);
    const box = envelope.historyBoxes?.[credential.grant.id];
    if (box) {
      const binding = historyContext(context, credential.grant.id);
      const wrapping = await C.shared(
        credential.identity.exchange,
        envelope.header.ephemeral,
        binding,
      );
      return C.unlock(wrapping, box, binding);
    }
  }
  throw Error("この端末宛ての暗号鍵がない");
}
export async function openEvent(
  envelope,
  me,
  authorKeys,
  room,
  credentials = [],
) {
  return C.openWithKey(
    envelope,
    await eventContentKey(envelope, me, credentials),
    authorKeys,
    room,
  );
}
export async function buildHistory(events, me, credentials = []) {
  const entries = [];
  for (const event of events) {
    if (event.invalid || !event.envelope || !event.authorUser?.keys) continue;
    const key = await eventContentKey(event.envelope, me, credentials);
    await C.openWithKey(
      event.envelope,
      key,
      event.authorUser.keys,
      event.envelope.header.room,
    );
    entries.push({
      id: event.envelope.header.id,
      room: event.envelope.header.room,
      key: C.b64(key),
    });
  }
  return entries;
}
export async function createCredential(invite, secret, me) {
  if (
    (await C.digest(C.canonical(invite.snapshot))) !== invite.grant.historyHash
  )
    throw Error("招待の履歴が一致しない");
  const history = JSON.parse(
    decode.decode(
      await C.unlock(
        C.unb64(await C.digest(secret)),
        invite.snapshot,
        aad(invite.grant),
      ),
    ),
  );
  if (!Array.isArray(history)) throw Error("招待の履歴が不正");
  return C.seal(
    {
      type: "history-credential",
      grant: invite.grant,
      grantSignature: invite.signature,
      ...(invite.grant.publicAlias ? { snapshot: invite.snapshot } : {}),
      secret,
      history: invite.grant.publicAlias ? [] : history,
    },
    {
      room: "history:" + invite.grant.guild,
      author: me.id,
      recipients: [{ id: me.id, keys: me.keys }],
      identity: me,
    },
  );
}
export async function readCredential(
  envelope,
  me,
  authorKeys = me.keys,
  ownerKeys = null,
) {
  const payload = await C.open(envelope, me, authorKeys, envelope.header.room);
  if (
    payload.type !== "history-credential" ||
    envelope.header.room !== "history:" + payload.grant.guild ||
    !validGrant(payload.grant) ||
    !Array.isArray(payload.history)
  )
    throw Error("履歴の鍵が不正");
  if (
    envelope.header.author !== me.id &&
    (!ownerKeys ||
      !payload.grantSignature ||
      !(await verifyGrant(payload.grant, payload.grantSignature, ownerKeys)))
  )
    throw Error("履歴共有の招待署名が不正");
  let history = payload.history;
  if (envelope.header.author !== me.id || payload.snapshot) {
    if (
      !payload.snapshot ||
      (await C.digest(C.canonical(payload.snapshot))) !==
        payload.grant.historyHash
    )
      throw Error("履歴共有の内容が一致しない");
    history = JSON.parse(
      decode.decode(
        await C.unlock(
          C.unb64(await C.digest(payload.secret)),
          payload.snapshot,
          aad(payload.grant),
        ),
      ),
    );
    if (!Array.isArray(history)) throw Error("履歴の鍵が不正");
  }
  const entries = history.map((entry) => {
    if (
      !entry ||
      typeof entry.id !== "string" ||
      typeof entry.room !== "string" ||
      typeof entry.key !== "string" ||
      C.unb64(entry.key).length !== 32
    )
      throw Error("履歴の鍵が不正");
    return [entry.room + "/" + entry.id, entry.key];
  });
  return {
    grant: payload.grant,
    secret: payload.secret,
    grantSignature: payload.grantSignature,
    snapshot: payload.snapshot,
    identity: await inviteIdentity(payload.grant, payload.secret),
    history: new Map(entries),
  };
}

export async function shareCredential(credential, recipient, me) {
  return C.seal(
    {
      type: "history-credential",
      grant: credential.grant,
      grantSignature: credential.grantSignature,
      snapshot: credential.snapshot,
      secret: credential.secret,
      history: credential.snapshot
        ? []
        : [...credential.history].map(([path, key]) => {
            const split = path.indexOf("/");
            return {
              room: path.slice(0, split),
              id: path.slice(split + 1),
              key,
            };
          }),
    },
    {
      room: "history:" + credential.grant.guild,
      author: me.id,
      recipients: [recipient],
      identity: me,
    },
  );
}
