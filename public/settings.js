import { icon, setIcon } from "./icons.js";
import { preferences, updatePreferences, sound } from "./preferences.js";
import * as C from "./crypto.js";
export function createSettings(ctx) {
  const { node: n, button: b, api, toast } = ctx;
  let shell = null,
    cleanup = () => {},
    mode = "user",
    tab = "account",
    lastFocus;
  const field = (label, input) =>
    n("label", { class: "settings-field" }, n("span", {}, label), input);
  const input = (value = "", attrs = {}) => n("input", { value, ...attrs });
  const heading = (title) => n("h2", { class: "settings-heading" }, title);
  const action = (label, fn, ic, cls = "") => {
    const el = b("", fn, "settings-action " + cls);
    el.append(icon(ic, 20), n("span", {}, label));
    return el;
  };
  function close() {
    cleanup();
    cleanup = () => {};
    shell?.close();
    lastFocus?.focus();
  }
  function toggle(label, key) {
    const control = n("input", {
      type: "checkbox",
      role: "switch",
      "aria-label": label,
    });
    control.checked = !!preferences()[key];
    control.onchange = () => updatePreferences({ [key]: control.checked });
    return n(
      "label",
      { class: "preference-row" },
      n("span", {}, label),
      n(
        "span",
        { class: "switch" },
        control,
        n("span", { class: "switch-track" }),
      ),
    );
  }
  function range(label, key, min, max, unit = "%") {
    const out = n("output", {}, preferences()[key] + unit),
      slider = input(preferences()[key], {
        type: "range",
        min,
        max,
        "aria-label": label,
      });
    slider.oninput = () => {
      out.textContent = slider.value + unit;
      updatePreferences({ [key]: Number(slider.value) });
    };
    return n(
      "div",
      { class: "range-setting" },
      n("div", {}, n("label", {}, label), out),
      slider,
    );
  }
  function row(title, detail, buttons = []) {
    return n(
      "div",
      { class: "settings-row" },
      n(
        "div",
        {},
        n("strong", {}, title),
        detail ? n("small", {}, detail) : null,
      ),
      ...buttons,
    );
  }
  function errorText(err) {
    toast(err.message ?? String(err));
  }
  async function navigate(next) {
    cleanup();
    cleanup = () => {};
    tab = next;
    for (const el of shell.querySelectorAll("[data-tab]"))
      el.classList.toggle("selected", el.dataset.tab === next);
    const area = shell.querySelector(".settings-content");
    area.replaceChildren();
    area.scrollTop = 0;
    area.classList.remove("page-enter");
    void area.offsetWidth;
    area.classList.add("page-enter");
    try {
      if (mode === "user") await userPage(area, next);
      else await serverPage(area, next);
    } catch (e) {
      area.append(n("p", { class: "error" }, e.message));
    }
  }
  function open(which, initial) {
    lastFocus = document.activeElement;
    mode = which;
    tab = initial;
    if (!shell) {
      shell = n("dialog", {
        id: "settings-dialog",
        class: "settings-dialog",
        "aria-label": "設定",
      });
      document.body.append(shell);
      shell.addEventListener("cancel", (e) => {
        e.preventDefault();
        close();
      });
    }
    cleanup();
    cleanup = () => {};
    shell.replaceChildren();
    const items =
      mode === "user"
        ? [
            ["account", "マイアカウント", "users"],
            ["profile", "プロフィール", "image"],
            ["appearance", "表示", "palette"],
            ["voice", "音声・ビデオ", "volume"],
            ["notifications", "通知", "bell"],
            ["accessibility", "アクセシビリティ", "accessibility"],
            ["keybinds", "キー操作", "keyboard"],
            ["sessions", "ログイン中の端末", "monitor"],
          ]
        : [
            ["overview", "サーバープロフィール", "image"],
            ["members", "メンバー", "users"],
            ["channels", "チャンネル", "hash"],
            ["invites", "招待", "link"],
          ];
    const nav = n(
      "nav",
      {
        class: "settings-navigation",
        "aria-label": mode === "user" ? "ユーザー設定" : "サーバー設定",
      },
      n(
        "div",
        { class: "settings-nav-title" },
        mode === "user" ? "ユーザー設定" : ctx.getGuild().name,
      ),
    );
    for (const [key, label, ic] of items) {
      const el = action(label, () => navigate(key), ic);
      el.dataset.tab = key;
      nav.append(el);
    }
    if (mode === "user")
      nav.append(
        n("div", { class: "settings-nav-divider" }),
        action(
          "ログアウト",
          async () => {
            close();
            await ctx.logout();
          },
          "logout",
          "danger",
        ),
      );
    else if (ctx.getGuild().owner === ctx.getMe().id)
      nav.append(
        n("div", { class: "settings-nav-divider" }),
        action(
          "サーバーを削除",
          () =>
            ctx.modal(
              "サーバーを削除",
              n("p", {}, ctx.getGuild().name),
              async () => {
                await api("/guilds/" + ctx.getGuild().id, {}, "DELETE");
                close();
                await ctx.refresh();
              },
              "削除",
            ),
          "trash",
          "danger",
        ),
      );
    const exit = action("設定を閉じる", close, "close", "settings-exit");
    exit.setAttribute("aria-label", "設定を閉じる");
    exit.replaceChildren(icon("close", 24), n("kbd", {}, "ESC"));
    shell.append(
      n(
        "div",
        { class: "settings-layout" },
        nav,
        n("section", { class: "settings-content" }),
        exit,
      ),
    );
    if (!shell.open) shell.showModal();
    navigate(initial);
  }
  async function userPage(area, selected) {
    const state = ctx.getState(),
      me = state.me,
      profile = me.profile ?? {};
    if (selected === "account") {
      area.append(heading("マイアカウント"));
      const card = n(
        "div",
        { class: "account-card" },
        n("div", { class: "account-banner" }),
        n(
          "div",
          { class: "account-identity" },
          ctx.avatar(me),
          n(
            "div",
            {},
            n("h3", {}, me.display),
            n("span", {}, "@" + me.username),
          ),
          b("プロフィールを編集", () => navigate("profile"), "primary"),
        ),
      );
      card.querySelector(".account-banner").style.background =
        profile.bannerColor ?? "#8b7cf8";
      const details = n(
        "div",
        { class: "account-details" },
        row("表示名", me.display, [b("編集", () => navigate("profile"))]),
        row("ユーザー名", "@" + me.username),
        row("パスワード", "", [b("パスワードを変更", passwordDialog)]),
      );
      card.append(details);
      area.append(
        card,
        heading("アカウント"),
        row("暗号鍵のバックアップ", "", [b("ダウンロード", ctx.backup)]),
      );
    }
    if (selected === "profile") {
      area.append(heading("プロフィール"));
      const display = input(me.display, { maxlength: 40, required: true }),
        pronouns = input(profile.pronouns ?? "", { maxlength: 40 }),
        bio = n("textarea", { rows: 4, maxlength: 190 }, profile.bio ?? ""),
        color = input(profile.bannerColor ?? "#8b7cf8", {
          type: "color",
          "aria-label": "バナーカラー",
        }),
        status = n(
          "select",
          { "aria-label": "ステータス" },
          ...[
            ["online", "オンライン"],
            ["idle", "退席中"],
            ["dnd", "取り込み中"],
            ["invisible", "オフライン表示"],
          ].map(([v, t]) => n("option", { value: v }, t)),
        );
      status.value = profile.status ?? "online";
      const picker = imagePicker(me, false);
      const preview = n(
        "div",
        { class: "profile-preview" },
        n("div", { class: "preview-banner" }),
        n("div", { class: "preview-avatar" }, ctx.avatar(me)),
        n(
          "div",
          { class: "preview-details" },
          n("h3", {}, me.display),
          n("span", { class: "preview-username" }, "@" + me.username),
          n("p", { class: "preview-pronouns" }, profile.pronouns ?? ""),
          n("div", { class: "preview-divider" }),
          n("h4", {}, "自己紹介"),
          n("p", { class: "preview-bio" }, profile.bio ?? ""),
        ),
      );
      preview.querySelector(".preview-banner").style.background = color.value;
      display.oninput = () =>
        (preview.querySelector("h3").textContent = display.value);
      pronouns.oninput = () =>
        (preview.querySelector(".preview-pronouns").textContent =
          pronouns.value);
      bio.oninput = () =>
        (preview.querySelector(".preview-bio").textContent = bio.value);
      color.oninput = () =>
        (preview.querySelector(".preview-banner").style.background =
          color.value);
      picker.onpreview = (url) => {
        const a = preview.querySelector(".preview-avatar");
        a.replaceChildren(
          url
            ? n("img", { src: url, alt: "" })
            : ctx.avatar({ ...me, profile: { ...profile, avatar: null } }),
        );
      };
      const save = b(
        "変更を保存",
        async () => {
          if (!display.value.trim()) throw Error("表示名を入力して");
          save.disabled = true;
          try {
            const avatar = await picker.commit();
            await api(
              "/me",
              {
                display: display.value,
                bio: bio.value,
                pronouns: pronouns.value,
                status: status.value,
                bannerColor: color.value,
                ...(avatar === undefined ? {} : { avatar }),
              },
              "PATCH",
            );
            await ctx.refresh();
            toast("保存した");
            await navigate("profile");
          } finally {
            save.disabled = false;
          }
        },
        "primary",
      );
      area.append(
        n(
          "div",
          { class: "profile-editor" },
          n(
            "div",
            { class: "profile-fields" },
            picker.element,
            field("表示名", display),
            field("代名詞", pronouns),
            field("自己紹介", bio),
            field("ステータス", status),
            field("バナーカラー", color),
            n("div", { class: "settings-save" }, save),
          ),
          n(
            "aside",
            { class: "preview-column" },
            n("h4", {}, "プレビュー"),
            preview,
          ),
        ),
      );
      cleanup = () => picker.dispose();
    }
    if (selected === "appearance") {
      area.append(heading("表示"));
      const themes = n("div", { class: "theme-options" });
      for (const [value, label] of [
        ["dark", "ダーク"],
        ["midnight", "ミッドナイト"],
        ["light", "ライト"],
      ]) {
        const item = b(
          "",
          () => {
            updatePreferences({ theme: value });
            navigate("appearance");
          },
          "theme-choice " +
            value +
            (preferences().theme === value ? " selected" : ""),
        );
        item.setAttribute("aria-label", label);
        item.append(
          n("span", { class: "theme-preview" }, n("i"), n("i"), n("i")),
          n("span", {}, label),
          preferences().theme === value ? icon("check", 18) : null,
        );
        themes.append(item);
      }
      const colors = n("div", { class: "accent-colors" });
      for (const value of [
        "#8b7cf8",
        "#5865f2",
        "#e782ad",
        "#ef8b57",
        "#5bbd9c",
        "#4fa6e3",
      ]) {
        const c = b(
          "",
          () => {
            updatePreferences({ accent: value });
            navigate("appearance");
          },
          "accent-swatch",
        );
        c.style.background = value;
        c.setAttribute("aria-label", value);
        if (preferences().accent === value) c.append(icon("check", 20));
        colors.append(c);
      }
      area.append(
        field("テーマ", themes),
        field("アクセントカラー", colors),
        range("メッセージの文字サイズ", "fontSize", 12, 22, "px"),
        toggle("コンパクト表示", "compact"),
        toggle("時刻を表示", "showTimestamps"),
      );
      const time = n(
        "select",
        { "aria-label": "時刻形式" },
        n("option", { value: "24" }, "24時間"),
        n("option", { value: "12" }, "12時間"),
      );
      time.value = preferences().timeFormat;
      time.onchange = () => {
        updatePreferences({ timeFormat: time.value });
        ctx.renderMessages();
      };
      area.append(field("時刻形式", time));
    }
    if (selected === "voice") {
      area.append(heading("音声・ビデオ"));
      const devices = (await navigator.mediaDevices?.enumerateDevices()) ?? [];
      for (const [kind, key, label] of [
        ["audioinput", "inputDevice", "入力デバイス"],
        ["audiooutput", "outputDevice", "出力デバイス"],
        ["videoinput", "cameraDevice", "カメラ"],
      ]) {
        const select = n(
          "select",
          { "aria-label": label },
          n("option", { value: "" }, "デフォルト"),
        );
        for (const d of devices.filter((d) => d.kind === kind))
          select.append(
            n(
              "option",
              { value: d.deviceId },
              d.label || label + " " + select.options.length,
            ),
          );
        select.value = preferences()[key];
        select.onchange = () => updatePreferences({ [key]: select.value });
        area.append(field(label, select));
      }
      const resolution = n(
        "select",
        { "aria-label": "カメラの画質" },
        n("option", { value: "720" }, "720p"),
        n("option", { value: "1080" }, "1080p"),
      );
      resolution.value = preferences().videoResolution;
      resolution.onchange = () =>
        updatePreferences({ videoResolution: resolution.value });
      area.append(field("カメラの画質", resolution));
      area.append(
        range("入力音量", "inputVolume", 0, 200),
        range("出力音量", "outputVolume", 0, 100),
      );
      let testStream,
        audio,
        frame,
        disposed = false;
      const meter = n("div", { class: "mic-meter" }, n("div")),
        test = b("マイクをテスト", async () => {
          if (testStream) {
            stop();
            test.textContent = "マイクをテスト";
            return;
          }
          testStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              deviceId: preferences().inputDevice
                ? { exact: preferences().inputDevice }
                : undefined,
            },
          });
          if (disposed) {
            testStream.getTracks().forEach((t) => t.stop());
            testStream = null;
            return;
          }
          audio = new AudioContext();
          const analyser = audio.createAnalyser();
          audio.createMediaStreamSource(testStream).connect(analyser);
          const data = new Uint8Array(analyser.fftSize);
          function draw() {
            analyser.getByteTimeDomainData(data);
            const level = Math.sqrt(
              data.reduce((s, v) => s + ((v - 128) / 128) ** 2, 0) /
                data.length,
            );
            meter.firstChild.style.width = Math.min(100, level * 350) + "%";
            frame = requestAnimationFrame(draw);
          }
          draw();
          test.textContent = "テストを停止";
        });
      function stop() {
        cancelAnimationFrame(frame);
        testStream?.getTracks().forEach((t) => t.stop());
        testStream = null;
        if (audio && audio.state !== "closed") audio.close().catch(() => {});
        audio = null;
        meter.firstChild.style.width = "0%";
      }
      cleanup = () => {
        disposed = true;
        stop();
      };
      area.append(
        n("div", { class: "microphone-test" }, test, meter),
        toggle("エコー除去", "echoCancellation"),
        toggle("ノイズ抑制", "noiseSuppression"),
        toggle("入力音量の自動調整", "autoGainControl"),
        b("デバイス一覧を更新", async () => {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
          });
          stream.getTracks().forEach((t) => t.stop());
          await navigate("voice");
        }),
      );
    }
    if (selected === "notifications") {
      area.append(heading("通知"));
      const desktop = n("input", {
        type: "checkbox",
        role: "switch",
        "aria-label": "デスクトップ通知",
      });
      desktop.checked = preferences().desktopNotifications;
      desktop.onchange = async () => {
        if (desktop.checked) {
          if (!("Notification" in window)) {
            desktop.checked = false;
            toast("通知に対応していないブラウザ");
            return;
          }
          const permission = await Notification.requestPermission();
          if (permission !== "granted") {
            desktop.checked = false;
            toast("ブラウザで通知が許可されていない");
            return;
          }
        }
        updatePreferences({ desktopNotifications: desktop.checked });
      };
      area.append(
        n(
          "label",
          { class: "preference-row" },
          n("span", {}, "デスクトップ通知"),
          n(
            "span",
            { class: "switch" },
            desktop,
            n("span", { class: "switch-track" }),
          ),
        ),
        heading("効果音"),
        toggle("新着メッセージ", "notificationSound"),
        toggle("自分の通話への参加・退出", "callSounds"),
        toggle("ほかのメンバーの参加・退出", "peerSounds"),
        range("効果音の音量", "soundVolume", 0, 100),
        b("効果音をテスト", () => sound("preview")),
      );
    }
    if (selected === "accessibility")
      area.append(
        heading("アクセシビリティ"),
        toggle("アニメーションを減らす", "reducedMotion"),
        toggle("コントラストを上げる", "highContrast"),
        range("メッセージの文字サイズ", "fontSize", 12, 22, "px"),
      );
    if (selected === "keybinds") {
      const send = n(
        "select",
        { "aria-label": "メッセージの送信キー" },
        n("option", { value: "enter" }, "Enter"),
        n("option", { value: "ctrl" }, "Ctrl + Enter"),
      );
      send.value = preferences().enterToSend ? "enter" : "ctrl";
      send.onchange = () =>
        updatePreferences({ enterToSend: send.value === "enter" });
      area.append(
        heading("キー操作"),
        field("メッセージの送信キー", send),
        row("改行", "Shift + Enter"),
        row("ミュート切り替え", "Ctrl + Shift + M"),
        row("スピーカーミュート切り替え", "Ctrl + Shift + D"),
        row("設定を閉じる", "Esc"),
      );
    }
    if (selected === "sessions") {
      area.append(heading("ログイン中の端末"));
      for (const session of await api("/sessions"))
        area.append(
          row(
            session.current ? "現在のブラウザ" : "別のセッション",
            "有効期限 " + new Date(session.expires).toLocaleString("ja-JP"),
            session.current
              ? []
              : [
                  b(
                    "ログアウト",
                    async () => {
                      await api("/sessions/" + session.id, {}, "DELETE");
                      await navigate("sessions");
                    },
                    "danger",
                  ),
                ],
          ),
        );
    }
  }
  async function passwordDialog() {
    const old = input("", {
        type: "password",
        autocomplete: "current-password",
        required: true,
      }),
      next = input("", {
        type: "password",
        autocomplete: "new-password",
        required: true,
        minlength: 12,
      }),
      confirm = input("", {
        type: "password",
        autocomplete: "new-password",
        required: true,
        minlength: 12,
      });
    ctx.modal(
      "パスワードを変更",
      [
        field("現在のパスワード", old),
        field("新しいパスワード", next),
        field("新しいパスワード（確認）", confirm),
      ],
      async () => {
        if (next.value.length < 12) throw Error("12文字以上で入力して");
        if (next.value !== confirm.value) throw Error("パスワードが一致しない");
        const me = ctx.getMe(),
          username = ctx.getState().me.username,
          previous = await C.credentials(old.value, me.salt),
          privateKeys = await C.decryptVault(
            me.vault,
            previous.vault,
            username,
          ),
          salt = C.b64(C.random(32)),
          credential = await C.credentials(next.value, salt),
          vault = await C.encryptVault(privateKeys, credential.vault, username),
          proof = { user: me.id, auth: credential.auth, salt, vault };
        await api("/auth/password", {
          ...proof,
          oldAuth: previous.auth,
          signature: await C.sign(proof, me),
        });
        me.salt = salt;
        me.vault = vault;
        toast("パスワードを変更した");
      },
      "変更",
    );
  }
  function imagePicker(owner, guild) {
    let pending, previewURL;
    const existing = guild ? owner.profile?.icon : owner.profile?.avatar;
    const preview = n(
        "div",
        { class: "image-picker-preview" },
        ctx.avatar(
          guild
            ? { display: owner.name, profile: { avatar: existing } }
            : owner,
        ),
      ),
      pick = b("", () => file.click(), "image-picker-button");
    pick.append(
      preview,
      n("span", { class: "image-picker-edit" }, icon("camera", 18)),
    );
    pick.setAttribute(
      "aria-label",
      guild ? "サーバーアイコンを変更" : "アバターを変更",
    );
    const file = n("input", {
        type: "file",
        accept: "image/png,image/jpeg,image/webp,image/gif",
        hidden: true,
      }),
      label = guild ? "アイコン" : "アバター",
      result = {
        element: n(
          "div",
          { class: "image-picker" },
          pick,
          n(
            "div",
            {},
            n("h4", {}, label),
            b("画像を変更", () => file.click(), "primary"),
            b(
              "削除",
              () => {
                pending = null;
                preview.replaceChildren(
                  ctx.avatar({ display: owner.display ?? owner.name }),
                );
                result.onpreview?.(null);
              },
              "link",
            ),
          ),
          file,
        ),
        onpreview: null,
        async commit() {
          if (pending === undefined) return undefined;
          if (pending === null) return null;
          return ctx.uploadImage(pending);
        },
        dispose() {
          if (previewURL) URL.revokeObjectURL(previewURL);
        },
      };
    file.onchange = () => {
      const candidate = file.files[0];
      if (!candidate) return;
      ctx.guard(async () => {
        pending = await cropImage(candidate, n, b);
        if (previewURL) URL.revokeObjectURL(previewURL);
        previewURL = URL.createObjectURL(pending);
        preview.replaceChildren(n("img", { src: previewURL, alt: "" }));
        result.onpreview?.(previewURL);
      });
      file.value = "";
    };
    return result;
  }
  async function serverPage(area, selected) {
    const g = ctx.getGuild(),
      owner = g.owner === ctx.getMe().id,
      profile = g.profile ?? {};
    if (selected === "overview") {
      area.append(heading("サーバープロフィール"));
      const name = input(g.name, { maxlength: 60, required: true }),
        description = n(
          "textarea",
          { rows: 4, maxlength: 300 },
          profile.description ?? "",
        ),
        color = input(profile.bannerColor ?? "#8b7cf8", {
          type: "color",
          "aria-label": "サーバーカラー",
        }),
        picker = imagePicker(g, true);
      const preview = n(
        "div",
        { class: "server-preview" },
        n("div", { class: "preview-banner" }),
        n(
          "div",
          { class: "server-preview-icon" },
          ctx.avatar({ display: g.name, profile: { avatar: profile.icon } }),
        ),
        n("h3", {}, g.name),
        n("p", {}, profile.description ?? ""),
      );
      preview.querySelector(".preview-banner").style.background = color.value;
      name.oninput = () =>
        (preview.querySelector("h3").textContent = name.value);
      description.oninput = () =>
        (preview.querySelector("p").textContent = description.value);
      color.oninput = () =>
        (preview.querySelector(".preview-banner").style.background =
          color.value);
      picker.onpreview = (url) =>
        preview
          .querySelector(".server-preview-icon")
          .replaceChildren(
            url
              ? n("img", { src: url, alt: "" })
              : ctx.avatar({ display: name.value }),
          );
      if (owner) {
        const save = b(
          "変更を保存",
          async () => {
            if (!name.value.trim()) throw Error("サーバー名を入力して");
            save.disabled = true;
            try {
              const icon = await picker.commit();
              await api(
                "/guilds/" + g.id,
                {
                  name: name.value,
                  description: description.value,
                  bannerColor: color.value,
                  ...(icon === undefined ? {} : { icon }),
                },
                "PATCH",
              );
              await ctx.refresh();
              toast("保存した");
              await navigate("overview");
            } finally {
              save.disabled = false;
            }
          },
          "primary",
        );
        area.append(
          n(
            "div",
            { class: "profile-editor" },
            n(
              "div",
              { class: "profile-fields" },
              picker.element,
              field("サーバー名", name),
              field("説明", description),
              field("サーバーカラー", color),
              n("div", { class: "settings-save" }, save),
            ),
            n(
              "aside",
              { class: "preview-column" },
              n("h4", {}, "プレビュー"),
              preview,
            ),
          ),
        );
        cleanup = () => picker.dispose();
      } else area.append(preview);
    }
    if (selected === "members") {
      area.append(heading("メンバー"));
      if (g.requests?.length) {
        area.append(n("h3", {}, "参加申請"));
        for (const u of g.requests)
          area.append(
            row(u.display, "@" + u.username, [
              b("確認", () => ctx.approveDialog(u)),
            ]),
          );
      }
      for (const m of g.roster.members) {
        const u = ctx.getUser(m.id),
          identity = n(
            "div",
            { class: "member-setting-identity" },
            ctx.avatar(u),
            n(
              "div",
              {},
              n("strong", {}, u.display),
              n("small", {}, "@" + u.username),
            ),
          );
        area.append(
          n(
            "div",
            { class: "settings-row" },
            identity,
            m.id === g.owner
              ? n("span", { class: "owner-label" }, "所有者")
              : owner
                ? b(
                    "削除",
                    () =>
                      ctx.modal(
                        "メンバーを削除",
                        n("p", {}, u.display),
                        async () => {
                          await ctx.updateRoster(
                            g.roster.members.filter((x) => x.id !== m.id),
                          );
                          navigate("members");
                        },
                        "削除",
                      ),
                    "danger",
                  )
                : null,
          ),
        );
      }
    }
    if (selected === "channels") {
      area.append(heading("チャンネル"));
      for (const r of g.channels) {
        const title = n(
          "div",
          { class: "channel-setting-title" },
          icon(r.kind === "voice" ? "volume" : "hash", 22),
          n("span", {}, r.name),
        );
        const controls = owner
          ? [
              b("編集", () =>
                ctx.prompt("チャンネル名", "名前", r.name, async (name) => {
                  await api("/rooms/" + r.id, { name }, "PATCH");
                  await ctx.refresh();
                  navigate("channels");
                }),
              ),
              b(
                "削除",
                () =>
                  ctx.modal(
                    "チャンネルを削除",
                    n("p", {}, r.name),
                    async () => {
                      await api("/rooms/" + r.id, {}, "DELETE");
                      await ctx.refresh();
                      navigate("channels");
                    },
                    "削除",
                  ),
                "danger",
              ),
            ]
          : [];
        area.append(n("div", { class: "settings-row" }, title, ...controls));
      }
      if (owner)
        area.append(
          n(
            "div",
            { class: "buttons" },
            b(
              "テキストチャンネルを作成",
              () => ctx.newChannel("text"),
              "primary",
            ),
            b("ボイスチャンネルを作成", () => ctx.newChannel("voice")),
          ),
        );
    }
    if (selected === "invites") {
      area.append(heading("招待"));
      if (!owner) {
        area.append(
          n("p", { class: "empty" }, "招待はサーバーの所有者が作成できる"),
        );
        return;
      }
      area.append(
        action("招待リンクを作成", ctx.inviteDialog, "link"),
        n("div", { class: "settings-nav-divider" }),
      );
      const invites = await api("/guilds/" + g.id + "/invites");
      for (const invite of invites)
        area.append(
          row(
            "招待リンク",
            "有効期限 " + new Date(invite.expires).toLocaleString("ja-JP"),
          ),
        );
      if (invites.length)
        area.append(
          b(
            "すべての招待を無効にする",
            () =>
              ctx.modal(
                "招待リンクを無効にする",
                n("p", {}, invites.length + "件の招待リンク"),
                async () => {
                  await api("/guilds/" + g.id + "/invites", {}, "DELETE");
                  navigate("invites");
                },
                "無効にする",
              ),
            "danger",
          ),
        );
      else area.append(n("p", { class: "empty" }, "有効な招待はない"));
    }
  }
  return {
    user: (initial = "account") => open("user", initial),
    server: (initial = "overview") => open("server", initial),
    close,
  };
}
export async function cropImage(file, n, b) {
  if (
    !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
      file.type,
    ) ||
    file.size > 10 * 1024 * 1024
  )
    throw Error("PNG・JPEG・WebP・GIF、10 MiBまで");
  const bitmap = await createImageBitmap(file);
  return new Promise((resolve, reject) => {
    const dialog = n("dialog", {
        class: "crop-dialog",
        "aria-label": "画像を調整",
      }),
      canvas = n("canvas", { width: 320, height: 320 }),
      zoom = n("input", {
        type: "range",
        min: 1,
        max: 3,
        step: 0.01,
        value: 1,
        "aria-label": "拡大",
      });
    let x = 0,
      y = 0,
      drag;
    const context = canvas.getContext("2d");
    function draw() {
      const scale =
          Math.max(320 / bitmap.width, 320 / bitmap.height) *
          Number(zoom.value),
        w = bitmap.width * scale,
        h = bitmap.height * scale;
      x = Math.max(-(w - 320) / 2, Math.min((w - 320) / 2, x));
      y = Math.max(-(h - 320) / 2, Math.min((h - 320) / 2, y));
      context.clearRect(0, 0, 320, 320);
      context.drawImage(bitmap, (320 - w) / 2 + x, (320 - h) / 2 + y, w, h);
    }
    zoom.oninput = draw;
    canvas.onpointerdown = (e) => {
      drag = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    };
    canvas.onpointermove = (e) => {
      if (!drag) return;
      const ratio = 320 / canvas.getBoundingClientRect().width;
      x += (e.clientX - drag.x) * ratio;
      y += (e.clientY - drag.y) * ratio;
      drag = { x: e.clientX, y: e.clientY };
      draw();
    };
    canvas.onpointerup = () => (drag = null);
    function finish() {
      bitmap.close();
      dialog.close();
      dialog.remove();
    }
    const cancel = () => {
      finish();
      reject(new DOMException("", "AbortError"));
    };
    dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      cancel();
    });
    dialog.append(
      n("h2", {}, "画像を調整"),
      canvas,
      n("label", {}, "拡大", zoom),
      n(
        "footer",
        {},
        b("キャンセル", cancel),
        b(
          "適用",
          async () => {
            const out = document.createElement("canvas");
            out.width = out.height = 128;
            out.getContext("2d").drawImage(canvas, 0, 0, 128, 128);
            const blob = await new Promise((resolve) =>
              out.toBlob(resolve, "image/webp", 0.82),
            );
            if (!blob || blob.size > 65536) {
              reject(Error("画像を変換できない"));
              finish();
              return;
            }
            const result = new File([blob], "avatar.webp", {
              type: "image/webp",
            });
            finish();
            resolve(result);
          },
          "primary",
        ),
      ),
    );
    document.body.append(dialog);
    dialog.showModal();
    draw();
  });
}
