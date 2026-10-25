import mermaid from "/vendor/mermaid/mermaid.esm.min.mjs";
window.addEventListener("message", async (event) => {
  if (
    event.source !== parent ||
    event.data?.type !== "render-mermaid" ||
    typeof event.data.source !== "string" ||
    event.data.source.length > 8000
  )
    return;
  const { id, source, theme } = event.data;
  try {
    if (/%%\s*\{|^\s*---(?:\s|$)/m.test(source))
      throw Error("図内の設定変更には対応していない");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: theme === "light" ? "default" : "dark",
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      maxTextSize: 8000,
      maxEdges: 150,
      suppressErrorRendering: true,
      secure: [
        "secure",
        "securityLevel",
        "startOnLoad",
        "maxTextSize",
        "maxEdges",
        "htmlLabels",
        "flowchart",
      ],
    });
    const result = await mermaid.render("diagram-" + id, source);
    parent.postMessage({ type: "mermaid-rendered", id, svg: result.svg }, "*");
  } catch (error) {
    parent.postMessage(
      {
        type: "mermaid-error",
        id,
        error: String(error.message ?? error).slice(0, 800),
      },
      "*",
    );
  }
});
parent.postMessage({ type: "mermaid-ready" }, "*");
