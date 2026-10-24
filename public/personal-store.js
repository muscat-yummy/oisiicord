import * as C from "./crypto.js";
export const emptyPersonalData = () => ({
  notes: {},
  templates: [],
  drafts: {},
});
export function expandTemplate(text, context, now = new Date()) {
  const values = {
    date:
      now.getFullYear() +
      "-" +
      String(now.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(now.getDate()).padStart(2, "0"),
    time:
      String(now.getHours()).padStart(2, "0") +
      ":" +
      String(now.getMinutes()).padStart(2, "0"),
    channel: context.channel ?? "",
    me: context.me ?? "",
  };
  return String(text).replace(
    /\{(date|time|channel|me)\}/g,
    (_, key) => values[key],
  );
}
export function buttonMarkup(raw, label = "") {
  if (/\s|[\x00-\x1f\x7f]/u.test(raw)) throw Error("HTTP/HTTPSのURLを入力して");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw Error("HTTP/HTTPSのURLを入力して");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw Error("HTTP/HTTPSのURLを入力して");
  if (/[<>|\r\n]/u.test(label) || label.length > 80)
    throw Error("ボタン名は80文字以内で、< > | は使えない");
  return (
    "<button:" +
    url.href.replaceAll("|", "%7C") +
    (label.trim() ? "|" + label.trim() : "") +
    ">"
  );
}
/**
 * @param {any} identity
 * @param {{getItem:(key:string)=>string|null,setItem:(key:string,value:string)=>void}} storage
 */
export function createPersonalStore(
  identity,
  storage = globalThis.localStorage,
) {
  const key = "oisiicord-personal-" + identity.id,
    room = "oisiicord/local-tools/" + identity.id;
  let queue = Promise.resolve();
  async function read() {
    const raw = storage.getItem(key);
    if (!raw) return emptyPersonalData();
    const payload = await C.open(
      JSON.parse(raw),
      identity,
      identity.keys,
      room,
    );
    if (
      payload.type !== "personal-tools" ||
      !payload.data ||
      !Array.isArray(payload.data.templates) ||
      !payload.data.notes ||
      !payload.data.drafts ||
      typeof payload.data.notes !== "object" ||
      typeof payload.data.drafts !== "object"
    )
      throw Error("自分用データを開けない");
    return payload.data;
  }
  return {
    key,
    load: () => queue.then(read),
    edit(change) {
      const apply = async () => {
        const data = await read();
        change(data);
        const envelope = await C.seal(
          { type: "personal-tools", data },
          { room, author: identity.id, identity, recipients: [identity] },
        );
        storage.setItem(key, JSON.stringify(envelope));
        return data;
      };
      const run = () =>
        globalThis.navigator?.locks
          ? globalThis.navigator.locks.request(key, apply)
          : apply();
      const task = queue.then(run);
      queue = task.catch(() => {});
      return task;
    },
    flush: () => queue,
  };
}
