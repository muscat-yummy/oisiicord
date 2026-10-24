import { icon } from "./icons.js";
export function createWorkspaceUI(ctx) {
  const { node: n, button: b, api, modal } = ctx;
  let activeMenu = null,
    returnFocus = null,
    homeTab = "online";
  function closeMenu(restore = false) {
    activeMenu?.remove();
    activeMenu = null;
    if (restore) returnFocus?.focus();
  }
  function menu(event, items) {
    event.preventDefault?.();
    event.stopPropagation?.();
    closeMenu();
    returnFocus = document.activeElement;
    const box = n("div", {
      class: "workspace-context-menu",
      role: "menu",
      "aria-label": "操作メニュー",
    });
    for (const item of items.filter(Boolean)) {
      if (item.separator) {
        box.append(n("div", { class: "context-divider", role: "separator" }));
        continue;
      }
      const el = b(
        "",
        async () => {
          const x = box.getBoundingClientRect().left,
            y = box.getBoundingClientRect().top;
          closeMenu();
          if (item.children) menu({ clientX: x, clientY: y }, item.children);
          else await item.action();
        },
        "context-item" + (item.danger ? " danger" : ""),
      );
      el.setAttribute("role", "menuitem");
      el.append(icon(item.icon ?? "settings", 18), n("span", {}, item.label));
      if (item.children) el.append(icon("chevron", 14));
      box.append(el);
    }
    document.body.append(box);
    activeMenu = box;
    const rect = box.getBoundingClientRect(),
      anchor = event.currentTarget?.getBoundingClientRect();
    const x = event.clientX ?? anchor?.left ?? 16,
      y = event.clientY ?? anchor?.bottom ?? 16;
    box.style.left =
      Math.max(8, Math.min(x, innerWidth - rect.width - 8)) + "px";
    box.style.top =
      Math.max(8, Math.min(y, innerHeight - rect.height - 8)) + "px";
    box.querySelector("button")?.focus();
    box.onkeydown = (e) => {
      const options = [...box.querySelectorAll("button")],
        i = options.indexOf(document.activeElement);
      if (e.key === "Escape") {
        e.preventDefault();
        closeMenu(true);
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        options[
          e.key === "Home"
            ? 0
            : e.key === "End"
              ? options.length - 1
              : (i + (e.key === "ArrowDown" ? 1 : -1) + options.length) %
                options.length
        ]?.focus();
      }
    };
  }
  document.addEventListener("pointerdown", (e) => {
    if (activeMenu && !activeMenu.contains(e.target)) closeMenu();
  });
  window.addEventListener("resize", () => closeMenu());
  document.addEventListener(
    "scroll",
    (e) => {
      if (activeMenu && !activeMenu.contains(e.target)) closeMenu();
    },
    true,
  );
  function bind(el, items) {
    el.addEventListener("contextmenu", (e) => menu(e, items()));
    el.addEventListener("keydown", (e) => {
      if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))
        menu(e, items());
    });
  }
  const copy = async (value) => {
    await navigator.clipboard.writeText(value);
    ctx.toast("コピーした");
  };
  async function moveChannel(g, r, delta) {
    const ids = g.channels.map((c) => c.id),
      i = ids.indexOf(r.id),
      to = i + delta;
    if (to < 0 || to >= ids.length) return;
    [ids[i], ids[to]] = [ids[to], ids[i]];
    await api("/guilds/" + g.id + "/channelorder", { ids });
    await ctx.refresh();
  }
  function deleteChannel(g, r) {
    modal(
      "チャンネルを削除",
      n(
        "div",
        { class: "delete-confirm" },
        n("strong", {}, "# " + r.name),
        n("p", {}, "メッセージも削除される。この操作は元に戻せない。"),
      ),
      async () => {
        await api("/rooms/" + r.id, {}, "DELETE");
        await ctx.refresh();
      },
      "削除",
    );
  }
  function channelItems(g, r) {
    const can = ctx.can("manageChannels", g);
    return [
      {
        label: "未読をクリア",
        icon: "check",
        action: () => ctx.markRead(r.id),
      },
      can && {
        label: "チャンネルを編集",
        icon: "edit",
        action: () => channelDialog({ guild: g, room: r }),
      },
      can && {
        label: "カテゴリへ移動",
        icon: "folder",
        children: [
          {
            label: "カテゴリなし",
            icon: "hash",
            action: () => moveCategory(g, r, null),
          },
          ...(g.categories ?? []).map((c) => ({
            label: c.name,
            icon: "folder",
            action: () => moveCategory(g, r, c.id),
          })),
        ],
      },
      can &&
        g.channels[0]?.id !== r.id && {
          label: "上へ移動",
          icon: "up",
          action: () => moveChannel(g, r, -1),
        },
      can &&
        g.channels.at(-1)?.id !== r.id && {
          label: "下へ移動",
          icon: "down",
          action: () => moveChannel(g, r, 1),
        },
      can && {
        label: "チャンネルを複製",
        icon: "copy",
        action: async () => {
          const created = await api("/guilds/" + g.id + "/channels", {
            name: r.name + "-コピー",
            kind: r.kind,
            topic: r.topic ?? "",
          });
          await api(
            "/guilds/" + g.id + "/channelmeta/" + created.id,
            { category: r.category ?? null, slowmode: r.slowmode ?? 0 },
            "PATCH",
          );
          await ctx.refresh();
        },
      },
      { separator: true },
      { label: "チャンネルIDをコピー", icon: "copy", action: () => copy(r.id) },
      can && {
        label: "チャンネルを削除",
        icon: "trash",
        danger: true,
        action: () => deleteChannel(g, r),
      },
    ];
  }
  async function moveCategory(g, r, id) {
    await api(
      "/guilds/" + g.id + "/channelmeta/" + r.id,
      { category: id },
      "PATCH",
    );
    await ctx.refresh();
  }
  function categoryDialog(g, category) {
    const name = n("input", {
      value: category?.name ?? "",
      maxlength: 60,
      required: true,
      "aria-label": "カテゴリ名",
    });
    modal(
      category ? "カテゴリを編集" : "カテゴリを作成",
      n(
        "div",
        { class: "workspace-editor" },
        n("label", {}, "カテゴリ名", name),
      ),
      async () => {
        await api(
          "/guilds/" +
            g.id +
            "/categories" +
            (category ? "/" + category.id : ""),
          { name: name.value },
          category ? "PATCH" : "POST",
        );
        await ctx.refresh();
      },
      category ? "保存" : "作成",
    );
  }
  function categoryItems(g, c) {
    const can = ctx.can("manageChannels", g);
    return [
      can && {
        label: "チャンネルを作成",
        icon: "plus",
        action: () => channelDialog({ guild: g, category: c.id }),
      },
      can && {
        label: "カテゴリを編集",
        icon: "edit",
        action: () => categoryDialog(g, c),
      },
      can &&
        g.categories[0]?.id !== c.id && {
          label: "上へ移動",
          icon: "up",
          action: () => moveCategoryOrder(g, c, -1),
        },
      can &&
        g.categories.at(-1)?.id !== c.id && {
          label: "下へ移動",
          icon: "down",
          action: () => moveCategoryOrder(g, c, 1),
        },
      { label: "カテゴリIDをコピー", icon: "copy", action: () => copy(c.id) },
      can && { separator: true },
      can && {
        label: "カテゴリを削除",
        icon: "trash",
        danger: true,
        action: () =>
          modal(
            "カテゴリを削除",
            n(
              "div",
              { class: "delete-confirm" },
              n("strong", {}, c.name),
              n("p", {}, "カテゴリ内のチャンネルは残る。"),
            ),
            async () => {
              await api(
                "/guilds/" + g.id + "/categories/" + c.id,
                {},
                "DELETE",
              );
              await ctx.refresh();
            },
            "削除",
          ),
      },
    ];
  }
  async function moveCategoryOrder(g, c, delta) {
    const ids = g.categories.map((x) => x.id),
      i = ids.indexOf(c.id),
      to = i + delta;
    if (to < 0 || to >= ids.length) return;
    [ids[i], ids[to]] = [ids[to], ids[i]];
    await api("/guilds/" + g.id + "/categories/order", { ids }, "PATCH");
    await ctx.refresh();
  }
  function deleteGuild(g) {
    const confirm = n("input", {
      placeholder: g.name,
      "aria-label": "削除するサーバー名",
      required: true,
    });
    modal(
      "サーバーを削除",
      n(
        "div",
        { class: "workspace-editor delete-confirm" },
        n("p", {}, "チャンネルとメッセージがすべて削除される。元に戻せない。"),
        n("label", {}, "確認のためサーバー名を入力", confirm),
      ),
      async () => {
        if (confirm.value !== g.name) throw Error("サーバー名が一致しない");
        await api("/guilds/" + g.id, {}, "DELETE");
        ctx.closeSettings();
        await ctx.refresh();
      },
      "削除",
    );
  }
  function guildItems(g) {
    const owner = g.owner === ctx.getMe().id,
      can = ctx.can("manageChannels", g),
      at = (fn) => async () => {
        await ctx.selectGuild(g.id);
        return fn();
      };
    return [
      owner && { label: "友達を招待", icon: "users", action: at(ctx.invite) },
      {
        label: "サーバー設定",
        icon: "settings",
        action: at(() => ctx.serverSettings()),
      },
      can && {
        label: "チャンネルを作成",
        icon: "plus",
        action: at(() => channelDialog({ guild: g })),
      },
      can && {
        label: "カテゴリを作成",
        icon: "folder",
        action: at(() => categoryDialog(g)),
      },
      {
        label: "すべて既読にする",
        icon: "check",
        action: () => g.channels.forEach((r) => ctx.markRead(r.id)),
      },
      { label: "サーバーIDをコピー", icon: "copy", action: () => copy(g.id) },
      owner && { separator: true },
      owner && {
        label: "サーバーを削除",
        icon: "trash",
        danger: true,
        action: () => deleteGuild(g),
      },
    ];
  }
  function channelDialog({
    guild = ctx.getGuild(),
    room = null,
    kind = "text",
    category = null,
    onSaved,
  } = {}) {
    const name = n("input", {
        value: room?.name ?? "",
        maxlength: 60,
        required: true,
        "aria-label": "チャンネル名",
        placeholder: "新しいチャンネル",
      }),
      topic = n(
        "textarea",
        { rows: 3, maxlength: 1024, "aria-label": "説明" },
        room?.topic ?? "",
      );
    let selected = room?.kind ?? kind;
    const types = [
      ["text", "テキスト", "hash"],
      ["voice", "ボイス", "volume"],
      ["announcement", "お知らせ", "megaphone"],
      ["rules", "ルール", "book"],
    ];
    const choices = n("div", {
      class: "channel-type-grid",
      role: "radiogroup",
      "aria-label": "種類",
    });
    for (const [value, label, glyph] of types) {
      const radio = n("input", {
        type: "radio",
        name: "channel-kind",
        value,
        "aria-label": label,
      });
      radio.checked = selected === value;
      radio.onchange = () => {
        selected = value;
        slowWrap.hidden = value === "voice";
      };
      choices.append(
        n(
          "label",
          { class: "channel-type-card" },
          radio,
          icon(glyph, 22),
          n("span", {}, label),
        ),
      );
    }
    const slow = n(
      "select",
      { "aria-label": "スローモード" },
      ...[
        [0, "なし"],
        [5, "5秒"],
        [10, "10秒"],
        [30, "30秒"],
        [60, "1分"],
        [300, "5分"],
        [600, "10分"],
        [3600, "1時間"],
      ].map(([value, label]) => n("option", { value }, label)),
    );
    slow.value = String(room?.slowmode ?? 0);
    const slowWrap = n("label", {}, "スローモード", slow);
    slowWrap.hidden = selected === "voice";
    const preview = n(
      "div",
      { class: "editor-location" },
      icon("folder", 16),
      guild.name,
      ...((room?.category ?? category)
        ? [
            " / " +
              (guild.categories.find(
                (c) => c.id === (room?.category ?? category),
              )?.name ?? ""),
          ]
        : []),
    );
    const body = n(
      "div",
      { class: "workspace-editor" },
      preview,
      choices,
      n("label", {}, "チャンネル名", name),
      n("label", {}, "説明", topic),
      ...(room ? [slowWrap] : []),
    );
    modal(
      room ? "チャンネルを編集" : "チャンネルを作成",
      body,
      async () => {
        let id = room?.id;
        if (room)
          await api(
            "/rooms/" + id,
            { name: name.value, topic: topic.value },
            "PATCH",
          );
        else {
          id = (
            await api("/guilds/" + guild.id + "/channels", {
              name: name.value,
              kind: selected,
              topic: topic.value,
            })
          ).id;
        }
        if (room || category)
          await api(
            "/guilds/" + guild.id + "/channelmeta/" + id,
            {
              kind: selected,
              slowmode: Number(slow.value),
              ...(room ? {} : { category }),
            },
            "PATCH",
          );
        await ctx.refresh();
        if (onSaved) await onSaved();
      },
      room ? "保存" : "作成",
    );
  }
  function profileCard(u) {
    const state = ctx.getState(),
      online = state.online.includes(u.id) && u.profile?.status !== "invisible",
      profile = u.profile ?? {},
      status = online
        ? ({ idle: "退席中", dnd: "取り込み中" }[profile.status] ??
          "オンライン")
        : "オフライン";
    const banner = n("div", { class: "profile-cover" });
    banner.style.background = profile.bannerColor ?? "#8b7cf8";
    const identity = n(
      "div",
      { class: "profile-identity" },
      ctx.avatar(u, online),
      n("span", { class: "profile-presence" }, status),
    );
    const content = n(
      "div",
      { class: "profile-details" },
      n("h3", {}, u.display ?? u.username),
      n("div", { class: "profile-handle" }, "@" + u.username),
      profile.pronouns ? n("small", {}, profile.pronouns) : null,
    );
    if (profile.bio)
      content.append(
        n(
          "section",
          { class: "profile-bio" },
          n("h4", {}, "自己紹介"),
          n("p", {}, profile.bio),
        ),
      );
    const common = state.guilds.filter((g) =>
      g.roster.members.some((m) => m.id === u.id),
    );
    if (common.length)
      content.append(
        n(
          "section",
          { class: "profile-server" },
          n("h4", {}, "共通のサーバー"),
          ...common.map((g) => n("div", {}, n("span", {}, g.name))),
        ),
      );
    return n("div", { class: "workspace-profile" }, banner, identity, content);
  }
  function home() {
    const state = ctx.getState(),
      me = ctx.getMe(),
      query = ctx.query().toLocaleLowerCase();
    const people = state.users.filter(
      (u) =>
        u.id !== me.id &&
        (homeTab === "all" ||
          (state.online.includes(u.id) && u.profile?.status !== "invisible")) &&
        (u.display + " " + u.username).toLocaleLowerCase().includes(query),
    );
    const tabs = n("div", {
      class: "home-tabs",
      role: "tablist",
      "aria-label": "ユーザー一覧",
    });
    for (const [id, label] of [
      ["online", "オンライン"],
      ["all", "すべて"],
    ]) {
      const tab = b(
        label,
        () => {
          homeTab = id;
          ctx.renderMessages();
        },
        homeTab === id ? "selected" : "",
      );
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(homeTab === id));
      tabs.append(tab);
    }
    const list = n("div", { class: "home-people" });
    for (const u of people) {
      const row = n("div", { class: "home-person" }),
        open = b("", () => ctx.memberDialog(u), "home-person-profile");
      open.append(
        ctx.avatar(u, state.online.includes(u.id)),
        n(
          "div",
          {},
          n("strong", {}, u.display),
          n("small", {}, "@" + u.username),
        ),
      );
      const dm = b("", () => ctx.startDM(u), "icon-button");
      dm.append(icon("reply", 20));
      dm.setAttribute("aria-label", u.display + "にメッセージ");
      row.append(open, dm);
      list.append(row);
    }
    if (!people.length)
      list.append(
        n(
          "div",
          { class: "home-empty" },
          icon("users", 32),
          n(
            "p",
            {},
            query
              ? "一致するユーザーはいない"
              : homeTab === "online"
                ? "オンラインのユーザーはいない"
                : "共通のサーバーやDMのユーザーがここに表示される",
          ),
        ),
      );
    const actions = n(
      "div",
      { class: "home-actions" },
      b("DM を開始", ctx.newDM, "primary"),
      b("サーバーを作成", ctx.createGuild),
    );
    const updates = n(
      "aside",
      { class: "home-updates" },
      n("h2", {}, icon("history", 20), "アップデートログ"),
      n(
        "article",
        { class: "update-card" },
        n("div", { class: "update-date" }, "2026.10.25", n("span", {}, "NEW")),
        n("h3", {}, "右クリック、解禁"),
        n("p", {}, "チャンネル・カテゴリ・サーバーの編集や削除を、その場で。"),
        n(
          "ul",
          {},
          n("li", {}, "編集画面とプロフィールを整理"),
          n("li", {}, "ホームにオンライン一覧を追加"),
          n("li", {}, "小さすぎた人型アイコンも修正"),
        ),
      ),
      n(
        "article",
        { class: "update-card" },
        n("div", { class: "update-date" }, "2026.10.24"),
        n("h3", {}, "ログインのやり直しを削減"),
        n(
          "p",
          {},
          "タブを閉じてもログインを保持。メンションはユーザー・ロール・everyoneに対応。",
        ),
      ),
    );
    return n(
      "div",
      { class: "workspace-home" },
      n(
        "section",
        { class: "home-directory" },
        n("header", {}, n("h2", {}, "ユーザー"), tabs),
        actions,
        n(
          "h3",
          { class: "home-list-title" },
          (homeTab === "online" ? "オンライン" : "ユーザー") +
            " — " +
            people.length,
        ),
        list,
      ),
      updates,
    );
  }
  return {
    menu,
    bind,
    channelItems,
    categoryItems,
    guildItems,
    categoryDialog,
    channelDialog,
    profileCard,
    home,
    closeMenu,
    deleteGuild,
  };
}
