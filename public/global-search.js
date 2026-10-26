import { icon } from "./icons.js";
import { searchPredicate, exportSearchResults } from "./search-model.js";
function matchBatch(worker, entries, options, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      worker.onmessage = null;
      worker.onerror = null;
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const abort = () => fail(new DOMException("中止", "AbortError"));
    const timer = setTimeout(() => {
      worker.terminate();
      fail(
        Error("検索処理がタイムアウトしました。正規表現を簡単にしてください"),
      );
    }, 1500);
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = ({ data }) => {
      cleanup();
      data.error
        ? reject(Error(data.error))
        : resolve(data.indexes.map((i) => entries[i]));
    };
    worker.onerror = () => fail(Error("検索処理を開始できません"));
    if (signal.aborted) return abort();
    worker.postMessage({ entries, options });
  });
}
export function createGlobalSearch(ctx) {
  const { node: n, button: b } = ctx;
  let dialog,
    query,
    scope,
    kind,
    author,
    after,
    before,
    regex,
    caseSensitive,
    status,
    list,
    form,
    runButton,
    stopButton,
    exportButton,
    format,
    moreButton;
  let results = [],
    shown = 0,
    controller = null,
    worker = null,
    generation = 0;
  function stop() {
    generation++;
    controller?.abort();
    controller = null;
    worker?.terminate();
    worker = null;
    if (form) {
      form.disabled = false;
      runButton.disabled = false;
      stopButton.hidden = true;
    }
  }
  function reset() {
    stop();
    results = [];
    shown = 0;
    dialog?.remove();
    dialog = null;
    form = null;
  }
  function showResults() {
    const end = Math.min(results.length, shown + 100);
    for (const m of results.slice(shown, end)) {
      const result = b(
        "",
        async () => {
          dialog.close();
          await ctx.jump(m.room, m.id);
        },
        "search-result",
      );
      result.append(
        n(
          "span",
          { class: "search-result-meta" },
          m.parent +
            " / " +
            m.channel +
            " · " +
            m.authorName +
            " · " +
            new Date(m.created).toLocaleString("ja-JP"),
        ),
        n("pre", {}, m.text.slice(0, 1000)),
      );
      if (m.files.length)
        result.append(n("small", {}, m.files.map((f) => f.name).join(" · ")));
      list.append(result);
    }
    shown = end;
    moreButton.hidden = shown >= results.length;
  }
  async function search() {
    stop();
    results = [];
    shown = 0;
    list.replaceChildren();
    exportButton.disabled = true;
    moreButton.hidden = true;
    const options = {
      query: query.value,
      kind: kind.value,
      author: author.value,
      regex: regex.checked,
      caseSensitive: caseSensitive.checked,
      after: after.value ? new Date(after.value + "T00:00:00").getTime() : null,
      before: before.value
        ? new Date(before.value + "T00:00:00").setDate(
            new Date(before.value + "T00:00:00").getDate() + 1,
          )
        : null,
    };
    try {
      if (
        !options.query.trim() &&
        options.kind === "all" &&
        !options.author.trim() &&
        !options.after &&
        !options.before
      )
        throw Error("検索語か条件を指定してください");
      if (options.after && options.before && options.after >= options.before)
        throw Error("日付の範囲が不正です");
      searchPredicate(options);
    } catch (error) {
      status.textContent = error.message;
      return;
    }
    const rooms = ctx
      .rooms()
      .filter(
        (r) =>
          scope.value === "all" ||
          (scope.value === "dms" && !r.guild) ||
          (scope.value === "guild" &&
            ctx.guildId() &&
            r.guild === ctx.guildId()) ||
          (scope.value === "room" && r.id === ctx.roomId()),
      );
    results = [];
    shown = 0;
    list.replaceChildren();
    exportButton.disabled = true;
    moreButton.hidden = true;
    controller = new AbortController();
    const signal = controller.signal,
      revision = generation;
    worker = new Worker("/search-worker.js", { type: "module" });
    const currentWorker = worker;
    form.disabled = true;
    runButton.disabled = true;
    stopButton.hidden = false;
    let scanned = 0,
      failed = 0;
    try {
      for (const [index, room] of rooms.entries()) {
        signal.throwIfAborted();
        status.textContent = `${index + 1}/${rooms.length} · ${room.parent} / ${room.name}`;
        let messages;
        try {
          messages = await ctx.read(room, signal, (count) => {
            if (!signal.aborted)
              status.textContent = `${index + 1}/${rooms.length} · ${room.parent} / ${room.name} · ${count}件`;
          });
        } catch (error) {
          if (signal.aborted || error.searchLimit) throw error;
          failed++;
          continue;
        }
        signal.throwIfAborted();
        for (let offset = 0; offset < messages.length; offset += 200) {
          const entries = messages.slice(offset, offset + 200).map((m) => ({
            id: m.id,
            room: room.id,
            parent: room.parent,
            channel: room.name,
            author: m.author,
            authorName: m.authorUser?.display ?? "削除されたユーザー",
            username: m.authorUser?.username ?? "",
            created: m.created,
            text: m.text,
            files: (m.files ?? []).slice(0, 5).map((f) => ({
              name: String(f?.name ?? ""),
              size: f?.size,
              mime: f?.mime,
            })),
          }));
          scanned += entries.length;
          if (scanned > 100000)
            throw Error("検索対象が100000件を超えました。範囲を絞ってください");
          results.push(
            ...(await matchBatch(currentWorker, entries, options, signal)),
          );
          if (results.length > 5000) {
            results = results.slice(0, 5000);
            throw Error("検索結果が5000件を超えました。条件を絞ってください");
          }
        }
      }
      results.sort((a, b) => b.created - a.created || a.id.localeCompare(b.id));
      status.textContent =
        `${results.length}件 · ${scanned}件を検索` +
        (failed ? ` · ${failed}件の会話を取得できませんでした` : "");
    } catch (error) {
      if (revision !== generation) return;
      status.textContent = error.message;
      results.sort((a, b) => b.created - a.created);
    } finally {
      currentWorker.terminate();
      if (revision === generation) {
        worker = null;
        controller = null;
        form.disabled = false;
        runButton.disabled = false;
        stopButton.hidden = true;
        showResults();
        exportButton.disabled = !results.length;
      }
    }
  }
  function build() {
    const field = (label, control) =>
      n("label", {}, n("span", {}, label), control);
    const select = (label, values) => {
      const el = n("select", { "aria-label": label });
      for (const [value, text] of values)
        el.append(n("option", { value }, text));
      return el;
    };
    query = n("input", {
      type: "search",
      maxlength: 500,
      "aria-label": "検索語",
      placeholder: "検索語",
    });
    scope = select("検索範囲", [
      ["all", "すべてのサーバー・DM"],
      ["guild", "このサーバー"],
      ["room", "この会話"],
      ["dms", "すべてのDM"],
    ]);
    kind = select("内容", [
      ["all", "すべて"],
      ["code", "コード"],
      ["diagram", "Mermaid"],
      ["file", "添付"],
      ["link", "リンク"],
    ]);
    author = n("input", { "aria-label": "送信者", placeholder: "名前・ID" });
    after = n("input", { type: "date", "aria-label": "開始日" });
    before = n("input", { type: "date", "aria-label": "終了日" });
    regex = n("input", { type: "checkbox", "aria-label": "正規表現" });
    caseSensitive = n("input", {
      type: "checkbox",
      "aria-label": "大文字と小文字を区別",
    });
    status = n("p", { class: "global-search-status", role: "status" });
    list = n("div", { class: "search-results" });
    runButton = n("button", { type: "submit", class: "primary" }, "検索");
    stopButton = b("停止", () => {
      stop();
      results.sort((a, b) => b.created - a.created);
      shown = 0;
      list.replaceChildren();
      showResults();
      status.textContent = "検索を停止しました · " + results.length + "件";
      exportButton.disabled = !results.length;
    });
    stopButton.hidden = true;
    form = n(
      "fieldset",
      { class: "global-search-fields" },
      n("div", { class: "global-search-query" }, query, field("範囲", scope)),
      n(
        "div",
        { class: "global-search-filters" },
        field("内容", kind),
        field("送信者", author),
        field("開始日", after),
        field("終了日", before),
      ),
      n(
        "div",
        { class: "global-search-options" },
        field("正規表現", regex),
        field("大文字と小文字を区別", caseSensitive),
      ),
    );
    const searchForm = n(
      "form",
      {},
      form,
      n("div", { class: "global-search-actions" }, runButton, stopButton),
    );
    searchForm.onsubmit = (e) => {
      e.preventDefault();
      ctx.guard(search);
    };
    const close = b("", () => dialog.close(), "icon-button");
    close.append(icon("close"));
    close.setAttribute("aria-label", "横断検索を閉じる");
    moreButton = b("さらに表示", showResults);
    moreButton.hidden = true;
    format = select("書き出し形式", [
      ["json", "JSON"],
      ["markdown", "Markdown"],
    ]);
    exportButton = b("結果を書き出す", () => {
      const extension = format.value === "json" ? "json" : "md",
        url = URL.createObjectURL(
          new Blob([exportSearchResults(results, format.value)], {
            type: "text/plain;charset=utf-8",
          }),
        );
      n("a", { href: url, download: "oisiicord-search." + extension }).click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    exportButton.disabled = true;
    dialog = n(
      "dialog",
      {
        id: "global-search-dialog",
        class: "global-search-dialog",
        "aria-labelledby": "global-search-title",
      },
      n(
        "header",
        {},
        n("h2", { id: "global-search-title" }, "横断検索"),
        close,
      ),
      searchForm,
      status,
      list,
      n("footer", {}, moreButton, n("div", {}, format, exportButton)),
    );
    dialog.addEventListener("close", stop);
    document.body.append(dialog);
  }
  function open(initial = "") {
    if (!ctx.signedIn()) return;
    if (!dialog) build();
    scope.querySelector('option[value="guild"]').disabled = !ctx.guildId();
    scope.querySelector('option[value="room"]').disabled = !ctx.roomId();
    if (scope.selectedOptions[0].disabled) scope.value = "all";
    if (initial) query.value = initial;
    dialog.showModal();
    query.focus();
    if (initial) ctx.guard(search);
  }
  return { open, reset };
}
