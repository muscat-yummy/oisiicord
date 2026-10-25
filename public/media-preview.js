import * as C from "./crypto.js";
import { icon } from "./icons.js";
export function mediaMime(file) {
  const mime = String(file?.mime ?? "")
    .toLowerCase()
    .split(";")[0]
    .trim();
  const aliases = {
    "audio/mp3": "audio/mpeg",
    "audio/x-wav": "audio/wav",
    "audio/wave": "audio/wav",
    "audio/x-flac": "audio/flac",
    "audio/x-m4a": "audio/mp4",
  };
  if (!mime || mime === "application/octet-stream") {
    const extension = String(file?.name ?? "")
      .split(".")
      .at(-1)
      .toLowerCase();
    return (
      {
        mp3: "audio/mpeg",
        wav: "audio/wav",
        ogg: "audio/ogg",
        oga: "audio/ogg",
        opus: "audio/ogg",
        m4a: "audio/mp4",
        flac: "audio/flac",
        aac: "audio/aac",
      }[extension] ?? mime
    );
  }
  return aliases[mime] ?? mime;
}
export function previewKind(file) {
  const mime = mediaMime(file);
  return [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/bmp",
  ].includes(mime)
    ? "image"
    : ["video/mp4", "video/webm", "video/ogg"].includes(mime)
      ? "video"
      : [
            "audio/mpeg",
            "audio/wav",
            "audio/ogg",
            "audio/mp4",
            "audio/webm",
            "audio/flac",
            "audio/aac",
          ].includes(mime)
        ? "audio"
        : null;
}
export function validateMedia(bytes, mime) {
  const a = new Uint8Array(bytes),
    view = new DataView(a.buffer, a.byteOffset, a.byteLength),
    ascii = (start, end) => String.fromCharCode(...a.slice(start, end));
  let width = 0,
    height = 0;
  if (
    mime === "image/png" &&
    a.length >= 24 &&
    a[0] === 137 &&
    ascii(1, 4) === "PNG"
  ) {
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (
    mime === "image/gif" &&
    a.length >= 10 &&
    ["GIF87a", "GIF89a"].includes(ascii(0, 6))
  ) {
    width = view.getUint16(6, true);
    height = view.getUint16(8, true);
  } else if (mime === "image/bmp" && a.length >= 26 && ascii(0, 2) === "BM") {
    width = Math.abs(view.getInt32(18, true));
    height = Math.abs(view.getInt32(22, true));
  } else if (mime === "image/jpeg" && a[0] === 255 && a[1] === 216) {
    for (let offset = 2; offset + 4 < a.length;) {
      if (a[offset++] !== 255) continue;
      while (a[offset] === 255) offset++;
      const marker = a[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 0 || marker === 216 || (marker >= 208 && marker <= 215))
        continue;
      const size = view.getUint16(offset);
      if (size < 2 || offset + size > a.length) break;
      if (
        [
          192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
        ].includes(marker) &&
        size >= 7
      ) {
        height = view.getUint16(offset + 3);
        width = view.getUint16(offset + 5);
        break;
      }
      offset += size;
    }
  } else if (
    mime === "image/webp" &&
    a.length >= 30 &&
    ascii(0, 4) === "RIFF" &&
    ascii(8, 12) === "WEBP"
  ) {
    if (ascii(12, 16) === "VP8X") {
      width = 1 + a[24] + (a[25] << 8) + (a[26] << 16);
      height = 1 + a[27] + (a[28] << 8) + (a[29] << 16);
    } else if (ascii(12, 16) === "VP8 " && ascii(23, 26) === "\x9d\x01\x2a") {
      width = view.getUint16(26, true) & 16383;
      height = view.getUint16(28, true) & 16383;
    } else if (ascii(12, 16) === "VP8L" && a[20] === 47) {
      const bits = view.getUint32(21, true);
      width = (bits & 16383) + 1;
      height = ((bits >>> 14) & 16383) + 1;
    }
  } else if (
    ["video/mp4", "audio/mp4"].includes(mime) &&
    a.length >= 12 &&
    ascii(4, 8) === "ftyp"
  )
    return;
  else if (
    ["video/webm", "audio/webm"].includes(mime) &&
    a.length >= 4 &&
    view.getUint32(0) === 0x1a45dfa3
  )
    return;
  else if (
    ["video/ogg", "audio/ogg"].includes(mime) &&
    a.length >= 27 &&
    ascii(0, 4) === "OggS"
  )
    return;
  else if (
    mime === "audio/wav" &&
    a.length >= 12 &&
    ascii(0, 4) === "RIFF" &&
    ascii(8, 12) === "WAVE"
  )
    return;
  else if (mime === "audio/flac" && a.length >= 8 && ascii(0, 4) === "fLaC")
    return;
  else if (
    mime === "audio/mpeg" &&
    a.length >= 4 &&
    ((a.length >= 10 && ascii(0, 3) === "ID3" && [2, 3, 4].includes(a[3])) ||
      (a[0] === 255 &&
        (a[1] & 224) === 224 &&
        (a[1] & 24) !== 8 &&
        (a[1] & 6) !== 0 &&
        (a[2] & 240) !== 0 &&
        (a[2] & 240) !== 240 &&
        (a[2] & 12) !== 12))
  )
    return;
  else if (
    mime === "audio/aac" &&
    a.length >= 7 &&
    a[0] === 255 &&
    (a[1] & 246) === 240
  )
    return;
  else throw Error("プレビューに対応していないファイル");
  if (
    !width ||
    !height ||
    width > 32768 ||
    height > 32768 ||
    width * height > 32 * 1024 * 1024
  )
    throw Error("画像のサイズが大きすぎるか、形式が不正");
}
export function createMediaPreview(ctx) {
  const { node: n, button: b } = ctx,
    cache = new Map(),
    states = new Map(),
    cards = new Map();
  let viewer = null;
  const maximum = 64 * 1024 * 1024;
  const fingerprint = (f) =>
    JSON.stringify([f.id, f.key, f.iv, f.hash, f.size, f.mime]);
  const visible = (entry) =>
    [...entry.nodes].some(
      (root) =>
        states.get(root)?.visible ||
        [...root.querySelectorAll("video,audio")].some(
          (media) => !media.paused,
        ),
    ) || entry.viewers;
  function evict(key, entry) {
    entry.controller.abort();
    if (entry.url) URL.revokeObjectURL(entry.url);
    cache.delete(key);
    for (const root of entry.nodes) {
      const s = states.get(root);
      if (s) {
        s.loaded = false;
        placeholder(s);
      }
    }
  }
  function makeSpace(size) {
    let used = [...cache.values()].reduce((sum, e) => sum + e.size, 0);
    for (const [key, e] of cache) {
      if (used + size <= maximum) break;
      if (!visible(e)) {
        used -= e.size;
        evict(key, e);
      }
    }
    if (used + size > maximum)
      throw Error("プレビューの上限に達した。ファイルを保存して開いて");
  }
  async function acquire(state) {
    let entry = cache.get(state.key);
    if (!entry) {
      const f = state.file;
      if (
        !/^[\w-]{1,100}$/.test(f.id) ||
        !Number.isInteger(f.size) ||
        f.size < 1 ||
        f.size > 25 * 1024 * 1024
      )
        throw Error("添付が不正");
      makeSpace(f.size);
      entry = {
        nodes: new Set(),
        viewers: 0,
        size: f.size,
        url: null,
        controller: new AbortController(),
        promise: null,
      };
      cache.set(state.key, entry);
      entry.promise = (async () => {
        const response = await fetch("/api/files/" + f.id, {
          signal: entry.controller.signal,
        });
        if (!response.ok) throw Error("添付を取得できない");
        const encrypted = await response.arrayBuffer();
        if (encrypted.byteLength > 25 * 1024 * 1024 + 64)
          throw Error("添付が大きすぎる");
        const plain = await C.decryptFile(encrypted, f);
        if (plain.byteLength !== f.size)
          throw Error("添付のサイズが一致しない");
        validateMedia(plain, mediaMime(f));
        if (cache.get(state.key) !== entry)
          throw new DOMException("Canceled", "AbortError");
        entry.url = URL.createObjectURL(
          new Blob([plain], { type: mediaMime(f) }),
        );
        return entry.url;
      })().catch((error) => {
        if (cache.get(state.key) === entry) cache.delete(state.key);
        throw error;
      });
    }
    entry.nodes.add(state.root);
    return { url: await entry.promise, entry };
  }
  function placeholder(state) {
    const load = b(
      "プレビューを読み込む",
      () => loadPreview(state),
      "preview-load",
    );
    load.prepend(
      icon(
        state.kind === "audio"
          ? "headphones"
          : state.kind === "video"
            ? "camera"
            : "image",
        24,
      ),
    );
    state.visual.replaceChildren(load);
  }
  async function loadPreview(state) {
    if (state.loading || state.loaded || !state.root.isConnected) return;
    const scroller = document.querySelector("#messages"),
      top = scroller?.scrollTop ?? 0,
      stick =
        scroller && scroller.scrollHeight - scroller.clientHeight - top < 180;
    const follow = () =>
      requestAnimationFrame(() => {
        if (stick && state.root.isConnected && scroller.scrollTop >= top - 40)
          scroller.scrollTop = scroller.scrollHeight;
      });
    state.loading = true;
    state.visual.replaceChildren(
      n("span", { class: "preview-loading" }, "読み込み中…"),
    );
    try {
      const { url } = await acquire(state);
      if (!state.root.isConnected) return;
      const media = n(
        state.kind === "image" ? "img" : state.kind,
        state.kind === "image"
          ? { src: url, alt: String(state.file.name), decoding: "async" }
          : {
              src: url,
              controls: true,
              preload: "metadata",
              playsinline: true,
              "aria-label": String(state.file.name),
            },
      );
      media.onload = follow;
      media.onloadedmetadata = follow;
      media.onerror = () => {
        state.visual.replaceChildren(
          n(
            "span",
            { class: "preview-error" },
            "この形式はブラウザで再生・表示できない",
          ),
        );
      };
      if (state.kind === "image") {
        const open = b("", () => openImage(state), "preview-image-button");
        open.setAttribute("aria-label", state.file.name + "を拡大");
        open.append(media);
        state.visual.replaceChildren(open);
      } else state.visual.replaceChildren(media);
      state.loaded = true;
      follow();
    } catch (error) {
      if (error.name !== "AbortError" && state.root.isConnected)
        state.visual.replaceChildren(
          n("span", { class: "preview-error" }, "プレビューを表示できない"),
          b("再試行", () => loadPreview(state)),
        );
    } finally {
      state.loading = false;
    }
  }
  async function openImage(state) {
    const { url, entry } = await acquire(state);
    entry.viewers++;
    viewer?.close();
    const image = n("img", { src: url, alt: String(state.file.name) }),
      dialog = n("dialog", {
        class: "image-viewer",
        "aria-label": String(state.file.name),
      }),
      close = b("", () => dialog.close(), "icon-button");
    close.append(icon("close", 22));
    close.setAttribute("aria-label", "閉じる");
    const zoom = n("input", {
      type: "range",
      min: 50,
      max: 200,
      value: 100,
      "aria-label": "画像の拡大率",
    });
    zoom.oninput = () => {
      image.style.width = zoom.value + "%";
      image.style.maxWidth = "none";
    };
    dialog.append(
      n("header", {}, n("strong", {}, String(state.file.name)), close),
      n("div", { class: "image-viewer-stage" }, image),
      n(
        "footer",
        {},
        zoom,
        b("保存", () => ctx.download(state.file), "primary"),
      ),
    );
    dialog.onclose = () => {
      entry.viewers--;
      dialog.remove();
      if (viewer === dialog) viewer = null;
    };
    dialog.onclick = (e) => {
      if (e.target === dialog) dialog.close();
    };
    document.body.append(dialog);
    viewer = dialog;
    dialog.showModal();
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const state = states.get(entry.target);
        if (state) {
          state.visible = entry.isIntersecting;
          if (entry.isIntersecting) loadPreview(state);
        }
      }
    },
    { rootMargin: "200px" },
  );
  const mutations = new MutationObserver(() => {
    for (const [root, state] of states) {
      if (root.isConnected) continue;
      observer.unobserve(root);
      states.delete(root);
      cards.delete(state.cardKey);
      cache.get(state.key)?.nodes.delete(root);
    }
  });
  mutations.observe(document.body, { childList: true, subtree: true });
  function card(file, messageId) {
    const kind = previewKind(file);
    if (!kind) return null;
    const key = fingerprint(file),
      cardKey = messageId + ":" + key;
    if (cards.has(cardKey)) return cards.get(cardKey);
    const root = n("div", { class: "attachment-media" }),
      visual = n("div", { class: "attachment-visual " + kind }),
      info = n(
        "div",
        { class: "file-card" },
        icon(
          kind === "audio"
            ? "headphones"
            : kind === "video"
              ? "camera"
              : "image",
          22,
        ),
        n(
          "div",
          {},
          n("strong", {}, String(file.name)),
          n("small", {}, ctx.formatSize(file.size)),
        ),
        b("保存", () => ctx.download(file)),
      );
    const state = {
      root,
      visual,
      file,
      key,
      cardKey,
      kind,
      visible: false,
      loading: false,
      loaded: false,
    };
    root.append(visual, info);
    states.set(root, state);
    cards.set(cardKey, root);
    placeholder(state);
    observer.observe(root);
    return root;
  }
  function clear() {
    viewer?.close();
    viewer = null;
    observer.disconnect();
    for (const e of cache.values()) {
      e.controller.abort();
      if (e.url) URL.revokeObjectURL(e.url);
    }
    cache.clear();
    states.clear();
    cards.clear();
  }
  return { card, clear };
}
