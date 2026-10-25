import { transformText } from "./developer-format.js";
import { icon } from "./icons.js";
import {
  createPersonalStore,
  emptyPersonalData,
  expandTemplate,
  buttonMarkup,
} from "./personal-store.js";
export function createProductivity(ctx) {
  const { node: n, button: b, modal, guard, toast } = ctx,
    input = ctx.input;
  let store = null,
    data = emptyPersonalData(),
    generation = 0,
    timer = null,
    notes = new Map(),
    drafts = new Map(),
    panel = null,
    activeTab = "notes";
  const status = n("span", {
    class: "personal-save-state",
    "aria-live": "polite",
  });
  function changed() {
    status.textContent = "保存中…";
    clearTimeout(timer);
    timer = setTimeout(() => guard(flush), 300);
  }
  async function flush() {
    clearTimeout(timer);
    timer = null;
    if (!store) return;
    const pendingNotes = new Map(notes),
      pendingDrafts = new Map(drafts);
    notes.clear();
    drafts.clear();
    const mine = store,
      epoch = generation;
    if (pendingNotes.size || pendingDrafts.size) {
      try {
        const result = await mine.edit((value) => {
          for (const [id, text] of pendingNotes)
            text ? (value.notes[id] = text) : delete value.notes[id];
          for (const [id, draft] of pendingDrafts)
            draft.text || draft.reply
              ? (value.drafts[id] = draft)
              : delete value.drafts[id];
        });
        if (epoch === generation) data = result;
      } catch (error) {
        if (epoch === generation) {
          for (const [id, v] of pendingNotes)
            if (!notes.has(id)) notes.set(id, v);
          for (const [id, v] of pendingDrafts)
            if (!drafts.has(id)) drafts.set(id, v);
          status.textContent = "保存できない";
        }
        throw error;
      }
    }
    await mine.flush();
    if (epoch === generation && !notes.size && !drafts.size)
      status.textContent = "保存済み";
  }
  async function load() {
    generation++;
    store = createPersonalStore(ctx.getMe());
    data = await store.load();
    notes.clear();
    drafts.clear();
    hydrate();
  }
  function hydrate() {
    for (const [id, value] of Object.entries(data.drafts))
      if (!ctx.drafts.has(id))
        ctx.drafts.set(id, {
          text: value.text,
          reply: value.reply ?? null,
          attachments: [],
        });
  }
  function saveDraft(id, text, reply) {
    if (!store || !id) return;
    const previous = drafts.get(id) ?? data.drafts[id];
    if (
      (previous?.text ?? "") === text &&
      (previous?.reply ?? null) === (reply ?? null)
    )
      return;
    drafts.set(id, { text, reply: reply ?? null, updated: Date.now() });
    changed();
  }

  async function removeDraft(id) {
    saveDraft(id, "", null);
    await flush();
  }
  function reset() {
    generation++;
    clearTimeout(timer);
    store = null;
    data = emptyPersonalData();
    notes.clear();
    drafts.clear();
    closeCandidates();
    panel = null;
  }
  async function edit(change) {
    if (!store) throw Error("ログインして");
    await flush();
    data = await store.edit(change);
    return data;
  }
  const rooms = () => ctx.rooms();
  const roomLabel = (r) =>
    r.parent + " / " + (r.kind === "dm" ? "@" : "#") + r.name;
  function insert(text, range = null) {
    if (!ctx.getRoom() || input.disabled)
      throw Error("送信できるチャンネルを開いて");
    const start = range?.start ?? input.selectionStart,
      end = range?.end ?? input.selectionEnd;
    if (input.value.length - (end - start) + text.length > 8000)
      throw Error("メッセージは8000文字まで");
    input.setRangeText(text, start, end, "end");
    input.focus();
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function expanded(template) {
    return expandTemplate(template.text, {
      channel: rooms().find((r) => r.id === ctx.getRoom()?.id)?.name ?? "",
      me: ctx.getUser().display ?? ctx.getUser().username,
    });
  }
  async function open(tab) {
    ctx.stashDraft();
    await flush();
    if (!store) throw Error("自分用データを開けない");
    data = await store.load();
    hydrate();
    activeTab = tab ?? (ctx.getRoom() ? "notes" : "templates");
    panel = n("div", { class: "personal-panel" });
    modal("自分用ツール", panel);
    render();
  }
  function render() {
    if (!panel?.isConnected) return;
    const tabs = n("div", {
      class: "personal-tabs",
      role: "tablist",
      "aria-label": "自分用ツール",
    });
    for (const [id, label, glyph] of [
      ["notes", "メモ", "notebook"],
      ["templates", "定型文", "copy"],
      ["drafts", "下書き", "edit"],
      ["convert", "変換", "code"],
    ]) {
      const tab = b(
        "",
        () => {
          activeTab = id;
          render();
        },
        id === activeTab ? "selected" : "",
      );
      tab.append(icon(glyph, 17), label);
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(id === activeTab));
      tabs.append(tab);
    }
    const body = n("section", { class: "personal-content", role: "tabpanel" });
    panel.replaceChildren(tabs, body);
    if (activeTab === "notes") renderNotes(body);
    if (activeTab === "templates") renderTemplates(body);
    if (activeTab === "drafts") renderDrafts(body);
    if (activeTab === "convert") renderConverter(body);
  }
  function renderNotes(body) {
    const available = rooms();
    if (!available.length) {
      body.append(
        n("p", { class: "personal-empty" }, "メモを付けるチャンネルはまだない"),
      );
      return;
    }
    const select = n(
      "select",
      { "aria-label": "メモのチャンネル" },
      ...available.map((r) => n("option", { value: r.id }, roomLabel(r))),
    );
    select.value = ctx.getRoom()?.id ?? available[0].id;
    const text = n("textarea", {
      rows: 10,
      maxlength: 32768,
      "aria-label": "自分用メモ",
      placeholder: "メモを書く",
    });
    const foot = n(
      "div",
      { class: "personal-note-footer" },
      n("span", {}, "自分専用・このブラウザのみ"),
      status,
    );
    function show() {
      text.value = notes.get(select.value) ?? data.notes[select.value] ?? "";
      status.textContent = "保存済み";
    }
    select.onchange = show;
    text.oninput = () => {
      notes.set(select.value, text.value);
      changed();
    };
    text.onblur = () => guard(flush);
    show();
    body.append(select, text, foot);
  }
  function renderTemplates(body) {
    const add = b("", () => templateEditor(body), "primary");
    add.append(icon("plus", 16), "定型文を作成");
    body.append(n("div", { class: "personal-toolbar" }, add));
    if (!data.templates.length) {
      body.append(n("p", { class: "personal-empty" }, "定型文はまだない"));
      return;
    }
    for (const template of data.templates) {
      const card = n(
        "article",
        { class: "personal-card" },
        n("strong", {}, template.name),
        n("p", {}, template.text),
      );
      const insertButton = b(
        "挿入",
        () => {
          insert(expanded(template));
          document.querySelector("#modal").close();
        },
        "primary",
      );
      insertButton.disabled = !ctx.getRoom() || input.disabled;
      card.append(
        n(
          "div",
          { class: "personal-card-actions" },
          insertButton,
          b("コピー", async () => {
            await navigator.clipboard.writeText(expanded(template));
            toast("コピーした");
          }),
          b("編集", () => templateEditor(body, template)),
          b(
            "削除",
            async () => {
              await edit((value) => {
                value.templates = value.templates.filter(
                  (t) => t.id !== template.id,
                );
              });
              render();
            },
            "danger",
          ),
        ),
      );
      body.append(card);
    }
  }
  function templateEditor(body, existing = null) {
    const name = n("input", {
        value: existing?.name ?? "",
        maxlength: 60,
        "aria-label": "定型文名",
        placeholder: "定型文名",
      }),
      text = n(
        "textarea",
        {
          rows: 7,
          maxlength: 8000,
          "aria-label": "定型文の本文",
          placeholder: "本文",
        },
        existing?.text ?? "",
      ),
      error = n("p", { class: "error", "aria-live": "polite" });
    const variables = n(
      "div",
      { class: "template-variables" },
      ...["date", "time", "channel", "me"].map((key) =>
        b("{" + key + "}", () => {
          text.setRangeText(
            "{" + key + "}",
            text.selectionStart,
            text.selectionEnd,
            "end",
          );
          text.focus();
        }),
      ),
    );
    body.replaceChildren(
      n("label", {}, "名前", name),
      n("label", {}, "本文", text),
      variables,
      error,
      n(
        "div",
        { class: "personal-card-actions" },
        b(
          "保存",
          async () => {
            if (!name.value.trim() || !text.value.trim()) {
              error.textContent = "名前と本文を入力して";
              return;
            }
            if (!existing && data.templates.length >= 100) {
              error.textContent = "定型文は100個まで";
              return;
            }
            const template = {
              id: existing?.id ?? crypto.randomUUID(),
              name: name.value.trim(),
              text: text.value,
            };
            await edit((value) => {
              const i = value.templates.findIndex((t) => t.id === template.id);
              if (i < 0) value.templates.push(template);
              else value.templates[i] = template;
            });
            render();
          },
          "primary",
        ),
        b("キャンセル", render),
      ),
    );
    name.focus();
  }
  function renderConverter(body) {
    const type = n(
      "select",
      { "aria-label": "変換方法" },
      ...[
        ["json", "JSON整形"],
        ["compact", "JSON圧縮"],
        ["base64-encode", "Base64エンコード"],
        ["base64-decode", "Base64デコード"],
        ["url-encode", "URLエンコード"],
        ["url-decode", "URLデコード"],
        ["sha256", "SHA-256"],
      ].map(([value, label]) => n("option", { value }, label)),
    );
    const source = n("textarea", {
        rows: 5,
        maxlength: 100000,
        "aria-label": "変換するテキスト",
        placeholder: "入力",
      }),
      result = n("textarea", {
        rows: 5,
        readonly: true,
        "aria-label": "変換結果",
        placeholder: "結果",
      }),
      error = n("p", { class: "error", "aria-live": "polite" });
    body.append(
      n(
        "div",
        { class: "personal-converter" },
        type,
        source,
        n(
          "div",
          { class: "personal-converter-actions" },
          b(
            "変換",
            async () => {
              try {
                result.value = await transformText(source.value, type.value);
                error.textContent = "";
              } catch {
                error.textContent = "入力の形式を確認して";
              }
            },
            "primary",
          ),
        ),
        error,
        result,
        n(
          "div",
          { class: "personal-converter-actions" },
          b("結果をコピー", async () => {
            await navigator.clipboard.writeText(result.value);
            toast("コピーした");
          }),
        ),
      ),
    );
  }
  function renderDrafts(body) {
    const available = rooms(),
      items = [...ctx.drafts.entries()].filter(
        ([id, value]) =>
          available.some((r) => r.id === id) &&
          (value.text || value.attachments?.length || value.reply),
      );
    if (!items.length) {
      body.append(n("p", { class: "personal-empty" }, "下書きはない"));
      return;
    }
    for (const [id, draft] of items) {
      const room = available.find((r) => r.id === id),
        card = n(
          "article",
          { class: "personal-card" },
          n("strong", {}, roomLabel(room)),
          n("p", {}, draft.text || "添付 " + draft.attachments.length + "件"),
        );
      card.append(
        n(
          "div",
          { class: "personal-card-actions" },
          b(
            "開く",
            async () => {
              document.querySelector("#modal").close();
              await ctx.openRoom(id);
            },
            "primary",
          ),
          b("コピー", async () => {
            await navigator.clipboard.writeText(draft.text ?? "");
            toast("コピーした");
          }),
          b(
            "削除",
            async () => {
              ctx.drafts.delete(id);
              await removeDraft(id);
              if (ctx.getRoom()?.id === id) ctx.clearComposer();
              render();
            },
            "danger",
          ),
        ),
      );
      body.append(card);
    }
  }
  // Completion for supported markup and private templates.
  const candidates = n("div", {
    id: "markup-candidates",
    class: "mention-candidates markup-candidates",
    role: "listbox",
    "aria-label": "記法・定型文の候補",
    hidden: true,
  });
  input.closest(".composer-area").append(candidates);
  let options = [],
    selected = 0,
    range = null;
  function closeCandidates() {
    if (candidates.hidden) {
      range = null;
      return;
    }
    candidates.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-controls", "mention-candidates");
    input.removeAttribute("aria-activedescendant");
    range = null;
  }
  function highlight() {
    [...candidates.children].forEach((el, i) =>
      el.setAttribute("aria-selected", String(i === selected)),
    );
    input.setAttribute("aria-controls", candidates.id);
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-activedescendant", "markup-option-" + selected);
    candidates.children[selected]?.scrollIntoView({ block: "nearest" });
  }
  function updateCandidates() {
    if (input.disabled || input.selectionStart !== input.selectionEnd)
      return closeCandidates();
    const before = input.value.slice(0, input.selectionStart),
      match = /<([^<>\n]{0,100})$/.exec(before);
    if (!match) return closeCandidates();
    const query = match[1].toLocaleLowerCase(),
      head = query.split(":")[0];
    options = [
      {
        name: "リンクボタン",
        detail: "<button:URL>",
        search: "button リンク ボタン",
        glyph: "link",
        kind: "button",
      },
      {
        name: "Mermaid図",
        detail: "図のコードを挿入",
        search: "mermaid 図",
        glyph: "diagram",
        kind: "mermaid",
      },
      {
        name: "コードブロック",
        detail: "言語を指定して挿入",
        search: "code コード",
        glyph: "code",
        kind: "code",
      },
      ...(ctx.getGuild()?.emojis ?? []).map((e) => ({
        name: ":" + e.name + ":",
        detail: "カスタム絵文字",
        search: ":" + e.name,
        kind: "emoji",
        glyph: "smile",
        token: "<:" + e.id + ":>",
      })),
      ...data.templates.map((t) => ({
        name: t.name,
        detail: "定型文",
        search: t.name.toLocaleLowerCase(),
        glyph: "copy",
        kind: "template",
        template: t,
      })),
    ]
      .filter(
        (o) =>
          !query ||
          o.search
            .toLocaleLowerCase()
            .includes(o.kind === "button" ? head : query),
      )
      .slice(0, 30);
    if (!options.length) return closeCandidates();
    range = {
      start: before.length - match[0].length,
      end: input.selectionStart,
      query: match[1],
    };
    selected = 0;
    candidates.replaceChildren(
      ...options.map((option, i) => {
        const row = b("", () => choose(i));
        row.id = "markup-option-" + i;
        row.setAttribute("role", "option");
        row.tabIndex = -1;
        row.onpointerdown = (e) => e.preventDefault();
        row.append(
          icon(option.glyph, 20),
          n("strong", {}, option.name),
          n("small", {}, option.detail),
        );
        return row;
      }),
    );
    candidates.hidden = false;
    highlight();
  }
  function choose(i) {
    const option = options[i],
      at = range;
    if (!option || !at) return;
    closeCandidates();
    if (option.kind === "code" || option.kind === "mermaid") {
      const language = n(
        "select",
        { "aria-label": "コードの言語" },
        ...[
          "text",
          "js",
          "ts",
          "python",
          "bash",
          "json",
          "sql",
          "rust",
          "go",
          "mermaid",
        ].map((value) => n("option", { value }, value)),
      );
      language.value = option.kind === "mermaid" ? "mermaid" : "js";
      const source = n(
        "textarea",
        { rows: 8, maxlength: 7800, "aria-label": "コードの本文" },
        option.kind === "mermaid" ? "flowchart LR\n  A --> B" : "",
      );
      modal(
        "コードを挿入",
        n(
          "div",
          { class: "workspace-editor" },
          n("label", {}, "言語", language),
          n("label", {}, "コード", source),
        ),
        () =>
          insert("```" + language.value + "\n" + source.value + "\n```", at),
        "挿入",
      );
    } else if (option.kind === "button") {
      const url = n("input", {
          type: "url",
          required: true,
          "aria-label": "リンク先URL",
          placeholder: "https://example.com",
        }),
        label = n("input", {
          maxlength: 80,
          "aria-label": "ボタン名",
          placeholder: "省略可",
        });
      if (at.query.startsWith("button:"))
        url.value = at.query.slice(7).split("|")[0];
      modal(
        "リンクボタンを挿入",
        n(
          "div",
          { class: "workspace-editor" },
          n("label", {}, "URL", url),
          n("label", {}, "ボタン名", label),
        ),
        () => {
          insert(buttonMarkup(url.value, label.value), at);
        },
        "挿入",
      );
    } else
      insert(
        option.kind === "emoji" ? option.token : expanded(option.template),
        at,
      );
  }
  input.addEventListener("input", (e) => {
    if (!e.isComposing) updateCandidates();
  });
  input.addEventListener("compositionend", updateCandidates);
  input.addEventListener("click", updateCandidates);
  input.addEventListener("blur", closeCandidates);
  document.addEventListener("pointerdown", (e) => {
    if (e.target !== input && !candidates.contains(e.target)) closeCandidates();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) guard(flush);
  });
  window.addEventListener("pagehide", () => guard(flush));
  return {
    load,
    reset,
    open,
    saveDraft,
    removeDraft,
    flush,
    closeCandidates,
    keydown(e) {
      if (candidates.hidden || e.isComposing || e.keyCode === 229) return false;
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
        closeCandidates();
        return true;
      }
      if (
        e.key === "Tab" ||
        (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey)
      ) {
        e.preventDefault();
        guard(() => choose(selected));
        return true;
      }
      return false;
    },
  };
}
