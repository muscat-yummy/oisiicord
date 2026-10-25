import { codeRanges } from "./developer-format.js";
// Mentions remain in the signed, encrypted message text.
const tokenPattern = /<@(&?)([\w-]{1,100})>|(?<![\w@])@everyone\b/g;
export function mentions(text) {
  const source = String(text);
  const links = [
    ...source.matchAll(/<button:[^<>]+>|https?:\/\/[^\s<>]+/g),
  ].map((m) => [m.index, m.index + m[0].length]);
  links.push(...codeRanges(source));
  return [...source.matchAll(tokenPattern)]
    .filter(
      (m) => !links.some(([start, end]) => m.index >= start && m.index < end),
    )
    .map((m) => ({
      raw: m[0],
      index: m.index,
      kind: m[0] === "@everyone" ? "everyone" : m[1] ? "role" : "user",
      id: m[2] ?? null,
    }));
}
export function isMentioned(text, user, guild) {
  return mentions(text).some((m) =>
    m.kind === "user"
      ? m.id === user
      : !guild
        ? false
        : m.kind === "everyone" ||
          (guild.roles?.some((r) => r.id === m.id) &&
            (guild.roleAssignments?.[user] ?? []).includes(m.id)),
  );
}
export function shouldNotify(payload, user, guild, mode = "mentions") {
  return (
    payload?.type === "message" &&
    mode !== "silent" &&
    (mode === "all" || !guild || isMentioned(payload.text, user, guild))
  );
}
export function createMentionInput({ input, getUsers, getGuild, avatar }) {
  const list = document.createElement("div");
  list.id = "mention-candidates";
  list.className = "mention-candidates";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "メンション候補");
  list.hidden = true;
  input.closest(".composer-area").append(list);
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", list.id);
  let options = [],
    selected = 0,
    range = null;
  function close() {
    if (list.hidden) {
      range = null;
      return;
    }
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    range = null;
  }
  function choose(index) {
    if (!range || !options[index]) return;
    input.setRangeText(
      options[index].token + " ",
      range.start,
      range.end,
      "end",
    );
    close();
    input.focus();
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function highlight() {
    input.setAttribute("aria-controls", list.id);
    [...list.children].forEach((el, i) =>
      el.setAttribute("aria-selected", String(i === selected)),
    );
    input.setAttribute("aria-activedescendant", "mention-option-" + selected);
    list.children[selected]?.scrollIntoView({ block: "nearest" });
  }
  function update() {
    if (input.disabled || input.selectionStart !== input.selectionEnd)
      return close();
    const before = input.value.slice(0, input.selectionStart),
      match = /(?:^|\s)@([^\s@<>]{0,60})$/u.exec(before);
    if (!match) return close();
    const query = match[1].toLocaleLowerCase(),
      guild = getGuild();
    const items = [
      ...(guild
        ? [{ label: "everyone", detail: "全員", token: "@everyone" }]
        : []),
      ...(guild?.roles ?? [])
        .filter((r) => !r.isDefault)
        .map((r) => ({
          label: r.name,
          detail: "ロール",
          token: "<@&" + r.id + ">",
          color: r.color,
        })),
      ...getUsers().map((u) => ({
        label: u.display ?? u.username,
        detail: "@" + u.username,
        token: "<@" + u.id + ">",
        user: u,
      })),
    ];
    options = items
      .filter((o) =>
        (o.label + " " + o.detail).toLocaleLowerCase().includes(query),
      )
      .slice(0, 30);
    if (!options.length) return close();
    range = {
      start: before.length - match[1].length - 1,
      end: input.selectionStart,
    };
    selected = 0;
    list.replaceChildren(
      ...options.map((o, i) => {
        const row = document.createElement("button");
        row.type = "button";
        row.id = "mention-option-" + i;
        row.setAttribute("role", "option");
        row.tabIndex = -1;
        if (o.user) row.append(avatar(o.user));
        else {
          const mark = document.createElement("span");
          mark.className = "mention-candidate-mark";
          mark.textContent = "@";
          if (o.color) mark.style.color = o.color;
          row.append(mark);
        }
        const name = document.createElement("strong");
        name.textContent = o.label;
        const detail = document.createElement("small");
        detail.textContent = o.detail;
        row.append(name, detail);
        row.onpointerdown = (e) => e.preventDefault();
        row.onclick = () => choose(i);
        return row;
      }),
    );
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    highlight();
  }
  input.addEventListener("input", (e) => {
    if (!e.isComposing) update();
  });
  input.addEventListener("compositionend", update);
  input.addEventListener("click", update);
  input.addEventListener("blur", close);
  document.addEventListener("pointerdown", (e) => {
    if (e.target !== input && !list.contains(e.target)) close();
  });
  return {
    close,
    keydown(e) {
      if (list.hidden || e.isComposing || e.keyCode === 229) return false;
      if (["ArrowDown", "ArrowUp"].includes(e.key)) {
        e.preventDefault();
        selected =
          (selected + (e.key === "ArrowDown" ? 1 : -1) + options.length) %
          options.length;
        highlight();
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return true;
      }
      if (
        e.key === "Tab" ||
        (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey)
      ) {
        e.preventDefault();
        choose(selected);
        return true;
      }
      return false;
    },
  };
}
