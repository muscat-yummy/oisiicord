import { messageBlocks, inlineCode } from "./developer-format.js";
import { createDeveloperUI } from "./developer-ui.js";
import { mentions } from "./mentions.js";
import { icon } from "./icons.js";

const groups = [
  [
    "faces",
    "顔・人",
    "顔 笑顔 人 face smile happy",
    "😀 😃 😄 😁 😆 😅 😂 🤣 😊 🙂 🙃 😉 😍 🥰 😘 😗 😙 😚 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🫢 🫣 🤫 🤔 🫡 🤐 🤨 😐 😑 😶 🫥 😏 😒 🙄 😬 😮‍💨 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🤧 🥵 🥶 🥴 😵 🤯 🤠 🥳 🥸 😎 🤓 🧐 😕 🫤 😟 🙁 ☹️ 😮 😯 😲 😳 🥺 🥹 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 ☠️ 💩 🤡 👹 👺 👻 👽 👾 🤖 😺 😸 😹 😻 😼 😽 🙀 😿 😾",
  ],
  [
    "hands",
    "手・体",
    "手 指 身体 hand body",
    "👋 🤚 🖐️ ✋ 🖖 🫱 🫲 🫳 🫴 🫷 🫸 👌 🤌 🤏 ✌️ 🤞 🫰 🤟 🤘 🤙 👈 👉 👆 🖕 👇 ☝️ 🫵 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 🫶 👐 🤲 🤝 🙏 💪 🦾 🦿 🦵 🦶 👂 🦻 👃 🧠 🫀 🫁 🦷 🦴 👀 👁️ 👅 👄",
  ],
  [
    "nature",
    "動物・自然",
    "動物 自然 animal nature",
    "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐻‍❄️ 🐨 🐯 🦁 🐮 🐷 🐽 🐸 🐵 🙈 🙉 🙊 🐒 🐔 🐧 🐦 🐤 🐣 🐥 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🪲 🐛 🦋 🐌 🐞 🐜 🪰 🪱 🦗 🕷️ 🦂 🐢 🐍 🦎 🐙 🦑 🦐 🦞 🦀 🐡 🐠 🐟 🐬 🐳 🐋 🦈 🦭 🐊 🐅 🐆 🦓 🦍 🦧 🦣 🐘 🦛 🦏 🐪 🐫 🦒 🦘 🦬 🐃 🐂 🐄 🐎 🐖 🐏 🐑 🦙 🐐 🦌 🐕 🐩 🦮 🐈 🪶 🐓 🦃 🦤 🦚 🦜 🦢 🦩 🕊️ 🐇 🦝 🦨 🦡 🦫 🦦 🦥 🐁 🐀 🐿️ 🦔 🌵 🎄 🌲 🌳 🌴 🪴 🌱 🌿 ☘️ 🍀 🍁 🍂 🍃 🌺 🌸 🌼 🌻 🌞 🌝 🌚 ⭐ 🌟 ✨ ⚡ ☀️ 🌤️ ⛅ ☁️ 🌧️ ⛈️ 🌨️ ❄️ ☃️ ⛄ 🔥 💧 🌊 🌈",
  ],
  [
    "food",
    "食べ物",
    "食べ物 料理 food drink",
    "🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🍆 🥑 🥦 🥬 🥒 🌶️ 🫑 🌽 🥕 🫒 🧄 🧅 🥔 🍠 🥐 🥯 🍞 🥖 🥨 🧀 🥚 🍳 🧈 🥞 🧇 🥓 🥩 🍗 🍖 🌭 🍔 🍟 🍕 🫓 🥪 🥙 🧆 🌮 🌯 🫔 🥗 🥘 🫕 🥫 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🦪 🍤 🍙 🍚 🍘 🍥 🥠 🥮 🍢 🍡 🍧 🍨 🍦 🥧 🧁 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🍩 🍪 🌰 🥜 🍯 🥛 🍼 🫖 ☕ 🍵 🧃 🥤 🧋 🧊 🥢 🍽️ 🥄",
  ],
  [
    "objects",
    "道具・遊び",
    "道具 遊び ゲーム object game",
    "⚽ 🏀 🏈 ⚾ 🥎 🎾 🏐 🏉 🥏 🎱 🪀 🏓 🏸 🏒 🏑 🥍 🏏 🪃 🥅 ⛳ 🪁 🏹 🎣 🤿 🥊 🥋 🎽 🛹 🛼 🛷 ⛸️ 🥌 🎿 ⛷️ 🏂 🪂 🏋️ 🤼 🤸 ⛹️ 🤺 🤾 🏌️ 🏇 🧘 🏄 🏊 🚣 🧗 🚵 🚴 🏆 🥇 🥈 🥉 🏅 🎖️ 🎗️ 🎫 🎟️ 🎪 🤹 🎭 🩰 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🪗 🎸 🎻 🎲 ♟️ 🎯 🎳 🎮 🎰 🧩 🚗 🚕 🚙 🚌 🚎 🏎️ 🚓 🚑 🚒 🚐 🛻 🚚 🚛 🚜 🛴 🚲 🛵 🏍️ 🛺 🚨 🚃 🚋 🚂 🚆 🚄 🚅 🚈 🚇 🚊 🚉 ✈️ 🚀 🛸 🛰️ 🛶 ⛵ 🚤 🛥️ 🛳️ ⚓ 🏠 🏡 🏘️ 🏚️ 🏗️ 🏭 🏢 🏬 🏣 🏥 🏦 🏨 🏪 🏫 ⌚ 📱 💻 ⌨️ 🖥️ 🖨️ 🖱️ 🖲️ 💽 💾 💿 📷 🎥 🔋 🔌 💡 🔦 🕯️ 🧯 🛢️ 💸 💰 💳 💎 ⚖️ 🪜 🧰 🔧 🔨 ⚒️ 🛠️ ⛏️ 🪛 🔩 ⚙️ 🧱 🧪 🧫 🧬 🔬 🔭 📚 📖 📝 ✏️ 🖊️ 🖋️ 📌 📎 🔑 🔒 📦 🎁 🎈 🎉 🎊",
  ],
  [
    "symbols",
    "記号",
    "記号 ハート 色 symbol heart",
    "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 🩷 🩵 🩶 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ☮️ ✝️ ☪️ 🕉️ ☸️ ✡️ 🔯 🕎 ☯️ ☦️ 🛐 ⛎ ♈ ♉ ♊ ♋ ♌ ♍ ♎ ♏ ♐ ♑ ♒ ♓ 🆔 ⚛️ 🈳 🈹 🈺 🈯 🈷️ ✴️ 🆚 💮 🉐 ㊙️ ㊗️ 🈴 🈵 🈲 🅰️ 🅱️ 🆎 🆑 🅾️ 🆘 ❌ ⭕ 🛑 ⛔ 📛 🚫 💯 💢 ♨️ 🚷 🚯 🚳 🚱 🔞 📵 🚭 ❗ ❕ ❓ ❔ ‼️ ⁉️ 🔅 🔆 〽️ ⚠️ 🚸 🔱 ⚜️ 🔰 ♻️ ✅ 🈶 🈚 🈸 🈺 🈁 🔠 🔡 🔢 🔣 🔤 🆙 🆗 🆕 🆒 🆓 🆖 🟢 🔵 🟣 ⚫ ⚪ 🟤 🔴 🟠 🟡 🟥 🟧 🟨 🟩 🟦 🟪 ⬛ ⬜ 🔈 🔉 🔊 🔇 🔔 🔕 🔍 🔎",
  ],
];
const keywords = {
  "🐼": "パンダ panda",
  "👍": "いいね 親指 thumbsup like",
  "👎": "よくない thumbsdown dislike",
  "😂": "爆笑 うれし泣き laugh joy",
  "🤣": "爆笑 rofl laugh",
  "👀": "目 eyes",
  "🎉": "お祝い party tada",
  "🤔": "考える think",
  "❤️": "ハート love heart",
  "🔥": "火 fire hot",
  "🍣": "寿司 sushi",
  "🍜": "ラーメン ramen",
  "🍛": "カレー curry",
  "🎮": "ゲーム game controller",
  "💻": "パソコン laptop computer",
  "✅": "チェック check",
  "❌": "バツ cross",
  "😀": "笑顔 smile happy",
  "😢": "涙 cry",
  "😭": "号泣 sob cry",
  "😎": "サングラス cool",
  "☕": "コーヒー coffee",
  "🐱": "猫 cat",
  "🐶": "犬 dog",
  "🌈": "虹 rainbow",
  "🚀": "ロケット rocket",
  "🤖": "ロボット robot",
  "💩": "うんち poop",
  "💀": "どくろ skull",
  "👻": "おばけ ghost",
  "🎂": "誕生日 ケーキ birthday cake",
};
const unicode = groups.flatMap(([group, label, search, values]) =>
  values.split(" ").map((token) => ({
    token,
    group,
    label,
    search: search + " " + (keywords[token] ?? "") + " " + token,
  })),
);

export function createCommunityUI(ctx) {
  const { node: n, button: b } = ctx;
  let picker = null,
    pinsDialog = null,
    pinsRoom = null,
    lastFocus = null;
  const recentKey = () => "oisiicord-emoji-recent-" + ctx.getMe()?.id;
  function recent() {
    try {
      const values = JSON.parse(localStorage.getItem(recentKey()) ?? "[]");
      return Array.isArray(values)
        ? values.filter((v) => typeof v === "string").slice(0, 30)
        : [];
    } catch {
      return [];
    }
  }
  function remember(token) {
    try {
      localStorage.setItem(
        recentKey(),
        JSON.stringify(
          [token, ...recent().filter((value) => value !== token)].slice(0, 30),
        ),
      );
    } catch {}
  }
  function closePicker() {
    picker?.close();
    picker?.remove();
    picker = null;
    lastFocus?.focus();
  }
  function closePins() {
    pinsDialog?.close();
    pinsDialog?.remove();
    pinsDialog = null;
    pinsRoom = null;
  }
  function closePanels() {
    closePicker();
    closePins();
  }
  function customEmojis() {
    return ctx.getGuild()?.emojis ?? [];
  }
  function emojiNode(token, size = 22) {
    const match = String(token).match(/^<:([a-zA-Z0-9_-]{1,100}):>$/);
    if (!match && !/^:[A-Za-z0-9_]{2,32}:$/.test(String(token)))
      return n("span", { class: "unicode-emoji" }, String(token));
    const named = String(token).match(/^:([A-Za-z0-9_]{2,32}):$/);
    const emoji = customEmojis().find((value) =>
      match
        ? value.id === match[1]
        : value.name.toLowerCase() === named?.[1].toLowerCase(),
    );
    if (!match && !emoji) return n("span", {}, String(token));
    const span = n("span", {
      class: "custom-emoji",
      role: "img",
      "aria-label": emoji ? ":" + emoji.name + ":" : "削除された絵文字",
    });
    span.style.setProperty("--emoji-size", size + "px");
    span.textContent = emoji ? ":" + emoji.name + ":" : ":emoji:";
    if (emoji)
      ctx
        .profileImage(emoji.image)
        .then((url) => {
          if (span.isConnected || span.parentNode)
            span.replaceChildren(
              n("img", {
                src: url,
                alt: ":" + emoji.name + ":",
                loading: "lazy",
              }),
            );
        })
        .catch(() => {});
    return span;
  }
  function safeURL(raw) {
    if (/\s|[\x00-\x1f\x7f]/u.test(raw)) return null;
    try {
      const url = new URL(raw);
      return ["https:", "http:"].includes(url.protocol) &&
        !url.username &&
        !url.password
        ? url
        : null;
    } catch {
      return null;
    }
  }
  function confirmLink(raw) {
    const url = safeURL(raw);
    if (!url) return;
    ctx.modal(
      "リンクを開く",
      n(
        "div",
        { class: "link-confirmation" },
        n("strong", {}, url.hostname),
        n("p", { class: "link-confirmation-url" }, url.href),
      ),
      () => {
        window.open(url.href, "_blank", "noopener,noreferrer");
      },
      "開く",
    );
  }
  function appendMentions(el, text) {
    let start = 0;
    for (const m of mentions(text)) {
      el.append(document.createTextNode(text.slice(start, m.index)));
      const guild = ctx.getGuild();
      const user = m.kind === "user" ? ctx.getUser(m.id) : null;
      const role =
        m.kind === "role" ? guild?.roles?.find((r) => r.id === m.id) : null;
      if ((m.kind === "everyone" && guild) || user || role) {
        const label =
          "@" + (user?.display ?? user?.username ?? role?.name ?? "everyone");
        const chip = user
          ? b(label, () => ctx.memberDialog(user), "mention")
          : n("span", { class: "mention" }, label);
        if (role?.color) chip.style.color = role.color;
        el.append(chip);
      } else el.append(document.createTextNode(m.raw));
      start = m.index + m.raw.length;
    }
    el.append(document.createTextNode(text.slice(start)));
  }
  function plainRichText(text) {
    const el = n("div", { class: "message-text" });
    const pattern =
      /<button:([^<>]+)>|<:([a-zA-Z0-9_-]{1,100}):>|(:[A-Za-z0-9_]{2,32}:)|https?:\/\/[^\s<>]+/g;
    const source = String(text);
    let start = 0;
    for (const match of source.matchAll(pattern)) {
      appendMentions(el, source.slice(start, match.index));
      if (match[1] !== undefined) {
        const delimiter = match[1].indexOf("|"),
          raw = delimiter < 0 ? match[1] : match[1].slice(0, delimiter),
          label = delimiter < 0 ? null : match[1].slice(delimiter + 1);
        const url = safeURL(raw);
        if (!url) el.append(document.createTextNode(match[0]));
        else {
          const link = b("", () => confirmLink(url.href), "chat-link-button");
          link.append(
            n("span", {}, label?.trim() || url.hostname),
            icon("link", 16),
          );
          link.title = url.href;
          el.append(link);
        }
      } else if (match[2] || match[3]) el.append(emojiNode(match[0]));
      else {
        const url = safeURL(match[0]);
        if (!url) el.append(document.createTextNode(match[0]));
        else {
          const link = b(
            match[0],
            () => confirmLink(url.href),
            "chat-external-link",
          );
          link.title = url.href;
          el.append(link);
        }
      }
      start = match.index + match[0].length;
    }
    appendMentions(el, source.slice(start));
    return el;
  }
  const developer = createDeveloperUI(ctx);
  function richText(text) {
    const root = n("div", { class: "message-text" });
    for (const block of messageBlocks(text)) {
      if (block.type === "code") {
        root.append(developer.codeBlock(block.text, block.language));
        continue;
      }
      const prose = n("div", { class: "rich-prose" });
      for (const part of inlineCode(block.text)) {
        if (part.type === "code")
          prose.append(n("code", { class: "inline-code" }, part.text));
        else {
          const fragment = plainRichText(part.text);
          prose.append(...fragment.childNodes);
        }
      }
      root.append(prose);
    }
    return root;
  }
  function emojiPicker({ anchor, onSelect, mode = "insert" } = {}) {
    closePicker();
    lastFocus = anchor ?? document.activeElement;
    const title = mode === "reaction" ? "リアクションを選ぶ" : "絵文字を選ぶ";
    picker = n("dialog", { class: "emoji-picker-dialog", "aria-label": title });
    const close = b("", closePicker, "emoji-picker-close");
    close.append(icon("close", 20));
    close.setAttribute("aria-label", "閉じる");
    const search = n("input", {
      type: "search",
      placeholder: "絵文字を検索",
      "aria-label": "絵文字を検索",
    });
    const tabs = n("div", {
      class: "emoji-category-tabs",
      role: "tablist",
      "aria-label": "絵文字カテゴリ",
    });
    const list = n("div", { class: "emoji-picker-list" });
    let selected = "all";
    const items = () => [
      ...customEmojis().map((emoji) => ({
        token: "<:" + emoji.id + ":>",
        group: "server",
        label: ctx.getGuild()?.name ?? "サーバー",
        search: emoji.name + " :" + emoji.name + ":",
        name: ":" + emoji.name + ":",
      })),
      ...unicode,
    ];
    function render() {
      list.replaceChildren();
      const query = search.value.toLowerCase().trim(),
        all = items(),
        recents = recent();
      const visible =
        selected === "recent"
          ? recents
              .map((token) => all.find((item) => item.token === token))
              .filter(Boolean)
          : all.filter((item) => selected === "all" || item.group === selected);
      const filtered = visible.filter(
        (item) => !query || item.search.toLowerCase().includes(query),
      );
      if (!filtered.length) {
        list.append(n("p", { class: "emoji-empty" }, "一致する絵文字はない"));
        return;
      }
      let current;
      for (const item of filtered) {
        if (selected !== "recent" && current !== item.group) {
          current = item.group;
          list.append(n("h3", {}, item.label));
        }
        const choice = b(
          "",
          async () => {
            remember(item.token);
            closePicker();
            await onSelect?.(item.token);
          },
          "emoji-choice",
        );
        choice.dataset.token = item.token;
        choice.title = item.name ?? keywords[item.token] ?? item.token;
        choice.setAttribute("aria-label", choice.title);
        choice.append(emojiNode(item.token, 28));
        list.append(choice);
      }
    }
    for (const [key, label] of [
      ["all", "すべて"],
      ["recent", "最近使った"],
      ["server", "サーバー"],
      ...groups.map(([key, label]) => [key, label]),
    ]) {
      if (key === "server" && !ctx.getGuild()) continue;
      const tab = b(
        label,
        () => {
          selected = key;
          for (const el of tabs.children)
            el.setAttribute("aria-selected", String(el === tab));
          render();
        },
        "emoji-category-tab",
      );
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(key === selected));
      tabs.append(tab);
    }
    search.oninput = render;
    picker.append(
      n("header", {}, n("h2", {}, title), close),
      search,
      tabs,
      list,
    );
    picker.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closePicker();
      }
    });
    picker.addEventListener("cancel", (event) => {
      event.preventDefault();
      closePicker();
    });
    picker.addEventListener("click", (event) => {
      if (event.target === picker) {
        const box = picker.getBoundingClientRect();
        if (
          event.clientX < box.left ||
          event.clientX > box.right ||
          event.clientY < box.top ||
          event.clientY > box.bottom
        )
          closePicker();
      }
    });
    document.body.append(picker);
    picker.showModal();
    render();
    search.focus();
  }
  function refreshPins() {
    if (!pinsDialog) return;
    if (ctx.getRoom()?.id !== pinsRoom) {
      closePins();
      return;
    }
    const list = pinsDialog.querySelector(".pins-list");
    list.replaceChildren();
    const messages = (ctx.getMessages() ?? [])
      .filter(
        (message) => message.pinned && !message.deleted && !message.invalid,
      )
      .reverse();
    const count = pinsDialog.querySelector(".pins-count");
    count.textContent = messages.length + "件";
    if (!messages.length) {
      list.append(
        n(
          "div",
          { class: "pins-empty" },
          icon("pin", 34),
          n("p", {}, "ピン留めはない"),
        ),
      );
      return;
    }
    for (const message of messages) {
      const user = ctx.getUser(message.author) ?? message.authorUser,
        time = new Date(message.envelope.header.at);
      const card = n("article", { class: "pin-card", "data-pin": message.id });
      card.append(
        n(
          "header",
          {},
          ctx.avatar(user),
          n("strong", {}, user?.display ?? "ユーザー"),
          n(
            "time",
            { dateTime: time.toISOString() },
            time.toLocaleString("ja-JP", {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            }),
          ),
        ),
      );
      card.append(richText(message.text));
      if (message.files?.length)
        card.append(n("small", {}, "添付 " + message.files.length + "件"));
      const actions = n(
        "div",
        { class: "pin-card-actions" },
        b(
          "メッセージへ移動",
          async () => {
            closePins();
            await ctx.jumpToMessage(message.id);
          },
          "primary",
        ),
      );
      const guild = ctx.getGuild();
      if (
        !guild ||
        guild.owner === ctx.getMe()?.id ||
        guild.myPermissions?.manageMessages
      )
        actions.append(b("解除", () => ctx.unpin(message)));
      card.append(actions);
      list.append(card);
    }
  }
  function pins({ anchor } = {}) {
    if (pinsDialog) {
      closePins();
      return;
    }
    if (!ctx.getRoom()) return;
    pinsRoom = ctx.getRoom().id;
    pinsDialog = n("dialog", {
      class: "pins-dialog",
      "aria-label": "ピン留め",
    });
    const close = b("", closePins, "pins-close");
    close.append(icon("close", 21));
    close.setAttribute("aria-label", "閉じる");
    pinsDialog.append(
      n(
        "header",
        {},
        icon("pin", 22),
        n("h2", {}, "ピン留め"),
        n("span", { class: "pins-count" }),
        close,
      ),
      n("div", { class: "pins-list" }),
    );
    pinsDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closePins();
    });
    document.body.append(pinsDialog);
    pinsDialog.showModal();
    refreshPins();
  }
  return {
    richText,
    emojiNode,
    emojiPicker,
    pins,
    refreshPins,
    confirmLink,
    closePanels,
  };
}
