import * as C from "./crypto.js";
import { icon, setIcon } from "./icons.js";
import {
  preferences,
  loadPreferences,
  updatePreferences,
  sound,
} from "./preferences.js";
import { createSettings } from "./settings.js";
import { createCommunityUI } from "./community-ui.js";
import * as M from "./membership.js";
import { createWorkspaceUI } from "./workspace-ui.js";
import { createProductivity } from "./productivity.js";
import { createMediaPreview } from "./media-preview.js";
import { clearDeveloperCaches } from "./developer-ui.js";
import { rememberLogin, restoreLogin, forgetLogin } from "./login-state.js";
import { isMentioned, shouldNotify, createMentionInput } from "./mentions.js";
const $ = (s) => document.querySelector(s);
const node = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") n.className = v;
    else if (v !== false && v != null) n.setAttribute(k, v === true ? "" : v);
  }
  for (const child of children.flat()) {
    if (child != null)
      n.append(
        typeof child === "string" ? document.createTextNode(child) : child,
      );
  }
  return n;
};
const button = (label, fn, cls = "") =>
  node(
    "button",
    { type: "button", class: cls, onClick: () => guard(fn) },
    label,
  );
let me,
  state,
  ws,
  guildId = null,
  roomId = null,
  registering = false,
  sending = false,
  reply = null,
  attachments = [],
  activeVoice = null,
  localStream = null,
  videoTrack = null,
  videoMode = null,
  reconnectTimer,
  heartbeat;
const revealedBlocked = new Set();
const blockedUser = (id) => !!state?.blockedUsers?.some((u) => u.id === id);
const blockedContact = (id) => !!state?.blockedContacts?.includes(id);
const histories = new Map(),
  users = new Map(),
  loading = new Map(),
  reloadHistory = new Set(),
  unread = new Set(),
  peers = new Map(),
  typingUsers = new Map();
let storage = {
  pins: {},
  versions: {},
  verified: {},
  guildOwners: {},
  dmPeers: {},
  usernames: {},
};
let pendingInvite;
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($("#toast").hidden = true), 5500);
}
async function guard(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e.name !== "AbortError") toast(e.message ?? String(e));
  }
}
function saveTrust() {
  localStorage.setItem("oisiicord-trust-" + me.id, JSON.stringify(storage));
}
async function pinUser(u, expected) {
  storage.usernames ??= {};
  if (
    u.username &&
    storage.usernames[u.username] &&
    storage.usernames[u.username] !== u.id
  )
    throw Error("ユーザー名と公開鍵の対応が変わったため送信を停止した");
  const fp = await C.fingerprint(u.keys),
    old = storage.pins[u.id];
  if (expected && fp !== expected) throw Error("招待の所有者の鍵と一致しない");
  if (old && old !== fp)
    throw Error(u.display + " の公開鍵が変わったため送信を停止した");
  storage.pins[u.id] = fp;
  if (u.username) storage.usernames[u.username] = u.id;
  users.set(u.id, u);
  saveTrust();
  return fp;
}
async function api(path, body, method) {
  const opts = {
    method: method ?? (body === undefined ? "GET" : "POST"),
    credentials: "same-origin",
    headers: {},
  };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  if (opts.method === "GET") opts.signal = AbortSignal.timeout(30000);
  let res;
  try {
    res = await fetch("/api" + path, opts);
  } catch (error) {
    throw Error(
      !navigator.onLine
        ? "オフライン"
        : error.name === "TimeoutError"
          ? "応答がない。再試行して"
          : "サーバーに接続できない",
    );
  }
  let out;
  try {
    out = await res.json();
  } catch {
    throw Error(
      res.ok
        ? "応答を読み取れない"
        : "サーバーに接続できない (" + res.status + ")",
    );
  }
  if (!res.ok) {
    const error = Error(out.error ?? "リクエスト失敗");
    error.status = res.status;
    throw error;
  }
  return out;
}
const currentGuild = () => state?.guilds.find((g) => g.id === guildId);
const currentRoom = () =>
  state?.dms.find((r) => r.id === roomId) ??
  state?.guilds.flatMap((g) => g.channels).find((r) => r.id === roomId);
function recipients(room = currentRoom()) {
  if (!room) throw Error("チャンネルを選んで");
  const g = state.guilds.find((g) => g.id === room.guild);
  return g
    ? g.roster.members.map((m) => ({ ...users.get(m.id), ...m }))
    : room.users.map((id) => users.get(id));
}
async function pinGuildOwner(guild, owner, keys) {
  storage.guildOwners ??= {};
  const binding = { owner, fingerprint: await C.fingerprint(keys) };
  const old = storage.guildOwners[guild];
  if (old && C.canonical(old) !== C.canonical(binding))
    throw Error("サーバー所有者の鍵のすり替えを検知した");
  storage.guildOwners[guild] = binding;
  saveTrust();
}
function pinDMPeers(room, ids) {
  if (ids.length !== 2 || !ids.includes(me.id) || ids[0] === ids[1])
    throw Error("DMの参加者が不正");
  storage.dmPeers ??= {};
  const binding = [...ids].sort();
  const old = storage.dmPeers[room];
  if (old && C.canonical(old) !== C.canonical(binding))
    throw Error("DMの相手のすり替えを検知した");
  storage.dmPeers[room] = binding;
  saveTrust();
}
async function validateRoster(roster, signature, ownerKeys) {
  if (
    !roster ||
    roster.owner == null ||
    !(await C.verify(roster, signature, ownerKeys))
  )
    throw Error("所有者のメンバー署名が一致しない");
  const owner = roster.members.find((m) => m.id === roster.owner);
  if (!owner || C.canonical(owner.keys) !== C.canonical(ownerKeys))
    throw Error("所有者の公開鍵が不正");
  return roster;
}
const historyCredentials = new Map(),
  credentialGenerations = new Map();
function invalidateCredentials(gid) {
  credentialGenerations.set(gid, (credentialGenerations.get(gid) ?? 0) + 1);
  historyCredentials.delete(gid);
}
async function loadHistoryCredentials(gid) {
  if (historyCredentials.has(gid)) return historyCredentials.get(gid);
  const generation = credentialGenerations.get(gid) ?? 0;
  const envelopes = await api("/guilds/" + gid + "/history-credentials"),
    credentials = [];
  for (const envelope of envelopes) {
    const credential = await M.readCredential(envelope, me);
    if (credential.grant.guild !== gid)
      throw Error("履歴のサーバーが一致しない");
    credentials.push(credential);
  }
  if (generation !== (credentialGenerations.get(gid) ?? 0))
    return loadHistoryCredentials(gid);
  historyCredentials.set(gid, credentials);
  return credentials;
}
let refreshing = null,
  refreshRequested = false;
function refresh() {
  refreshRequested = true;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      while (refreshRequested && me) {
        refreshRequested = false;
        await refreshState();
      }
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}
async function refreshState() {
  const next = await api("/state");
  if (
    next.me.id !== me.id ||
    C.canonical(next.me.keys) !== C.canonical(me.keys)
  )
    throw Error("ログイン中のアカウント情報が一致しない");
  for (const u of next.users) users.set(u.id, u);
  const accepted = [];
  for (const g of next.guilds) {
    try {
      const owner = users.get(g.owner);
      if (g.owner !== g.roster.owner) throw Error("所有者の証明が不正");
      await pinGuildOwner(g.id, g.owner, owner.keys);
      await pinUser(owner);
      const base = g.certificate?.baseRoster ?? g.roster;
      await validateRoster(
        base,
        g.certificate?.signature ?? g.signature,
        owner.keys,
      );
      const minimumBase = (storage.baseVersions ?? {})[g.id] ?? 0;
      if (base.version < minimumBase)
        throw Error("メンバー一覧の巻き戻しを検知");
      if (g.certificate)
        g.roster = await M.validateCertificate(
          g.certificate,
          owner.keys,
          minimumBase,
        );
      if (g.certificate)
        (storage.departures ??= {})[g.id] = M.departureCheckpoint(
          g.certificate,
          storage.departures?.[g.id],
        );
      g.activeInvites = (g.activeInvites ?? []).filter(
        (i) => i.grant.created > (g.roster.inviteCutoff ?? 0),
      );
      if (!g.roster.members.some((m) => m.id === me.id))
        throw Error("署名済みメンバー一覧に自分がいない");
      if (g.version !== g.roster.version || g.id !== g.roster.guild)
        throw Error("メンバー一覧の識別子が不正");
      if ((storage.versions[g.id] ?? 0) > g.version)
        throw Error("メンバー一覧の巻き戻しを検知");
      for (const member of g.roster.members) {
        await pinUser({ ...users.get(member.id), ...member });
      }
      storage.versions[g.id] = g.version;
      (storage.baseVersions ??= {})[g.id] = base.version;
      await loadHistoryCredentials(g.id);
      accepted.push(g);
    } catch (e) {
      toast("サーバーを無効化: " + e.message);
    }
  }
  next.guilds = accepted;
  const acceptedDMs = [];
  for (const d of next.dms) {
    try {
      pinDMPeers(d.id, d.users);
      for (const id of d.users) await pinUser(users.get(id));
      acceptedDMs.push(d);
    } catch (e) {
      toast("DMを無効化: " + e.message);
    }
  }
  next.dms = acceptedDMs;
  state = next;
  renderTyping();
  for (const id of [...peers.keys()]) if (blockedContact(id)) removePeer(id);
  if (
    activeVoice &&
    (state.unavailableDMs?.includes(activeVoice) ||
      (!state.dms.some((room) => room.id === activeVoice) &&
        !state.guilds.some((guild) =>
          guild.channels.some((room) => room.id === activeVoice),
        )))
  )
    await leaveVoice();
  saveTrust();
  if (guildId && !currentGuild()) {
    guildId = null;
    roomId = null;
  }
  if (roomId && !currentRoom()) roomId = null;
  if (guildId && !roomId) roomId = defaultRoom(currentGuild());
  $("#my-name").textContent = state.me.display;
  $("#connection").textContent = {
    online: "オンライン",
    idle: "退席中",
    dnd: "取り込み中",
    invisible: "オフライン表示",
  }[state.me.profile?.status ?? "online"];
  $("#my-avatar").replaceWith(
    Object.assign(avatar(state.me, true), { id: "my-avatar" }),
  );
  renderNav();
  if (roomId) await loadHistory(roomId);
  else renderMessages();
  renderMembers();
}
const initials = (s) => (s ?? "?").slice(0, 2).toUpperCase();
const imageCache = new Map();
async function profileImage(descriptor) {
  const key = descriptor.id + ":" + descriptor.hash + ":" + descriptor.key;
  if (!imageCache.has(key))
    imageCache.set(
      key,
      (async () => {
        if (
          !/^[\w-]{1,100}$/.test(descriptor.id) ||
          descriptor.mime !== "image/webp"
        )
          throw Error("画像が不正");
        const response = await fetch("/api/files/" + descriptor.id);
        if (!response.ok) throw Error("画像を取得できない");
        const data = await C.decryptFile(
            await response.arrayBuffer(),
            descriptor,
          ),
          blob = new Blob([data], { type: "image/webp" }),
          bitmap = await createImageBitmap(blob);
        if (bitmap.width !== 128 || bitmap.height !== 128) {
          bitmap.close();
          throw Error("画像サイズが不正");
        }
        bitmap.close();
        return URL.createObjectURL(blob);
      })(),
    );
  return imageCache.get(key);
}
function avatar(u, online = false) {
  const status = u?.profile?.status ?? "online",
    a = node(
      "div",
      {
        class:
          "avatar" +
          (online && status !== "invisible" ? " online status-" + status : ""),
      },
      initials(u?.display ?? u?.username),
    );
  if (u?.profile?.avatar)
    profileImage(u.profile.avatar)
      .then((url) =>
        a.replaceChildren(node("img", { src: url, alt: "", loading: "lazy" })),
      )
      .catch(() => {});
  return a;
}
async function uploadProfileImage(file) {
  const { ciphertext, descriptor } = await C.encryptFile(file);
  const response = await fetch("/api/files", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: ciphertext,
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error ?? "画像を保存できない");
  const { id } = result;
  return { ...descriptor, id };
}
function renderNav() {
  const list = $("#guild-list");
  list.replaceChildren();
  $("#home").classList.toggle("active", !guildId);
  for (const g of state.guilds) {
    const b = button(
      initials(g.name),
      async () => selectGuild(g.id),
      "rail-item" + (guildId === g.id ? " active" : ""),
    );
    b.title = g.name;
    b.setAttribute("aria-label", g.name);
    if (g.profile?.icon) {
      b.replaceChildren(
        avatar({ display: g.name, profile: { avatar: g.profile.icon } }),
      );
      b.classList.add("has-image");
    }
    workspaceUI.bind(b, () => workspaceUI.guildItems(g));
    list.append(b);
  }
  const g = currentGuild();
  $("#side-title").textContent = g?.name ?? "ダイレクトメッセージ";
  $("#side-menu").hidden = !g;
  const channels = $("#channel-list");
  channels.replaceChildren();
  if (g) {
    const owner = g.owner === me.id,
      manager = hasPermission("manageChannels", g);
    for (const group of [
      { id: null, name: "チャンネル" },
      ...(g.categories ?? []),
    ]) {
      const key = g.id + ":" + (group.id ?? "none"),
        collapsed = !!preferences().collapsedCategories?.[key],
        heading = node("div", { class: "section-label category-heading" });
      const toggle = button(
        "",
        () => {
          updatePreferences({
            collapsedCategories: {
              ...preferences().collapsedCategories,
              [key]: !collapsed,
            },
          });
          renderNav();
        },
        "category-toggle",
      );
      toggle.append(icon("chevron", 14), node("span", {}, group.name));
      toggle.setAttribute("aria-expanded", String(!collapsed));
      toggle.classList.toggle("collapsed", collapsed);
      heading.append(toggle);
      if (manager)
        heading.append(
          iconButton("plus", group.name + "にチャンネルを作成", () =>
            newChannel("text", undefined, group.id),
          ),
        );
      if (group.id) {
        workspaceUI.bind(heading, () => workspaceUI.categoryItems(g, group));
        channels.append(heading);
        if (collapsed) continue;
      }
      for (const r of g.channels.filter(
        (r) => (r.category ?? null) === group.id,
      )) {
        const kind = r.kind,
          b = button(
            "",
            () => (kind === "voice" ? joinVoice(r.id) : selectRoom(r.id)),
            "channel" +
              (roomId === r.id ? " active" : "") +
              (unread.has(r.id) ? " unread" : ""),
          );
        b.append(
          node(
            "span",
            { class: "symbol" },
            icon(
              kind === "voice"
                ? "volume"
                : kind === "announcement"
                  ? "megaphone"
                  : kind === "rules"
                    ? "book"
                    : "hash",
              20,
            ),
          ),
          node("span", { class: "channel-name" }, r.name),
        );
        b.setAttribute("aria-label", r.name);
        if (activeVoice === r.id)
          b.append(node("span", { class: "badge" }, "接続中"));
        workspaceUI.bind(b, () => workspaceUI.channelItems(g, r));
        channels.append(b);
        if (kind === "voice")
          for (const entry of state.voice ?? []) {
            if (entry.room !== r.id) continue;
            const u = users.get(entry.user);
            if (!u) continue;
            const row = button("", () => memberDialog(u), "voice-member");
            row.append(avatar(u), node("span", {}, u.display));
            if (entry.user === me.id && preferences().muted)
              row.append(icon("micOff", 14));
            channels.append(row);
          }
      }
    }
    if (owner && g.requests.length) {
      channels.append(
        node(
          "div",
          { class: "section-label" },
          "参加申請 " + g.requests.length,
        ),
      );
      for (const u of g.requests)
        channels.append(
          button(u.display + " を確認", () => approveDialog(u), "channel"),
        );
    }
  } else {
    const h = node("div", { class: "section-label" }, "ダイレクトメッセージ");
    h.append(iconButton("plus", "DM を開始", newDM));
    channels.append(h);
    for (const r of state.dms) {
      const other = users.get(r.users.find((id) => id !== me.id));
      const b = button(
        "",
        () => selectRoom(r.id),
        "channel" +
          (roomId === r.id ? " active" : "") +
          (unread.has(r.id) ? " unread" : ""),
      );
      b.append(
        avatar(other, state.online.includes(other.id)),
        node("span", { class: "channel-name" }, other.display),
      );
      channels.append(b);
    }
  }
  const r = currentRoom();
  $("#room-name").textContent = r
    ? r.kind === "dm"
      ? users.get(r.users.find((id) => id !== me.id)).display
      : r.name
    : (g?.name ?? "ダイレクトメッセージ");
  $("#room-topic").textContent = r?.topic ?? "";
  $("#room-topic").title = r?.topic ?? "";
  $("#room-symbol").replaceChildren(
    icon(
      r?.kind === "dm"
        ? "users"
        : r?.kind === "voice"
          ? "volume"
          : r?.kind === "announcement"
            ? "megaphone"
            : r?.kind === "rules"
              ? "book"
              : "hash",
      24,
    ),
  );
  $("#call").hidden = !r || !["dm", "voice"].includes(r.kind);
  $("#composer-area").hidden = !r || r.kind === "voice";
  $("#message-input").placeholder = r
    ? (r.kind === "dm" ? "@" : "#") +
      $("#room-name").textContent +
      " へメッセージを送信"
    : "メッセージを送信";
  $(".main").classList.toggle("voice-view", r?.kind === "voice");
  $("#call-stage").hidden = !(activeVoice && r?.id === activeVoice);
  $("#stage-controls").hidden = !(activeVoice && r?.id === activeVoice);
  renderChannelAccess();
}
function clearComposer() {
  typingUsers.clear();
  renderTyping();
  mentionInput.close();
  productivity.closeCandidates();
  $("#message-input").value = "";
  $("#message-input").style.height = "";
  attachments = [];
  reply = null;
  $("#reply-bar").hidden = true;
  renderAttachments();
}
function defaultRoom(g) {
  return (
    g?.channels.find(
      (r) => r.id === g.profile?.defaultChannel && r.kind !== "voice",
    )?.id ??
    g?.channels.find((r) => r.kind !== "voice")?.id ??
    null
  );
}
async function selectGuild(id) {
  if (sending) throw Error("送信が完了してからチャンネルを変更して");
  guildId = id;
  roomId = defaultRoom(currentGuild());
  reply = null;
  $("#search").value = "";
  clearComposer();
  renderNav();
  renderMembers();
  if (roomId) await loadHistory(roomId);
  else renderMessages();
}
async function selectRoom(id) {
  if (sending) throw Error("送信が完了してからチャンネルを変更して");
  roomId = id;
  reply = null;
  $("#reply-bar").hidden = true;
  $("#search").value = "";
  unread.delete(id);
  clearComposer();
  $("#workspace").classList.remove("show-sidebar");
  renderNav();
  renderMembers();
  await loadHistory(id);
  if (reply) {
    const original = projection().find((m) => m.id === reply);
    if (original) setReply(original);
  }
  $("#message-input").focus();
}
function renderMembers() {
  const panel = $("#members");
  panel.replaceChildren();
  let list = [];
  try {
    list = currentRoom()
      ? recipients()
      : (currentGuild()?.roster.members.map((m) => ({
          ...users.get(m.id),
          ...m,
        })) ??
        state.users.filter(
          (u) =>
            u.id !== me.id &&
            state.online.includes(u.id) &&
            u.profile?.status !== "invisible",
        ));
  } catch {}
  $("#members-panel h2").textContent =
    (!currentRoom() && !currentGuild() ? "オンライン — " : "メンバー — ") +
    list.length;
  for (const u of list) {
    const b = button("", () => memberDialog(u), "member");
    b.append(
      avatar(u, state.online.includes(u.id)),
      node(
        "div",
        {},
        node("strong", {}, u.display ?? u.username),
        node("small", {}, u.role === "owner" ? "所有者" : "@" + u.username),
      ),
    );
    panel.append(b);
  }
}
function renderHistoryStatus() {
  const root = $("#history-status"),
    room = currentRoom(),
    cache = histories.get(roomId);
  root.replaceChildren();
  root.hidden = true;
  if (!room || room.kind === "voice") return;
  if (loading.has(roomId)) root.append("読み込み中…");
  else if (cache?.error)
    root.append(
      "履歴を取得できない",
      button("再試行", () => loadHistory(roomId)),
    );
  else if (cache?.more)
    root.append(button("続きを読み込む", () => loadHistory(roomId)));
  root.hidden = !root.childNodes.length;
}
async function loadHistory(id) {
  const identity = me;
  if (!identity) return;
  if (loading.has(id)) {
    reloadHistory.add(id);
    return loading.get(id);
  }
  const task = (async () => {
    const cache = histories.get(id) ?? {
      cursor: 0,
      events: [],
      seen: new Set(),
      error: null,
    };
    histories.set(id, cache);
    cache.error = null;
    cache.more = false;
    for (let page = 0; page < 100; page++) {
      const batch = await api("/rooms/" + id + "/events?after=" + cache.cursor);
      if (me !== identity) return;
      cache.more = batch.length === 100;
      if (!batch.length) break;
      for (const event of batch) {
        cache.cursor = Math.max(cache.cursor, event.seq);
        if (cache.seen.has(event.id)) continue;
        cache.seen.add(event.id);
        try {
          const room =
            state.dms.find((r) => r.id === id) ??
            state.guilds.flatMap((g) => g.channels).find((r) => r.id === id);
          let author = event.authorUser;
          if (room.guild) {
            const cert = event.certificate,
              g = state.guilds.find((g) => g.id === room.guild),
              owner = users.get(g.owner);
            if (
              !cert ||
              (cert.baseRoster ?? cert.roster).guild !== room.guild ||
              (cert.version ?? cert.roster.version) !==
                event.envelope.header.version
            )
              throw Error("過去のメンバー証明が不正");
            await validateRoster(
              cert.baseRoster ?? cert.roster,
              cert.signature,
              owner.keys,
            );
            const signedRoster = cert.baseRoster
              ? await M.validateCertificate(cert, owner.keys)
              : cert.roster;
            const certified = signedRoster.members.find(
              (m) => m.id === event.author,
            );
            if (!certified)
              throw Error("送信者が署名済みメンバーに含まれていない");
            author = { ...author, keys: certified.keys };
          } else {
            if (!room.users.includes(event.author))
              throw Error("DMの送信者が不正");
            await pinUser(author);
          }
          if (
            event.envelope.header.id !== event.id ||
            event.envelope.header.author !== event.author
          )
            throw Error("メッセージIDが一致しない");
          const payload = await M.openEvent(
            event.envelope,
            me,
            author.keys,
            id,
            historyCredentials.get(room.guild) ?? [],
          );
          cache.events.push({ ...event, payload, authorUser: author });
        } catch (e) {
          if (e.message !== "この端末宛ての暗号鍵がない")
            cache.events.push({ ...event, invalid: e.message });
        }
      }
      if (batch.length < 100) break;
    }
    if (roomId === id) renderMessages();
  })();
  loading.set(id, task);
  if (roomId === id) renderHistoryStatus();
  try {
    await task;
  } catch (error) {
    if (me === identity && histories.has(id))
      histories.get(id).error = error.message;
    throw error;
  } finally {
    if (loading.get(id) === task) {
      loading.delete(id);
      if (roomId === id) renderHistoryStatus();
      const again = reloadHistory.delete(id);
      if (again && me === identity && !histories.get(id)?.error)
        await loadHistory(id);
    }
  }
}
function projection() {
  const events = histories.get(roomId)?.events ?? [],
    messages = new Map();
  for (const e of events) {
    if (e.invalid) {
      messages.set(e.id, {
        ...e,
        text: "検証失敗: " + e.invalid,
        invalid: true,
      });
      continue;
    }
    const p = e.payload;
    if (
      p.type === "message" &&
      typeof p.text === "string" &&
      p.text.length <= 8000 &&
      Array.isArray(p.files)
    )
      messages.set(e.id, {
        ...e,
        text: p.text,
        files: p.files,
        reply: p.reply,
        reactions: {},
        pinned: false,
        deleted: false,
      });
    else {
      const target = messages.get(p.target);
      if (!target || target.invalid) continue;
      if (
        p.type === "edit" &&
        e.author === target.author &&
        !target.deleted &&
        typeof p.text === "string" &&
        p.text.length <= 8000
      ) {
        target.text = p.text;
        target.edited = true;
      }
      if (p.type === "delete" && e.author === target.author) {
        target.deleted = true;
        target.text = "";
        target.files = [];
      }
      if (
        p.type === "reaction" &&
        typeof p.emoji === "string" &&
        p.emoji.length <= 100
      ) {
        const set = target.reactions[p.emoji] ?? new Set();
        p.add ? set.add(e.author) : set.delete(e.author);
        target.reactions[p.emoji] = set;
      }
      if (p.type === "pin" && typeof p.on === "boolean") target.pinned = p.on;
    }
  }
  return [...messages.values()].filter((message) => !message.deleted);
}
function richText(s) {
  return communityUI.richText(s);
}
function hasPermission(permission, g = currentGuild()) {
  return !g || g.owner === me.id || !!g.myPermissions?.[permission];
}
function roleList(uid, g = currentGuild()) {
  return (g?.roles ?? [])
    .filter(
      (r) => !r.isDefault && (g.roleAssignments?.[uid] ?? []).includes(r.id),
    )
    .sort((a, b) => b.position - a.position);
}
function roleChips(uid) {
  return node(
    "div",
    { class: "member-role-chips" },
    ...roleList(uid).map((r) => {
      const chip = node("span", { class: "member-role-chip" }, r.name);
      chip.style.setProperty("--role-color", r.color);
      return chip;
    }),
  );
}
function renderChannelAccess() {
  const g = currentGuild(),
    r = currentRoom(),
    notice = $("#notice");
  notice.replaceChildren();
  notice.hidden = true;
  const restricted =
      !!g &&
      !!r &&
      ["announcement", "rules"].includes(r.kind) &&
      !hasPermission("manageMessages", g),
    needsRules = !!g && !!g.rules?.requireAcceptance && !g.rulesAccepted;
  const dmDenied = !!r && state.unavailableDMs?.includes(r.id);
  const denied =
    dmDenied || restricted || needsRules || !hasPermission("sendMessages", g);
  $("#call").disabled = !!dmDenied;
  if (dmDenied) {
    notice.hidden = false;
    const other = r.users.find((id) => id !== me.id);
    notice.append(
      node(
        "span",
        {},
        blockedUser(other) ? "ブロック中" : "このDMには送信できません",
      ),
    );
    if (blockedUser(other))
      notice.append(button("ブロックを解除", () => setBlocked(other, false)));
  }
  $("#message-input").disabled = denied;
  for (const id of ["send", "attach", "emoji"]) $("#" + id).disabled = denied;
  if (needsRules) {
    notice.hidden = false;
    notice.append(icon("book", 20), node("span", {}, "サーバールール"));
    if (g.rules.channel && r?.id !== g.rules.channel)
      notice.append(button("ルールを見る", () => selectRoom(g.rules.channel)));
    if (r?.id === g.rules.channel)
      notice.append(
        button(
          "ルールに同意",
          async () => {
            await api("/guilds/" + g.id + "/rules/accept", {
              version: g.rules.version,
            });
            await refresh();
          },
          "primary",
        ),
      );
  } else if (restricted) {
    notice.hidden = false;
    notice.append(
      icon(r.kind === "rules" ? "book" : "megaphone", 20),
      node("span", {}, r.kind === "rules" ? "サーバールール" : "お知らせ"),
    );
  }
  if (r?.slowmode && !hasPermission("manageMessages", g)) {
    notice.hidden = false;
    notice.append(
      node(
        "span",
        { class: "slowmode-label" },
        r.slowmode + "秒のスローモード",
      ),
    );
  }
}
function renderMessages() {
  renderHistoryStatus();
  const area = $("#messages");
  const nearBottom =
    area.scrollHeight - area.scrollTop - area.clientHeight < 180;
  const old = area.scrollTop;
  area.replaceChildren();
  const r = currentRoom();
  if (r?.kind === "voice") {
    if (activeVoice !== r.id)
      area.append(
        node(
          "div",
          { class: "voice-empty" },
          node("div", { class: "voice-empty-icon" }, icon("volume", 52)),
          node("h2", {}, r.name),
          button("通話に参加", () => joinVoice(r.id), "primary"),
        ),
      );
    return;
  }
  if (!r) {
    area.append(workspaceUI.home());
    return;
  }
  const query = $("#search").value.toLowerCase();
  const list = projection().filter(
    (m) => !query || m.text.toLowerCase().includes(query),
  );
  if (!list.length) {
    area.append(
      node(
        "div",
        { class: "welcome" },
        node(
          "div",
          { class: "welcome-icon" },
          icon(r.kind === "dm" ? "users" : "hash", 34),
        ),
        node(
          "h2",
          {},
          query ? "一致するメッセージはない" : $("#room-name").textContent,
        ),
      ),
    );
  }
  let day = "",
    previousMessage = null;
  for (const m of list) {
    if (blockedUser(m.author) && !revealedBlocked.has(m.id)) {
      const hidden = button(
        "ブロック中のメッセージを表示",
        () => {
          revealedBlocked.add(m.id);
          renderMessages();
        },
        "blocked-message",
      );
      hidden.setAttribute("data-blocked-message", m.id);
      area.append(hidden);
      previousMessage = null;
      continue;
    }
    const date = new Date(m.envelope.header.at),
      nextDay = date.toLocaleDateString("ja-JP", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
    if (nextDay !== day) {
      area.append(node("div", { class: "date-divider" }, nextDay));
      day = nextDay;
    }
    const u = users.get(m.author) ?? m.authorUser,
      content = node("div", { class: "message-content" }),
      row = node("article", {
        class: "message",
        tabindex: "0",
        "data-message": m.id,
      });
    row.classList.toggle(
      "is-mentioned",
      !m.deleted && !m.invalid && isMentioned(m.text, me.id, currentGuild()),
    );
    const face = button("", () => memberDialog(u), "message-avatar");
    face.setAttribute(
      "aria-label",
      (u?.display ?? "ユーザー") + "のプロフィール",
    );
    face.append(avatar(u));
    row.append(face, content);
    row.classList.toggle(
      "is-grouped",
      preferences().groupMessages !== false &&
        previousMessage?.author === m.author &&
        date - previousMessage.date < 300000 &&
        !m.reply &&
        !m.pinned,
    );
    previousMessage = { author: m.author, date };
    if (m.pinned)
      content.append(
        node("div", { class: "pinned-label" }, icon("pin", 13), "ピン留め"),
      );
    if (m.reply) {
      const original = projection().find((x) => x.id === m.reply);
      content.append(
        node(
          "div",
          { class: "reply-preview" },
          "返信: " +
            (blockedUser(original?.author)
              ? "ブロック中のメッセージ"
              : (original?.text ?? "以前のメッセージ").slice(0, 120)),
        ),
      );
    }
    content.append(
      node(
        "div",
        { class: "message-meta" },
        (() => {
          const author = button(
            u?.display ?? "ユーザー",
            () => memberDialog(u),
            "author-button",
          );
          const role = roleList(u?.id)[0];
          if (role) author.style.color = role.color;
          return author;
        })(),
        node(
          "time",
          { datetime: date.toISOString() },
          date.toLocaleTimeString("ja-JP", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: preferences().timeFormat === "12",
          }),
        ),
        m.invalid ? node("span", { class: "error" }, "検証失敗") : null,
      ),
    );
    const text = richText(m.text);
    if (m.deleted) text.classList.add("deleted");
    if (m.edited) text.append(node("span", { class: "edited" }, "編集済み"));
    content.append(text);
    if (!m.invalid && !m.deleted) {
      for (const f of m.files ?? []) {
        const preview = mediaPreview.card(f, m.id);
        if (preview) {
          content.append(preview);
          continue;
        }
        const file = node(
          "div",
          { class: "file-card" },
          icon("download", 26),
          node(
            "div",
            {},
            node("strong", {}, String(f.name)),
            node("small", {}, formatSize(f.size)),
          ),
          button("保存", () => downloadFile(f)),
        );
        content.append(file);
      }
      const actions = node("div", { class: "message-actions" });
      actions.append(
        iconButton("reply", "返信", () => setReply(m)),
        iconButton("smile", "リアクション", () => reactionDialog(m)),
      );
      if (hasPermission("manageMessages"))
        actions.append(
          iconButton("pin", m.pinned ? "ピン留めを解除" : "ピン留め", () =>
            sendPayload({ type: "pin", target: m.id, on: !m.pinned }),
          ),
        );
      if (m.author === me.id)
        actions.append(
          iconButton("edit", "メッセージを編集", () => editMessage(m)),
          iconButton("trash", "メッセージを削除", (e) =>
            deleteMessage(m, e.shiftKey),
          ),
        );
      row.append(actions);
      const reactions = node("div", { class: "reactions" });
      for (const [emoji, set] of Object.entries(m.reactions))
        if (set.size) {
          const reaction = button(
            "",
            () =>
              sendPayload({
                type: "reaction",
                target: m.id,
                emoji,
                add: !set.has(me.id),
              }),
            "reaction" + (set.has(me.id) ? " mine" : ""),
          );
          reaction.setAttribute("aria-label", emoji + " " + set.size);
          reaction.append(
            communityUI.emojiNode(emoji),
            node("span", {}, String(set.size)),
          );
          reactions.append(reaction);
        }
      content.append(reactions);
    }
    area.append(row);
  }
  area.scrollTop = nearBottom ? area.scrollHeight : old;
  communityUI.refreshPins();
}
const formatSize = (n) =>
  n >= 1024 * 1024
    ? (n / 1024 / 1024).toFixed(1) + " MiB"
    : Math.ceil(n / 1024) + " KiB";
async function sendPayload(payload) {
  const room = currentRoom();
  if (!room) throw Error("チャンネルを選んで");
  for (let attempt = 0; attempt < 2; attempt++) {
    const g = state.guilds.find((g) => g.id === room.guild),
      rec = recipients(room);
    for (const u of rec) await pinUser(u);
    const envelope = await C.seal(payload, {
      room: room.id,
      author: me.id,
      recipients: rec,
      identity: me,
      version: g?.version ?? 0,
      historyWrap: g
        ? (key, eph, context) =>
            M.wrapHistoryKeys(
              key,
              eph,
              context,
              g.activeInvites,
              users.get(g.owner).keys,
              {
                guild: g.id,
                inviteCutoff: g.roster.inviteCutoff ?? 0,
                baseVersion: (g.certificate?.baseRoster ?? g.roster).version,
              },
            )
        : null,
    });
    try {
      await api("/rooms/" + room.id + "/events", envelope);
      break;
    } catch (error) {
      if (error.status !== 409 || attempt === 1) throw error;
      await refresh();
    }
  }
  await loadHistory(room.id).catch(() => toast("送信済み。履歴の更新を待って"));
}

function setReply(m) {
  reply = m.id;
  $("#reply-bar").hidden = false;
  $("#reply-bar").replaceChildren(
    node(
      "span",
      {},
      (m.authorUser?.display ?? "ユーザー") + " に返信: " + m.text.slice(0, 70),
    ),
    button("×", () => {
      reply = null;
      $("#reply-bar").hidden = true;
    }),
  );
  $("#message-input").focus();
}
function renderAttachments() {
  $("#attachment-list").replaceChildren(
    ...attachments.map((f, i) =>
      node(
        "div",
        { class: "attachment-chip" },
        f.name + " · " + formatSize(f.size),
        button("×", () => {
          attachments.splice(i, 1);
          renderAttachments();
        }),
      ),
    ),
  );
}
async function sendMessage(e) {
  e.preventDefault();
  if (sending) return;
  const input = $("#message-input"),
    text = input.value.trim();
  if (!text && !attachments.length) return;
  if (!navigator.onLine) throw Error("オフライン");
  sending = true;
  $("#send").disabled = true;
  $("#attach").disabled = true;
  input.disabled = true;
  const uploaded = [],
    pendingFiles = [...attachments];
  let sendAttempted = false;
  try {
    for (const f of pendingFiles) {
      const { ciphertext, descriptor } = await C.encryptFile(f);
      const res = await fetch("/api/files", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: ciphertext,
      });
      const result = await res.json();
      if (!res.ok) throw Error(result.error);
      uploaded.push({ ...descriptor, ...result });
    }
    sendAttempted = true;
    await sendPayload({ type: "message", text, files: uploaded, reply });
    input.value = "";
    mentionInput.close();
    input.style.height = "";
    reply = null;
    attachments = [];
    $("#reply-bar").hidden = true;
    renderAttachments();
    $("#messages").scrollTop = $("#messages").scrollHeight;
  } catch (error) {
    // An interrupted POST may already be committed; never remove its attachments blindly.
    if (!sendAttempted)
      for (const f of uploaded)
        await api(
          "/files/" + f.id,
          { password: f.removePassword },
          "DELETE",
        ).catch(() => {});
    throw error;
  } finally {
    sending = false;
    $("#send").disabled = false;
    $("#attach").disabled = false;
    input.disabled = false;
    renderChannelAccess();
    input.focus();
  }
}
async function downloadFile(f) {
  if (!/^[\w-]{1,100}$/.test(f.id)) throw Error("添付IDが不正");
  toast("添付を取得・検証中");
  const res = await fetch("/api/files/" + f.id);
  if (!res.ok) throw Error("添付を取得できない");
  const plain = await C.decryptFile(await res.arrayBuffer(), f);
  const url = URL.createObjectURL(
    new Blob([plain], { type: "application/octet-stream" }),
  );
  const a = node("a", {
    href: url,
    download: String(f.name).replace(/[\\/\x00-\x1f]/g, "_"),
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $("#toast").hidden = true;
}
function modal(title, body, submit, label = "保存") {
  const dialog = $("#modal");
  if (dialog.open) dialog.close();
  $("#modal-title").textContent = title;
  $("#modal-body").replaceChildren(...(Array.isArray(body) ? body : [body]));
  $("#modal-error").textContent = "";
  $("#modal-submit").hidden = !submit;
  $("#modal-cancel").textContent = submit ? "キャンセル" : "閉じる";
  $("#modal-submit").textContent = label;
  $("#modal-form").onsubmit = async (e) => {
    e.preventDefault();
    $("#modal-submit").disabled = true;
    try {
      if (submit) await submit();
      dialog.close();
    } catch (error) {
      $("#modal-error").textContent = error.message;
    } finally {
      $("#modal-submit").disabled = false;
    }
  };
  dialog.showModal();
}
function field(label, value = "", type = "text") {
  const input = node("input", { value, type, required: true });
  return { input, node: node("label", {}, label, input) };
}
function prompt(title, label, value, submit, buttonLabel = "保存") {
  const f = field(label, value);
  modal(title, f.node, () => submit(f.input.value), buttonLabel);
}
async function createGuild() {
  if (state.guilds.length >= 30)
    throw Error("参加できるサーバーは30個までです");
  prompt(
    "サーバーを作成",
    "サーバー名",
    "",
    async (name) => {
      const id = crypto.randomUUID();
      const roster = {
        guild: id,
        owner: me.id,
        version: 1,
        members: [{ id: me.id, keys: me.keys, role: "owner" }],
      };
      await api("/guilds", {
        name,
        roster,
        signature: await C.sign(roster, me),
      });
      await pinGuildOwner(id, me.id, me.keys);
      await refresh();
      await selectGuild(id);
    },
    "作成",
  );
}
function guildActions() {
  const g = currentGuild();
  if (!g) return;
  const menu = $("#guild-menu");
  if (!menu.hidden) {
    menu.hidden = true;
    return;
  }
  menu.replaceChildren();
  function item(label, name, fn, cls = "") {
    const el = button(
      "",
      async () => {
        menu.hidden = true;
        await fn();
      },
      "guild-menu-item " + cls,
    );
    el.append(node("span", {}, label), icon(name, 20));
    menu.append(el);
  }
  if (g.owner === me.id) item("友達を招待", "users", inviteDialog);
  else item("サーバーから退出", "logout", () => leaveGuild(g), "danger");
  item("サーバー設定", "settings", () => settingsUI.server());
  if (g.owner === me.id) {
    item("チャンネルを作成", "plus", () => newChannel("text"));
    if (g.requests.length)
      item("参加申請 · " + g.requests.length, "users", () =>
        settingsUI.server("members"),
      );
  }
  const rect = $(".side-header").getBoundingClientRect();
  menu.style.left = rect.left + 8 + "px";
  menu.style.top = rect.bottom + 7 + "px";
  menu.style.width = rect.width - 16 + "px";
  menu.hidden = false;
}
function confirmAction(title, fn) {
  modal(title, node("p", {}, "この操作を実行する？"), fn, "実行");
}
async function inviteDialog(onCreated) {
  const g = currentGuild(),
    expiry = node("select", { "aria-label": "有効期限" }),
    uses = node("select", { "aria-label": "利用回数" }),
    approval = node("input", {
      type: "checkbox",
      "aria-label": "参加に承認が必要",
    });
  for (const [value, label] of [
    [3600, "1時間"],
    [86400, "24時間"],
    [604800, "7日間"],
    [0, "期限なし"],
  ])
    expiry.append(node("option", { value }, label));
  expiry.value = "86400";
  for (const value of [0, 1, 5, 10, 25, 100])
    uses.append(node("option", { value }, value ? value + "回" : "無制限"));
  const result = node("div", { class: "invite-result", hidden: true }),
    generate = button(
      "リンクを作成",
      async () => {
        generate.disabled = true;
        generate.textContent = "リンクを作成中…";
        try {
          const events = [];
          for (const room of g.channels.filter((r) => r.kind !== "voice")) {
            for (let page = 0; page < 100; page++) {
              const before = histories.get(room.id)?.cursor ?? 0;
              await loadHistory(room.id);
              const cache = histories.get(room.id);
              if (cache.error) throw Error(cache.error);
              if (cache.cursor === before) break;
            }
            events.push(
              ...(histories.get(room.id)?.events ?? []).filter(
                (e) => !e.invalid,
              ),
            );
          }
          const history = await M.buildHistory(
              events,
              me,
              historyCredentials.get(g.id) ?? [],
            ),
            seconds = Number(expiry.value),
            created = await M.createGrant(
              {
                guild: g.id,
                owner: g.owner,
                baseVersion: (g.certificate?.baseRoster ?? g.roster).version,
                expires: seconds ? Date.now() + seconds * 1000 : null,
                maxUses: Number(uses.value),
                approval: approval.checked,
                history,
              },
              me,
            ),
            { secret, ...published } = created;
          await api("/guilds/" + g.id + "/invitations", published);
          const url =
            location.origin + "/#join=" + created.grant.id + "." + secret;
          result.replaceChildren(
            node("input", {
              readonly: true,
              value: url,
              "aria-label": "招待リンク",
            }),
            button(
              "コピー",
              async () => {
                await navigator.clipboard.writeText(url);
                toast("コピーした");
              },
              "primary",
            ),
          );
          result.hidden = false;
          generate.textContent = "新しいリンクを作成";
          await refresh();
          if (typeof onCreated === "function") await onCreated();
        } finally {
          generate.disabled = false;
          generate.textContent = result.hidden
            ? "リンクを作成"
            : "新しいリンクを作成";
        }
      },
      "primary",
    );
  modal(
    "友達を招待",
    node(
      "div",
      { class: "invite-panel" },
      node(
        "div",
        { class: "invite-server-preview" },
        avatar({ display: g.name, profile: { avatar: g.profile?.icon } }),
        node(
          "div",
          {},
          node("h3", {}, g.name),
          node("small", {}, g.roster.members.length + "人のメンバー"),
        ),
      ),
      node(
        "div",
        { class: "invite-options" },
        node("label", {}, "有効期限", expiry),
        node("label", {}, "利用回数", uses),
      ),
      node("label", { class: "invite-approval" }, approval, "参加に承認が必要"),
      generate,
      result,
    ),
  );
}
async function acceptInvite(data) {
  if (data?.short) {
    const invite = await api("/invitations/" + data.id),
      owner = invite.guild;
    if (
      invite.grant.guild !== owner.id ||
      invite.grant.owner !== owner.owner ||
      !(await M.verifyGrant(invite.grant, invite.signature, owner.keys))
    )
      throw Error("招待の署名が不正");
    await pinGuildOwner(owner.id, owner.owner, owner.keys);
    await pinUser({ id: owner.owner, display: owner.name, keys: owner.keys });
    modal(
      "サーバーに参加",
      node(
        "div",
        { class: "join-preview" },
        icon("users", 36),
        node("h3", {}, owner.name),
      ),
      async () => {
        const proof = await M.admit(invite, data.secret, me),
          credential = await M.createCredential(invite, data.secret, me),
          joined = await api("/invitations/" + data.id + "/join", proof);
        await api("/guilds/" + owner.id + "/history-credentials", {
          invite: data.id,
          envelope: credential,
        });
        invalidateCredentials(owner.id);
        for (const r of state.guilds.find((g) => g.id === owner.id)?.channels ??
          [])
          histories.delete(r.id);
        pendingInvite = null;
        history.replaceState(null, "", location.pathname + location.search);
        await refresh();
        if (!joined.approval) await selectGuild(owner.id);
        else toast("参加申請を送信した");
      },
      invite.grant.approval ? "参加申請" : "参加",
    );
    return;
  }
  if (!data?.guild || !data.owner || !data.keys || !data.token)
    throw Error("招待の形式が不正");
  await pinGuildOwner(data.guild, data.owner, data.keys);
  modal(
    "サーバーに参加",
    node("div", { class: "join-preview" }, icon("users", 36)),
    async () => {
      await api("/guilds/" + data.guild + "/join", { token: data.token });
      pendingInvite = null;
      toast("参加申請を送信した");
    },
    "参加申請",
  );
}
function parseInvite(url) {
  if (url.origin !== location.origin)
    throw Error("このアプリの招待リンクを指定して");
  if (url.hash.startsWith("#join=")) {
    const match = url.hash
      .slice(6)
      .match(/^([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/);
    if (!match) throw Error("招待リンクの形式が不正");
    return { short: true, id: match[1], secret: match[2] };
  }
  if (!url.hash.startsWith("#invite=")) throw Error("招待リンクの形式が不正");
  return JSON.parse(
    new TextDecoder().decode(C.unb64(decodeURIComponent(url.hash.slice(8)))),
  );
}
async function approveDialog(u) {
  const fp = await C.fingerprint(u.keys);
  const body = node(
    "div",
    {},
    node("p", {}, "表示名: " + u.display + " / @" + u.username),
    node("div", { class: "fingerprint" }, fp),
    node(
      "p",
      {},
      "指紋を相手と照合してから承認して。承認後に送信されるメッセージを受信できる。",
    ),
    button(
      "申請を拒否",
      async () => {
        await api("/guilds/" + guildId + "/reject", { user: u.id });
        $("#modal").close();
        await refresh();
      },
      "danger",
    ),
  );
  modal(
    "参加申請の確認",
    body,
    async () => {
      await pinUser(u);
      const g = currentGuild();
      await updateRoster([
        ...g.roster.members,
        { id: u.id, keys: u.keys, role: "member" },
      ]);
    },
    "承認",
  );
}
async function updateRoster(members) {
  const g = currentGuild(),
    roster = { guild: g.id, owner: g.owner, version: g.version + 1, members };
  await api(
    "/guilds/" + g.id + "/roster",
    { roster, signature: await C.sign(roster, me) },
    "PUT",
  );
  await refresh();
}
function newChannel(kind = "text", onCreated, category = null) {
  workspaceUI.channelDialog({ kind, category, onSaved: onCreated });
}

async function leaveRecord(g) {
  const proof = M.departure(
    g.id,
    me.id,
    (g.certificate?.baseRoster ?? g.roster).version,
  );
  return { proof, signature: await C.sign(proof, me) };
}
function leaveGuild(g = currentGuild()) {
  if (!g || g.owner === me.id)
    throw Error("所有者はサーバーを削除してから退出してください");
  modal(
    "サーバーから退出",
    [
      node("p", {}, g.name + "から退出しますか？"),
      node("p", {}, "現在の招待リンクは無効になります。"),
    ],
    async () => {
      if (sending) throw Error("送信が完了してから退出してください");
      const record = await leaveRecord(g);
      await api("/guilds/" + g.id + "/leave", record);
      (storage.departures ??= {})[g.id] = M.departureCheckpoint(
        {
          ...g.certificate,
          changes: [
            ...(g.certificate.changes ?? []),
            { type: "departure", ...record },
          ],
        },
        storage.departures?.[g.id],
      );
      saveTrust();
      if (g.channels.some((r) => r.id === activeVoice)) await leaveVoice();
      for (const r of g.channels) {
        histories.delete(r.id);
        unread.delete(r.id);
      }
      invalidateCredentials(g.id);
      if (guildId === g.id) {
        guildId = null;
        roomId = null;
        clearComposer();
      }
      settingsUI.close();
      await refresh();
    },
    "退出",
  );
}
async function setBlocked(id, on) {
  await api("/blocks/" + id, {}, on ? "PUT" : "DELETE");
  revealedBlocked.clear();
  if (on && peers.has(id)) removePeer(id);
  await refresh();
}
function wipeAccountBrowser(id) {
  if (typeof id !== "string") return;
  for (const prefix of [
    "oisiicord-trust-",
    "oisiicord-preferences-",
    "oisiicord-personal-",
    "oisiicord-emoji-recent-",
  ])
    localStorage.removeItem(prefix + id);
}
function deleteAccountDialog() {
  const account = state.me;
  const username = node("input", {
    required: true,
    "aria-label": "削除するユーザー名",
    autocomplete: "off",
  });
  const password = node("input", {
    required: true,
    type: "password",
    autocomplete: "current-password",
    "aria-label": "現在のパスワード",
  });
  const owned = state.guilds.filter((g) => g.owner === me.id);
  const confirm = node("input", {
    type: "checkbox",
    "aria-label": "所有サーバーの削除に同意",
  });
  modal(
    "アカウントを削除",
    node(
      "div",
      { class: "workspace-editor" },
      node(
        "p",
        {},
        "アカウントと所有サーバーを削除します。送信済みのメッセージは残ります。",
      ),
      owned.length
        ? node(
            "label",
            {},
            confirm,
            "所有サーバーも削除する: " + owned.map((g) => g.name).join("、"),
          )
        : null,
      node("label", {}, "ユーザー名", username),
      node("label", {}, "現在のパスワード", password),
    ),
    async () => {
      if (sending) throw Error("送信が完了してから削除してください");
      if (username.value !== account.username)
        throw Error("ユーザー名が一致しません");
      if (owned.length && !confirm.checked)
        throw Error("所有サーバーの削除を確認してください");
      const identity = me,
        id = identity.id;
      const proof = {
        v: 1,
        type: "delete-account",
        user: id,
        at: Date.now(),
        nonce: crypto.randomUUID(),
        owned: owned.map((g) => g.id).sort(),
        departures: await Promise.all(
          state.guilds.filter((g) => g.owner !== id).map(leaveRecord),
        ),
      };
      const auth = (await C.credentials(password.value, identity.salt)).auth;
      await api(
        "/me",
        { proof, signature: await C.sign(proof, identity), auth },
        "DELETE",
      );
      password.value = "";
      wipeAccountBrowser(id);
      loginChannel?.postMessage({ type: "delete", user: id });
      settingsUI.close();
      if (me?.id === id) await logout(true);
    },
    "削除",
  );
}
function newDM() {
  prompt(
    "DM を開始",
    "相手のユーザー名",
    "",
    async (username) => {
      const u = await api("/users?username=" + encodeURIComponent(username));
      await pinUser(u);
      const { id } = await api("/dms", { user: u.id });
      pinDMPeers(id, [me.id, u.id]);
      guildId = null;
      await refresh();
      await selectRoom(id);
    },
    "開始",
  );
}
async function memberDialog(u) {
  const card = workspaceUI.profileCard(u);
  const actions = node("div", { class: "buttons" });
  if (u.id !== me.id && !u.deleted)
    actions.append(
      button(
        "メッセージ",
        async () => {
          const { id } = await api("/dms", { user: u.id });
          pinDMPeers(id, [me.id, u.id]);
          guildId = null;
          $("#modal").close();
          await refresh();
          await selectRoom(id);
        },
        "primary",
      ),
    );
  else if (u.id === me.id)
    actions.append(
      button("プロフィールを編集", () => {
        $("#modal").close();
        settingsUI.user("profile");
      }),
    );
  if (u.id !== me.id && !u.deleted)
    actions.append(
      button(
        blockedUser(u.id) ? "ブロックを解除" : "ブロック",
        async () => {
          const on = !blockedUser(u.id);
          if (on)
            modal(
              "ユーザーをブロック",
              node("p", {}, u.display + "をブロックしますか？"),
              () => setBlocked(u.id, true),
              "ブロック",
            );
          else {
            await setBlocked(u.id, false);
            memberDialog(u);
          }
        },
        "danger",
      ),
    );
  actions.append(
    button("公開鍵を確認", async () => {
      const fp = await C.fingerprint(u.keys);
      modal("公開鍵の指紋", [
        node("div", { class: "fingerprint" }, fp),
        button(
          storage.verified[u.id] ? "確認済みを解除" : "一致を確認した",
          () => {
            storage.verified[u.id] = !storage.verified[u.id];
            saveTrust();
            renderMembers();
            $("#modal").close();
          },
        ),
      ]);
    }),
  );
  if (
    currentGuild()?.owner === me.id &&
    u.id !== me.id &&
    currentGuild().roster.members.some((member) => member.id === u.id)
  )
    actions.append(
      button(
        "メンバーを削除",
        () =>
          modal(
            "メンバーを削除",
            node("p", {}, u.display),
            () =>
              updateRoster(
                currentGuild().roster.members.filter((m) => m.id !== u.id),
              ),
            "削除",
          ),
        "danger",
      ),
    );
  card.append(roleChips(u.id), actions);
  modal("プロフィール", card);
}
function reactionDialog(m) {
  communityUI.emojiPicker({
    mode: "reaction",
    onSelect: (emoji) =>
      sendPayload({
        type: "reaction",
        target: m.id,
        emoji,
        add: !m.reactions[emoji]?.has(me.id),
      }),
  });
}

function editMessage(m) {
  const input = node(
    "textarea",
    { rows: 5, maxlength: 8000, required: true },
    m.text,
  );
  modal("メッセージを編集", input, () =>
    sendPayload({ type: "edit", target: m.id, text: input.value }),
  );
}
async function deleteMessage(m, skipConfirmation = false) {
  const remove = async () => {
    await sendPayload({ type: "delete", target: m.id });
    for (const f of m.files ?? [])
      if (f.removePassword)
        await api(
          "/files/" + f.id,
          { password: f.removePassword },
          "DELETE",
        ).catch(() => toast("外部APIで添付の削除に失敗した"));
  };
  if (skipConfirmation) return remove();
  modal(
    "メッセージを削除",
    node("p", {}, "このメッセージを削除しますか？"),
    remove,
    "削除",
  );
}

async function settings() {
  settingsUI.user();
}
async function backup() {
  const data = {
    format: "oisiicord-encrypted-backup-v1",
    origin: location.origin,
    username: state.me.username,
    user: me.id,
    salt: me.salt,
    keys: me.keys,
    vault: me.vault,
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  node("a", {
    href: url,
    download: "oisiicord-" + state.me.username + "-encrypted-keys.json",
  }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("パスワードで保護した鍵のバックアップを保存した");
}
async function enterAccount(result, identity) {
  me = {
    ...identity,
    salt: result.salt,
    vault: result.vault,
    session: result.session.id,
  };
  loadPreferences(me.id);
  syncVoiceControls();
  try {
    storage = JSON.parse(
      localStorage.getItem("oisiicord-trust-" + me.id) ??
        '{"pins":{},"versions":{},"verified":{}}',
    );
  } catch {
    storage = { pins: {}, versions: {}, verified: {} };
  }
  await pinUser(result.user);
  await productivity.load().catch((error) => toast(error.message));
  $("#password").value = "";
  await refresh();
  $("#auth").hidden = true;
  $("#workspace").hidden = false;
  connect();
  if (pendingInvite) await acceptInvite(pendingInvite);
}
const loginChannel =
  "BroadcastChannel" in window ? new BroadcastChannel("oisiicord-login") : null;
if (loginChannel)
  loginChannel.onmessage = (event) => {
    if (event.data?.type === "delete") {
      wipeAccountBrowser(event.data.user);
      if (me?.id === event.data.user) guard(() => logout(true));
      return;
    }
    if (
      me &&
      ((event.data.type === "logout" && event.data.session === me.session) ||
        (event.data.type === "login" && event.data.session !== me.session))
    )
      guard(() => logout(true));
  };
async function logout(revoked = false) {
  if (sending && !revoked) throw Error("送信が完了してからログアウトして");
  const sessionId = me?.session;
  await productivity.flush().catch((error) => toast(error.message));
  productivity.reset();
  await leaveVoice();
  clearTimeout(reconnectTimer);
  clearInterval(heartbeat);
  if (ws) {
    ws.onclose = null;
    ws.close();
  }
  ws = null;
  await forgetLogin(sessionId).catch(() => {});
  if (!revoked) {
    loginChannel?.postMessage({ type: "logout", session: sessionId });
    await api("/auth/logout", {}).catch(() => {});
  }
  me = null;
  guildId = null;
  roomId = null;
  historyCredentials.clear();
  credentialGenerations.clear();
  unread.clear();
  mentionInput.close();
  for (const cached of imageCache.values())
    cached.then((url) => URL.revokeObjectURL(url)).catch(() => {});
  imageCache.clear();
  mediaPreview.clear();
  clearDeveloperCaches();
  histories.clear();
  revealedBlocked.clear();
  loading.clear();
  reloadHistory.clear();
  $("#network-status").hidden = true;
  $("#history-status").hidden = true;
  attachments = [];
  reply = null;
  $("#message-input").value = "";
  renderAttachments();
  users.clear();
  state = null;
  $("#workspace").hidden = true;
  $("#auth").hidden = false;
  document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
  $("#password").value = "";
  if (registering) $("#auth-switch").click();
}
function networkStatus(connected) {
  const root = $("#network-status");
  root.hidden = connected || !me;
  if (connected && $("#toast").textContent === "オフライン")
    $("#toast").hidden = true;
  root.replaceChildren();
  if (!root.hidden)
    root.append(
      navigator.onLine ? "再接続中…" : "オフライン",
      button("再接続", reconnect),
    );
}
function reconnect() {
  clearTimeout(reconnectTimer);
  clearInterval(heartbeat);
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  if (me) connect();
}
window.addEventListener("online", reconnect);
window.addEventListener("offline", () => {
  networkStatus(false);
  ws?.close();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && me) {
    if (ws?.readyState === 1) guard(refresh);
    else reconnect();
  }
});
function connect() {
  if (!me || ws?.readyState === 0 || ws?.readyState === 1) return;
  if (!navigator.onLine) {
    networkStatus(false);
    return;
  }
  const socket = new WebSocket(location.origin.replace(/^http/, "ws") + "/ws");
  ws = socket;
  let lastPong = Date.now();
  ws.onopen = () => {
    if (ws !== socket) return;
    networkStatus(true);
    $("#connection").textContent = "オンライン";
    refresh().catch((e) => toast(e.message));
    clearInterval(heartbeat);
    heartbeat = setInterval(() => {
      if (ws !== socket) return;
      if (Date.now() - lastPong > 75000) {
        socket.close();
        return;
      }
      if (socket.readyState === 1)
        socket.send(JSON.stringify({ type: "ping" }));
    }, 30000);
  };
  ws.onclose = (event) => {
    if (ws !== socket) return;
    networkStatus(false);
    clearInterval(heartbeat);
    if (event.code === 4003) {
      wipeAccountBrowser(me.id);
      guard(() => logout(true));
      return;
    }
    if (event.code === 4001) {
      guard(() => logout(true));
      return;
    }
    $("#connection").textContent = "再接続中";
    if (activeVoice) leaveVoice();
    if (me) reconnectTimer = setTimeout(connect, 2500);
  };
  ws.onmessage = (e) =>
    guard(async () => {
      if (ws !== socket || !me) return;
      const m = JSON.parse(e.data);
      if (m.type === "pong") lastPong = Date.now();
      if (m.type === "state") await refresh();
      if (m.type === "presence" && state && users.has(m.user)) {
        state.online = state.online.filter((id) => id !== m.user);
        if (m.online) state.online.push(m.user);
        renderMembers();
        if (!currentRoom()) renderMessages();
      }
      if (m.type === "voice-presence" && state) {
        const previous = (state.voice ?? [])
          .filter((v) => v.room === m.room)
          .map((v) => v.user);
        state.voice = [
          ...(state.voice ?? []).filter((v) => v.room !== m.room),
          ...m.users.map((user) => ({ room: m.room, user })),
        ];
        if (
          activeVoice === m.room &&
          m.users.some(
            (id) => id !== me.id && !blockedUser(id) && !previous.includes(id),
          )
        )
          sound("peerJoin");
        renderNav();
      }
      if (m.type === "voice-replaced") await leaveVoice();
      if (m.type === "event") {
        const eventGuild = state.guilds.find((g) =>
          g.channels.some((r) => r.id === m.room),
        );
        await loadHistory(m.room);
        const event = histories
          .get(m.room)
          ?.events.find((e) => e.seq === m.seq);
        const notify =
          event?.author !== me.id &&
          !blockedUser(event?.author) &&
          !event?.invalid &&
          shouldNotify(
            event?.payload,
            me.id,
            eventGuild,
            eventGuild
              ? (preferences().guildNotifications?.[eventGuild.id] ??
                  preferences().notificationMode)
              : "all",
          );
        const away =
          m.room !== roomId || document.hidden || !document.hasFocus();
        if (notify && away && state.me.profile?.status !== "dnd") {
          sound("message");
          if (
            "Notification" in window &&
            preferences().desktopNotifications &&
            Notification.permission === "granted"
          ) {
            const notification = new Notification("Oisiicord", {
              body: "新しいメッセージ",
              icon: "/app-icon",
              tag: "oisiicord-" + m.room,
            });
            notification.onclick = () => {
              window.focus();
              guard(() => selectRoom(m.room));
              notification.close();
            };
          }
        }
        if (
          m.room !== roomId &&
          event?.payload?.type === "message" &&
          event.author !== me.id &&
          !blockedUser(event.author)
        ) {
          unread.add(m.room);
          renderNav();
        }
      }
      if (m.type === "typing" && m.room === roomId && !blockedUser(m.user)) {
        typingUsers.set(m.user, Date.now());
        renderTyping();
      }
      if (m.type === "voice-peers" && m.room === activeVoice)
        for (const id of [...new Set(m.users)])
          if (id !== me.id) await createPeer(id, true);
      if (m.type === "signal") await handleSignal(m);
      if (m.type === "voice-left") {
        if (state)
          state.voice = (state.voice ?? []).filter(
            (v) => !(v.room === m.room && v.user === m.user),
          );
        if (m.room === activeVoice && m.user !== me.id) {
          if (!blockedUser(m.user)) sound("peerLeave");
          removePeer(m.user);
        }
        renderNav();
      }
      if (m.type === "error") toast(m.message);
    });
}
function renderTyping() {
  const now = Date.now();
  for (const [id, t] of typingUsers)
    if (now - t > 4500 || blockedUser(id)) typingUsers.delete(id);
  $("#typing").textContent =
    [...typingUsers.keys()]
      .map((id) => users.get(id)?.display ?? "ユーザー")
      .join("、") + (typingUsers.size ? " が入力中…" : "");
}
setInterval(renderTyping, 1500);
async function sendSignal(payload) {
  if (ws?.readyState !== 1 || !activeVoice) throw Error("音声接続が切断された");
  const room =
    state.dms.find((r) => r.id === activeVoice) ??
    state.guilds.flatMap((g) => g.channels).find((r) => r.id === activeVoice);
  const g = state.guilds.find((g) => g.id === room.guild);
  const envelope = await C.seal(
    { type: "signal", ...payload },
    {
      room: room.id,
      author: me.id,
      recipients: recipients(room),
      identity: me,
      version: g?.version ?? 0,
    },
  );
  ws.send(JSON.stringify({ type: "signal", room: room.id, envelope }));
}
async function joinVoice(id) {
  if (sending) throw Error("送信が完了してから通話を開始して");
  if (state.unavailableDMs?.includes(id))
    throw Error("このDMでは通話できません");
  if (activeVoice === id) {
    await selectRoom(id);
    return;
  }
  if (ws?.readyState !== 1) throw Error("接続完了後に通話して");
  await leaveVoice();
  const p = preferences();
  const source = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: p.inputDevice ? { exact: p.inputDevice } : undefined,
      echoCancellation: p.echoCancellation,
      noiseSuppression: p.noiseSuppression,
      autoGainControl: p.autoGainControl,
    },
    video: false,
  });
  voiceAudio = new AudioContext();
  voiceInput = source;
  voiceGain = voiceAudio.createGain();
  voiceGain.gain.value = p.inputVolume / 100;
  voiceSource = voiceAudio.createMediaStreamSource(source);
  voiceSource.connect(voiceGain);
  const destination = voiceAudio.createMediaStreamDestination();
  voiceGain.connect(destination);
  localStream = destination.stream;
  await voiceAudio.resume();
  localStream
    .getAudioTracks()
    .forEach((t) => (t.enabled = !p.muted && !p.deafened));
  activeVoice = id;
  await selectRoom(id);
  $("#voice-controls").hidden = false;
  $("#voice-status").textContent = "通話接続済み";
  $("#voice-channel-name").textContent = currentRoom()?.name ?? "通話";
  sound("join");
  $("#call-stage").hidden = false;
  addTile(me.id, localStream, true);
  syncVoiceControls();
  ws.send(JSON.stringify({ type: "join-voice", room: id }));
  renderNav();
}
function addTile(id, stream, local = false) {
  let tile = document.getElementById("call-" + id);
  if (!tile) {
    tile = node(
      "div",
      { class: "call-tile", id: "call-" + id },
      node("div", { class: "call-avatar" }, avatar(users.get(id))),
      node("video", { autoplay: true, playsinline: true }),
      node("span", {}, users.get(id)?.display ?? "ユーザー"),
    );
    $("#call-stage").append(tile);
  }
  monitorVoice(id, stream, tile);
  const v = tile.querySelector("video");
  v.muted = local;
  if (v.srcObject !== stream) v.srcObject = stream;
  function videoState() {
    tile.classList.toggle(
      "has-video",
      stream
        .getVideoTracks()
        .some((t) => t.enabled && !t.muted && t.readyState === "live"),
    );
  }
  for (const track of stream.getVideoTracks()) {
    track.addEventListener("mute", videoState);
    track.addEventListener("unmute", videoState);
    track.addEventListener("ended", videoState);
  }
  videoState();
  if (!local) {
    v.volume = preferences().deafened ? 0 : preferences().outputVolume / 100;
    if (v.setSinkId && preferences().outputDevice)
      v.setSinkId(preferences().outputDevice).catch(() => {});
  }
  v.play().catch((error) => {
    if (
      error.name !== "NotAllowedError" ||
      local ||
      tile.querySelector(".play-audio")
    )
      return;
    const play = iconButton("volume", "音声を再生", async () => {
      await v.play();
      play.remove();
    });
    play.classList.add("play-audio");
    tile.append(play);
  });
}
async function createPeer(id, initiator = false) {
  if (blockedContact(id)) return null;
  if (peers.has(id)) return peers.get(id);
  const pc = new RTCPeerConnection({ iceServers: state.iceServers ?? [] }),
    entry = { pc, candidates: [] };
  peers.set(id, entry);
  for (const t of localStream.getAudioTracks()) pc.addTrack(t, localStream);
  const trans = pc.addTransceiver("video", { direction: "sendrecv" });
  entry.video = trans.sender;
  if (videoTrack) await trans.sender.replaceTrack(videoTrack);
  pc.onicecandidate = (e) => {
    if (e.candidate)
      guard(() => sendSignal({ to: id, candidate: e.candidate.toJSON() }));
  };
  pc.ontrack = (e) => {
    let stream = entry.stream;
    if (!stream) {
      stream = new MediaStream();
      entry.stream = stream;
    }
    if (!stream.getTracks().some((t) => t.id === e.track.id))
      stream.addTrack(e.track);
    addTile(id, stream);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed")
      toast("通話接続に失敗。NAT環境によってはTURN設定が必要");
  };
  if (initiator) {
    await pc.setLocalDescription(await pc.createOffer());
    await sendSignal({ to: id, description: pc.localDescription.toJSON() });
  }
  return entry;
}
async function handleSignal(m) {
  if (m.room !== activeVoice || blockedContact(m.envelope?.header?.author))
    return;
  const room =
      state.dms.find((r) => r.id === activeVoice) ??
      state.guilds.flatMap((g) => g.channels).find((r) => r.id === activeVoice),
    author = m.envelope.header.author;
  const signer = recipients(room).find((u) => u.id === author);
  if (!signer) throw Error("未承認の通話相手");
  await pinUser(signer);
  if (
    room.guild &&
    m.envelope.header.version !==
      state.guilds.find((g) => g.id === room.guild).version
  )
    throw Error("通話メンバー一覧が古い");
  const payload = await C.open(m.envelope, me, signer.keys, m.room);
  if (
    payload.type !== "signal" ||
    payload.to !== me.id ||
    Math.abs(Date.now() - m.envelope.header.at) > 60000
  )
    return;
  const entry = await createPeer(author);
  if (!entry) return;
  const pc = entry.pc;
  if (payload.description) {
    if (
      payload.description.type === "offer" &&
      pc.signalingState !== "stable"
    ) {
      if (me.id < author) return;
      await pc.setLocalDescription({ type: "rollback" });
    }
    await pc.setRemoteDescription(payload.description);
    for (const c of entry.candidates) await pc.addIceCandidate(c);
    entry.candidates = [];
    if (payload.description.type === "offer") {
      await pc.setLocalDescription(await pc.createAnswer());
      await sendSignal({
        to: author,
        description: pc.localDescription.toJSON(),
      });
    }
  }
  if (payload.candidate) {
    if (pc.remoteDescription) await pc.addIceCandidate(payload.candidate);
    else entry.candidates.push(payload.candidate);
  }
}
const voiceMeters = new Map();
function stopMeter(id) {
  const meter = voiceMeters.get(id);
  if (meter) {
    cancelAnimationFrame(meter.frame);
    meter.source.disconnect();
    voiceMeters.delete(id);
  }
}
function monitorVoice(id, stream, tile) {
  if (!voiceAudio || voiceMeters.get(id)?.stream === stream) return;
  stopMeter(id);
  try {
    const source = voiceAudio.createMediaStreamSource(stream),
      analyser = voiceAudio.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const meter = { source, stream, frame: 0 },
      values = new Uint8Array(256);
    voiceMeters.set(id, meter);
    function update() {
      if (!activeVoice || !tile.isConnected) {
        stopMeter(id);
        return;
      }
      analyser.getByteTimeDomainData(values);
      const level = Math.sqrt(
        values.reduce((s, v) => s + ((v - 128) / 128) ** 2, 0) / values.length,
      );
      tile.classList.toggle("speaking", level > 0.015);
      meter.frame = requestAnimationFrame(update);
    }
    meter.frame = requestAnimationFrame(update);
  } catch {}
}
function removePeer(id) {
  stopMeter(id);
  const p = peers.get(id);
  p?.pc.close();
  peers.delete(id);
  document.getElementById("call-" + id)?.remove();
}
async function leaveVoice() {
  if (activeVoice) sound("leave");
  for (const id of [...voiceMeters.keys()]) stopMeter(id);
  voiceInput?.getTracks().forEach((t) => t.stop());
  voiceInput = null;
  voiceSource = null;
  if (voiceAudio) {
    if (voiceAudio.state !== "closed") voiceAudio.close().catch(() => {});
    voiceAudio = null;
    voiceGain = null;
  }
  if (ws?.readyState === 1 && activeVoice)
    ws.send(JSON.stringify({ type: "leave-voice" }));
  for (const id of [...peers.keys()]) removePeer(id);
  localStream?.getTracks().forEach((t) => t.stop());
  videoTrack?.stop();
  videoTrack = null;
  videoMode = null;
  localStream = null;
  activeVoice = null;
  $("#voice-controls").hidden = true;
  $("#call-stage").hidden = true;
  $("#call-stage").replaceChildren();
  syncVoiceControls();
  if (state) {
    renderNav();
    renderMessages();
  }
}
async function setVideo(mode) {
  if (!activeVoice) throw Error("通話に参加して");
  if (videoTrack && videoMode === mode) {
    videoTrack.stop();
    videoTrack = null;
    videoMode = null;
    for (const p of peers.values()) await p.video.replaceTrack(null);
    addTile(me.id, localStream, true);
    syncVoiceControls();
    return;
  }
  const prefs = preferences();
  const stream =
    mode === "screen"
      ? await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: false,
        })
      : await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: prefs.cameraDevice
              ? { exact: prefs.cameraDevice }
              : undefined,
            width: {
              ideal: Number(prefs.videoResolution) === 1080 ? 1920 : 1280,
            },
            height: { ideal: Number(prefs.videoResolution) },
          },
          audio: false,
        });
  const previous = videoTrack;
  videoTrack = stream.getVideoTracks()[0];
  videoMode = mode;
  previous?.stop();
  const thisTrack = videoTrack;
  videoTrack.addEventListener("ended", () =>
    guard(async () => {
      if (videoTrack !== thisTrack) return;
      videoTrack = null;
      videoMode = null;
      for (const p of peers.values()) await p.video.replaceTrack(null);
      addTile(me.id, localStream, true);
      syncVoiceControls();
    }),
  );
  for (const p of peers.values()) await p.video.replaceTrack(videoTrack);
  addTile(
    me.id,
    new MediaStream([...localStream.getAudioTracks(), videoTrack]),
    true,
  );
  syncVoiceControls();
}

let voiceAudio = null,
  voiceSource = null,
  voiceGain = null,
  voiceInput = null;
function iconButton(name, label, fn) {
  const el = node("button", {
    type: "button",
    class: "icon-button",
    onClick: (event) => guard(() => fn(event)),
  });
  setIcon(el, name, label);
  return el;
}
function syncVoiceControls() {
  const p = preferences();
  for (const id of ["mute", "stage-mute"])
    setIcon(
      $("#" + id),
      p.muted || p.deafened ? "micOff" : "mic",
      p.muted ? "マイクのミュートを解除" : "マイクをミュート",
    );
  setIcon(
    $("#deafen"),
    p.deafened ? "headphonesOff" : "headphones",
    p.deafened ? "スピーカーのミュートを解除" : "スピーカーをミュート",
  );
  for (const id of ["camera", "stage-camera"])
    setIcon($("#" + id), "camera", videoTrack ? "映像を停止" : "カメラ");
  for (const id of ["share", "stage-share"])
    setIcon($("#" + id), "screen", "画面共有");
  $("#mute").classList.toggle("toggled", p.muted || p.deafened);
  $("#deafen").classList.toggle("toggled", p.deafened);
  for (const id of ["camera", "stage-camera", "share", "stage-share"])
    $("#" + id).classList.toggle(
      "toggled",
      !!videoTrack &&
        (id.includes("camera")
          ? videoMode === "camera"
          : videoMode === "screen"),
    );
}
function toggleMute() {
  updatePreferences({ muted: !preferences().muted });
  sound(preferences().muted ? "mute" : "unmute");
}
const settingsUI = createSettings({
  node,
  button,
  api,
  toast,
  guard,
  modal,
  prompt,
  avatar,
  uploadImage: uploadProfileImage,
  profileImage,
  selectRoom,
  memberDialog,
  backup,
  logout,
  refresh,
  renderMessages,
  updateRoster,
  inviteDialog,
  newChannel,
  editChannel: (r, onSaved) => workspaceUI.channelDialog({ room: r, onSaved }),
  approveDialog,
  leaveGuild,
  deleteAccount: deleteAccountDialog,
  setBlocked,
  getState: () => state,
  getMe: () => me,
  getGuild: currentGuild,
  getRoom: currentRoom,
  getUser: (id) => users.get(id),
});
const mediaPreview = createMediaPreview({
  node,
  button,
  download: downloadFile,
  formatSize,
});
const communityUI = createCommunityUI({
  node,
  button,
  modal,
  toast,
  guard,
  getGuild: currentGuild,
  getState: () => state,
  getMe: () => me,
  getRoom: currentRoom,
  profileImage,
  avatar,
  memberDialog,
  getUser: (id) => users.get(id),
  getMessages: () => projection().filter((m) => !blockedUser(m.author)),
  unpin: (m) => sendPayload({ type: "pin", target: m.id, on: false }),
  jumpToMessage: async (id) => {
    await loadHistory(roomId);
    const el = document.querySelector(
      '[data-message="' + CSS.escape(id) + '"]',
    );
    el?.scrollIntoView({
      behavior: preferences().reducedMotion ? "instant" : "smooth",
      block: "center",
    });
    el?.classList.add("message-jump-highlight");
    setTimeout(() => el?.classList.remove("message-jump-highlight"), 1800);
  },
  renderMessages,
  preferences,
});
const workspaceUI = createWorkspaceUI({
  node,
  button,
  api,
  modal,
  guard,
  toast,
  avatar,
  hasPermission,
  can: hasPermission,
  getState: () => state,
  getMe: () => me,
  getGuild: currentGuild,
  refresh,
  selectGuild,
  memberDialog,
  renderMessages,
  query: () => $("#search").value,
  serverSettings: () => settingsUI.server(),
  closeSettings: () => settingsUI.close(),
  invite: inviteDialog,
  leaveGuild,
  newDM,
  createGuild,
  markRead: (id) => {
    unread.delete(id);
    renderNav();
  },
  startDM: async (u) => {
    const { id } = await api("/dms", { user: u.id });
    pinDMPeers(id, [me.id, u.id]);
    guildId = null;
    await refresh();
    await selectRoom(id);
  },
});
workspaceUI.bind($(".side-header"), () =>
  currentGuild() ? workspaceUI.guildItems(currentGuild()) : [],
);
$("#channel-list").addEventListener("contextmenu", (event) => {
  if (
    event.target.closest(".channel, .category-heading") ||
    !currentGuild() ||
    !hasPermission("manageChannels")
  )
    return;
  workspaceUI.menu(event, [
    {
      label: "チャンネルを作成",
      icon: "plus",
      action: () => newChannel("text"),
    },
    {
      label: "カテゴリを作成",
      icon: "folder",
      action: () => workspaceUI.categoryDialog(currentGuild()),
    },
  ]);
});
const productivity = createProductivity({
  node,
  button,
  modal,
  guard,
  toast,
  input: $("#message-input"),
  getMe: () => me,
  getUser: () => state.me,
  getRoom: currentRoom,
  rooms: () =>
    state
      ? [
          ...state.guilds.flatMap((g) =>
            g.channels.map((r) => ({ ...r, parent: g.name })),
          ),
          ...state.dms.map((r) => ({
            ...r,
            parent: "DM",
            name:
              users.get(r.users.find((id) => id !== me.id))?.display ?? "DM",
          })),
        ]
      : [],
});
$("#personal-tools").onclick = () => guard(() => productivity.open());
for (const [id, name, label] of [
  ["add-guild", "plus", "サーバー作成・招待から参加"],
  ["side-menu", "chevron", "サーバーメニュー"],
  ["profile-settings", "settings", "ユーザー設定"],
  ["mobile-channels", "menu", "チャンネルを表示"],
  ["call", "phone", "音声通話"],
  ["pins", "pin", "ピン留め"],
  ["personal-tools", "notebook", "メモ・定型文"],
  ["toggle-members", "users", "メンバー"],
  ["attach", "plusCircle", "ファイルを添付"],
  ["emoji", "smile", "絵文字"],
  ["send", "send", "送信"],
  ["modal-close", "close", "閉じる"],
  ["hangup", "hangup", "通話から退出"],
  ["stage-hangup", "hangup", "通話から退出"],
  ["voice-indicator", "volume", "接続済み"],
])
  setIcon($("#" + id), name, label);
syncVoiceControls();
$("#deafen").onclick = () =>
  updatePreferences({ deafened: !preferences().deafened });
$("#stage-mute").onclick = toggleMute;
$("#stage-hangup").onclick = () => guard(leaveVoice);
$("#stage-camera").onclick = () => guard(() => setVideo("camera"));
$("#stage-share").onclick = () => guard(() => setVideo("screen"));
$("#my-profile").onclick = () => settingsUI.user("profile");
window.addEventListener("preferenceschange", (event) => {
  if (
    activeVoice &&
    [
      "inputDevice",
      "echoCancellation",
      "noiseSuppression",
      "autoGainControl",
    ].some((key) => key in event.detail)
  )
    guard(async () => {
      const p = preferences(),
        source = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: p.inputDevice ? { exact: p.inputDevice } : undefined,
            echoCancellation: p.echoCancellation,
            noiseSuppression: p.noiseSuppression,
            autoGainControl: p.autoGainControl,
          },
        });
      if (!voiceAudio || !activeVoice) {
        source.getTracks().forEach((t) => t.stop());
        return;
      }
      voiceSource?.disconnect();
      voiceInput?.getTracks().forEach((t) => t.stop());
      voiceInput = source;
      voiceSource = voiceAudio.createMediaStreamSource(source);
      voiceSource.connect(voiceGain);
    });
  const p = preferences();
  syncVoiceControls();
  localStream
    ?.getAudioTracks()
    .forEach((t) => (t.enabled = !p.muted && !p.deafened));
  if (voiceGain) voiceGain.gain.value = p.inputVolume / 100;
  for (const el of document.querySelectorAll(".call-tile video")) {
    if (el.muted) continue;
    el.volume = p.deafened ? 0 : p.outputVolume / 100;
    if (el.setSinkId) el.setSinkId(p.outputDevice).catch(() => {});
  }
  if (roomId) renderMessages();
});
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.shiftKey && e.code === "KeyM") {
    e.preventDefault();
    toggleMute();
  }
  if (e.ctrlKey && e.shiftKey && e.code === "KeyD") {
    e.preventDefault();
    updatePreferences({ deafened: !preferences().deafened });
  }
});
document.addEventListener("pointerdown", (e) => {
  if (!$("#guild-menu").contains(e.target) && !e.target.closest(".side-header"))
    $("#guild-menu").hidden = true;
});
$("#auth-switch").onclick = () => {
  registering = !registering;
  $("#auth-title").textContent = registering ? "アカウント作成" : "ログイン";
  $("#display-label").hidden = !registering;
  $("#display").required = registering;
  $("#auth-submit").textContent = registering ? "アカウントを作成" : "ログイン";
  $("#auth-switch").textContent = registering
    ? "ログインに戻る"
    : "アカウントを作成";
  $("#password").autocomplete = registering
    ? "new-password"
    : "current-password";
  $("#auth-error").textContent = "";
};
$("#auth-form").onsubmit = async (e) => {
  e.preventDefault();
  const submit = $("#auth-submit");
  submit.disabled = true;
  submit.textContent = "ログイン中…";
  $("#auth-error").textContent = "";
  try {
    if (!isSecureContext || !crypto.subtle)
      throw Error("HTTPS または localhost で開いて");
    const username = $("#username").value.toLowerCase(),
      password = $("#password").value;
    let result, credential, salt, privateKeys;
    if (registering) {
      salt = C.b64(C.random(32));
      credential = await C.credentials(password, salt);
      const identity = await C.identity(),
        id = crypto.randomUUID();
      privateKeys = identity.privateKeys;
      const imported = await C.importIdentity(privateKeys, identity.keys);
      result = await api("/auth/register", {
        id,
        username,
        display: $("#display").value,
        keys: identity.keys,
        salt,
        auth: credential.auth,
        vault: await C.encryptVault(privateKeys, credential.vault, username),
        proof: await C.sign({ id, username, keys: identity.keys }, imported),
      });
    } else {
      ({ salt } = await api(
        "/auth/salt?username=" + encodeURIComponent(username),
      ));
      credential = await C.credentials(password, salt);
      result = await api("/auth/login", { username, auth: credential.auth });
      privateKeys = await C.decryptVault(
        result.vault,
        credential.vault,
        username,
      );
    }
    const identity = {
      ...(await C.importIdentity(privateKeys, result.user.keys)),
      id: result.user.id,
    };
    try {
      await rememberLogin(identity, result.session);
    } catch {
      toast("このブラウザではログイン状態を保存できない");
    }
    loginChannel?.postMessage({ type: "login", session: result.session.id });
    await enterAccount(result, identity);
  } catch (error) {
    $("#auth-error").textContent = error.message;
  } finally {
    submit.disabled = false;
    submit.textContent = registering ? "アカウントを作成" : "ログイン";
  }
};
$("#home").onclick = () =>
  guard(async () => {
    if (sending) throw Error("送信が完了してからチャンネルを変更して");
    guildId = null;
    roomId = null;
    clearComposer();
    renderNav();
    renderMembers();
    renderMessages();
  });
let dmClicks = 0,
  dmLast = 0,
  dmAudio = null,
  branding = { dmSound: false };
fetch("/api/branding")
  .then((r) => r.json())
  .then((value) => (branding = value))
  .catch(() => {});
function dmSecret() {
  if (Date.now() - dmLast > 4000) dmClicks = 0;
  dmLast = Date.now();
  if (++dmClicks < 5) return;
  dmClicks = 0;
  document.body.classList.toggle("dm-rainbow");
  if (branding.dmSound) {
    dmAudio?.pause();
    dmAudio = new Audio("/settings/dm.mp3");
    dmAudio.volume = preferences().soundVolume / 100;
    dmAudio.play().catch(() => {});
  }
}
function guildChoice(label, ic, fn) {
  const el = button("", fn, "guild-choice");
  el.append(
    node("span", { class: "guild-choice-icon" }, icon(ic, 28)),
    node("strong", {}, label),
    node("span", { class: "guild-choice-arrow" }, icon("chevron", 22)),
  );
  return el;
}
$("#add-guild").onclick = () =>
  modal(
    "サーバーを追加",
    node(
      "div",
      { class: "guild-choices" },
      guildChoice("サーバーを作成", "plus", createGuild),
      guildChoice("招待リンクで参加", "link", () =>
        prompt(
          "招待リンクで参加",
          "招待リンク",
          "",
          async (value) => {
            const data = parseInvite(new URL(value));
            $("#modal").close();
            setTimeout(() => guard(() => acceptInvite(data)), 0);
          },
          "確認",
        ),
      ),
    ),
  );
$("#side-title").onclick = () => {
  if (!guildId) dmSecret();
  else guard(guildActions);
};
$("#room-name").onclick = () => {
  if (!guildId && !roomId) dmSecret();
};
$("#side-menu").onclick = () => guard(guildActions);
$("#profile-settings").onclick = () => guard(settings);
$("#security").onclick = () => guard(settings);
$("#composer").onsubmit = (e) => guard(() => sendMessage(e));
$("#attach").onclick = () => $("#file-input").click();
$("#file-input").onchange = () =>
  guard(() => {
    const files = [...$("#file-input").files];
    if (attachments.length + files.length > 5) throw Error("添付は5個まで");
    for (const f of files)
      if (f.size > 25 * 1024 * 1024) throw Error("1ファイル25 MiBまで");
    attachments.push(...files);
    $("#file-input").value = "";
    renderAttachments();
  });
const mentionInput = createMentionInput({
  input: $("#message-input"),
  getGuild: currentGuild,
  getUsers: () => {
    try {
      return recipients();
    } catch {
      return [];
    }
  },
  avatar,
});
$("#message-input").onkeydown = (e) => {
  if (productivity.keydown(e) || mentionInput.keydown(e)) return;
  if (
    e.key === "Enter" &&
    !e.shiftKey &&
    !e.isComposing &&
    (preferences().enterToSend || e.ctrlKey || e.metaKey)
  ) {
    e.preventDefault();
    $("#composer").requestSubmit();
  }
};
let lastTyping = 0;
$("#message-input").oninput = (e) => {
  const input = e.target;
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
  if (Date.now() - lastTyping > 3000 && roomId && ws?.readyState === 1) {
    lastTyping = Date.now();
    ws.send(JSON.stringify({ type: "typing", room: roomId }));
  }
};
$("#emoji").onclick = () =>
  communityUI.emojiPicker({
    anchor: $("#emoji"),
    onSelect: (emoji) => {
      const input = $("#message-input");
      input.setRangeText(
        emoji,
        input.selectionStart,
        input.selectionEnd,
        "end",
      );
      input.focus();
      input.dispatchEvent(new Event("input", { bubbles: true }));
    },
  });
$("#message-input").addEventListener("blur", () =>
  guard(() => productivity.flush()),
);
$("#search").oninput = renderMessages;
$("#pins").onclick = () => communityUI.pins({ anchor: $("#pins") });
$("#toggle-members").onclick = () => {
  const visible = getComputedStyle($("#members-panel")).display !== "none";
  $("#workspace").classList.toggle("members-hidden", visible);
  $("#workspace").classList.toggle("show-members", !visible);
  $("#toggle-members").setAttribute("aria-pressed", String(!visible));
};
$("#mobile-channels").onclick = () =>
  $("#workspace").classList.toggle("show-sidebar");
$("#modal-close").onclick = () => $("#modal").close();
$("#modal-cancel").onclick = () => $("#modal").close();
$("#call").onclick = () => guard(() => joinVoice(roomId));
$("#hangup").onclick = () => guard(leaveVoice);
$("#mute").onclick = toggleMute;
$("#camera").onclick = () => guard(() => setVideo("camera"));
$("#share").onclick = () => guard(() => setVideo("screen"));
window.addEventListener("focus", () => {
  if (me && roomId) guard(() => loadHistory(roomId));
});
window.addEventListener("beforeunload", () => {
  localStream?.getTracks().forEach((t) => t.stop());
  videoTrack?.stop();
});
function readInviteLocation() {
  pendingInvite = null;
  if (
    location.hash.startsWith("#invite=") ||
    location.hash.startsWith("#join=")
  ) {
    try {
      pendingInvite = parseInvite(new URL(location.href));
    } catch {
      toast("招待リンクの形式が不正");
    }
  }
}
readInviteLocation();
window.addEventListener("hashchange", () => {
  readInviteLocation();
  if (pendingInvite && me) guard(() => acceptInvite(pendingInvite));
});

async function resumeAccount() {
  const submit = $("#auth-submit");
  submit.disabled = true;
  $("#auth").hidden = true;
  try {
    const result = await api("/auth/session");
    const identity = await restoreLogin(result);
    if (identity) await enterAccount(result, identity);
  } catch (error) {
    if (error.status === 401) await forgetLogin().catch(() => {});
    else
      $("#auth-error").textContent =
        error.message ?? "ログイン状態を復元できない";
  } finally {
    submit.disabled = false;
    if (!state) {
      me = null;
      $("#auth").hidden = false;
    }
  }
}
resumeAccount();
