import { icon } from "./icons.js";
import { validateMermaid } from "./developer-format.js";
const diagrams = new Map();
const activeRenders = new Set();
let epoch = 0;
export function clearDeveloperCaches() {
  epoch++;
  diagrams.clear();
  for (const cancel of [...activeRenders]) cancel();
}
let renderQueue = Promise.resolve(),
  highlighter;
function cleanSVG(source, theme) {
  const inert = document.createElement("template");
  inert.innerHTML = source;
  const svg = inert.content.firstElementChild;
  if (
    !svg ||
    svg.localName !== "svg" ||
    svg.namespaceURI !== "http://www.w3.org/2000/svg"
  )
    throw Error("図を読み込めない");
  svg
    .querySelectorAll(
      "script,foreignObject,image,iframe,object,embed,animate,animateTransform,set",
    )
    .forEach((el) => el.remove());
  for (const el of [svg, ...svg.querySelectorAll("*")]) {
    for (const attr of [...el.attributes]) {
      if (
        /^on/i.test(attr.name) ||
        (attr.localName === "href" && !attr.value.startsWith("#")) ||
        /url\s*\(\s*['"]?(?!#)/i.test(attr.value)
      )
        el.removeAttribute(attr.name);
    }
    if (el.localName === "style")
      el.textContent = el.textContent
        .replace(/@import[^;]*;?/gi, "")
        .replace(/url\s*\(\s*['"]?(?!#)[^)]*\)/gi, "none");
  }
  svg.style.backgroundColor = theme === "light" ? "#ffffff" : "#202127";
  return new XMLSerializer().serializeToString(svg);
}
function displayFrame(n, svg, cls) {
  const frame = n("iframe", {
    class: cls,
    sandbox: "allow-scripts",
    title: "Mermaid図",
    src: "/diagram-view.html",
  });
  frame.onload = () =>
    frame.contentWindow.postMessage(
      {
        type: "display-diagram",
        svg,
        theme: document.documentElement.dataset.theme,
      },
      "*",
    );
  return frame;
}

function diagramSVG(source, theme) {
  const key = theme + "\n" + source;
  if (diagrams.has(key)) return diagrams.get(key);
  const expectedEpoch = epoch;
  const render = () =>
    new Promise((resolve, reject) => {
      if (expectedEpoch !== epoch) {
        reject(new DOMException("Canceled", "AbortError"));
        return;
      }
      validateMermaid(source);
      const id = crypto.randomUUID().replaceAll("-", ""),
        frame = document.createElement("iframe");
      frame.className = "mermaid-worker";
      frame.setAttribute("sandbox", "allow-scripts");
      frame.src = "/mermaid-frame.html";
      frame.setAttribute("aria-hidden", "true");
      let sent = false;
      const done = (error, value) => {
        clearTimeout(timer);
        activeRenders.delete(cancel);
        window.removeEventListener("message", receive);
        frame.remove();
        error ? reject(error) : resolve(value);
      };
      const receive = (event) => {
        if (event.source !== frame.contentWindow) return;
        if (event.data?.type === "mermaid-ready" && !sent) {
          sent = true;
          frame.contentWindow.postMessage(
            { type: "render-mermaid", id, source, theme },
            "*",
          );
        }
        if (event.data?.id !== id) return;
        if (
          event.data.type === "mermaid-rendered" &&
          typeof event.data.svg === "string" &&
          event.data.svg.length < 2000000
        ) {
          try {
            done(null, cleanSVG(event.data.svg, theme));
          } catch (error) {
            done(error);
          }
        }
        if (event.data.type === "mermaid-error") done(Error(event.data.error));
      };
      const cancel = () => done(new DOMException("Canceled", "AbortError"));
      activeRenders.add(cancel);
      const timer = setTimeout(
        () => done(Error("図の変換がタイムアウトした")),
        20000,
      );
      window.addEventListener("message", receive);
      document.body.append(frame);
    });
  const promise = renderQueue.then(render);
  renderQueue = promise.catch(() => {});
  diagrams.set(key, promise);
  promise.catch(() => {
    if (diagrams.get(key) === promise) diagrams.delete(key);
  });
  if (diagrams.size > 40) diagrams.delete(diagrams.keys().next().value);
  return promise;
}
export function createDeveloperUI(ctx) {
  const { node: n, button: b } = ctx;
  function action(label, glyph, fn) {
    const button = b("", fn, "code-action");
    button.append(icon(glyph, 15), n("span", {}, label));
    button.setAttribute("aria-label", label);
    return button;
  }
  function codeBlock(original, language) {
    const diagram = language === "mermaid",
      block = n("section", {
        class: "code-block" + (diagram ? " mermaid-block" : ""),
      }),
      header = n(
        "div",
        { class: "code-header" },
        n("span", { class: "code-language" }, language || "text"),
      ),
      code = n("code", {}, original),
      pre = n("pre", { class: "code-source" }, code),
      error = n("div", { class: "code-error", hidden: true });
    let text = original,
      showSource = !diagram;
    const copy = action("コピー", "copy", async () => {
      await navigator.clipboard.writeText(text);
      ctx.toast("コピーした");
    });
    header.append(copy);
    if (diagram) {
      const preview = n(
        "div",
        { class: "mermaid-preview" },
        n("span", { class: "diagram-loading" }, "図を変換中…"),
      );
      pre.hidden = true;
      const source = action("コード", "code", () => {
        showSource = !showSource;
        pre.hidden = !showSource;
        preview.hidden = showSource;
        source.setAttribute("aria-pressed", String(showSource));
      });
      header.append(source);
      const expand = action("拡大", "expand", async () => {
        const svg = await diagramSVG(
          text,
          document.documentElement.dataset.theme ?? "dark",
        );
        const view = displayFrame(n, svg, "diagram-expanded");
        ctx.modal("Mermaid", view, () => saveSVG(svg), "SVGを保存");
      });
      header.append(expand);
      const observer = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          observer.disconnect();
          diagramSVG(text, document.documentElement.dataset.theme ?? "dark")
            .then((svg) => {
              if (!block.isConnected) return;
              const frame = displayFrame(n, svg, "diagram-frame");
              const box = /\bviewBox=["']([^"']+)["']/
                .exec(svg)?.[1]
                .split(/[ ,]+/)
                .map(Number);
              if (box?.length === 4 && box[2] > 0)
                frame.style.height =
                  Math.min(
                    430,
                    Math.max(
                      100,
                      (Math.min(650, block.clientWidth) * box[3]) / box[2] + 20,
                    ),
                  ) + "px";
              preview.replaceChildren(frame);
            })
            .catch((e) => {
              error.textContent = "図に変換できない: " + e.message;
              error.hidden = false;
              pre.hidden = false;
              preview.hidden = true;
            });
        },
        { rootMargin: "200px" },
      );
      observer.observe(block);
      block.append(header, preview, pre, error);
    } else {
      const wrap = action("折り返し", "wrap", () => {
        pre.classList.toggle("code-wrap");
        wrap.setAttribute(
          "aria-pressed",
          String(pre.classList.contains("code-wrap")),
        );
      });
      header.append(wrap);
      if (language === "json")
        for (const [label, space] of [
          ["整形", 2],
          ["圧縮", 0],
        ])
          header.append(
            action(label, "code", () => {
              try {
                text = JSON.stringify(JSON.parse(text), null, space);
                error.hidden = true;
                paint();
              } catch {
                error.textContent = "JSONの構文を確認して";
                error.hidden = false;
              }
            }),
          );
      block.append(header, pre, error);
    }
    async function paint() {
      code.textContent = text;
      if (!language || diagram) return;
      try {
        highlighter ??= import("/vendor/highlight.js");
        const result = (await highlighter).highlight(text, language);
        if (result !== null) code.innerHTML = result;
      } catch {
        /* Plain code remains available if optional highlighting fails. */
      }
    }
    paint();
    return block;
  }
  function saveSVG(svg) {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })),
      link = n("a", { href: url, download: "diagram.svg" });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return { codeBlock };
}
