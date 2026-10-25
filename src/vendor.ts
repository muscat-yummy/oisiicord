import { readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
type HeadersLike = ConstructorParameters<typeof Headers>[0];
export function createVendor(
  root: string,
  common: HeadersLike = {},
  publicOrigin?: string,
) {
  const distribution = resolve(root, "node_modules/mermaid/dist"),
    assets = new Map<string, string>();
  assets.set(
    "/vendor/mermaid/mermaid.esm.min.mjs",
    join(distribution, "mermaid.esm.min.mjs"),
  );
  const chunkFolder = join(distribution, "chunks/mermaid.esm.min");
  if (existsSync(chunkFolder))
    for (const file of readdirSync(chunkFolder, { withFileTypes: true }))
      if (file.isFile() && file.name.endsWith(".mjs"))
        assets.set(
          "/vendor/mermaid/chunks/mermaid.esm.min/" + file.name,
          join(chunkFolder, file.name),
        );
  let highlighter: Promise<Blob> | null = null;
  return async (req: Request, url: URL): Promise<Response | undefined> => {
    const path = url.pathname,
      isFrame = ["/mermaid-frame.html", "/diagram-view.html"].includes(path),
      frameScript = ["/mermaid-frame.js", "/diagram-view.js"].includes(path),
      highlight = path === "/vendor/highlight.js";
    if (!isFrame && !frameScript && !highlight && !assets.has(path)) return;
    const headers = new Headers(common);
    headers.set("Cache-Control", "no-cache");
    if (!["GET", "HEAD"].includes(req.method))
      return new Response(null, {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    let file: Blob;
    if (highlight) {
      highlighter ??= Bun.build({
        entrypoints: [join(root, "src/highlight-client.js")],
        target: "browser",
        minify: true,
      })
        .then((result) => {
          if (!result.success || !result.outputs[0])
            throw Error("Highlighter build failed");
          return result.outputs[0];
        })
        .catch((error) => {
          highlighter = null;
          throw error;
        });
      try {
        file = await highlighter;
      } catch {
        return new Response(null, { status: 503, headers });
      }
    } else
      file = Bun.file(
        isFrame || frameScript
          ? join(root, "public", path.slice(1))
          : assets.get(path)!,
      );
    if (
      "exists" in file &&
      !(await (file as ReturnType<typeof Bun.file>).exists())
    )
      return new Response(null, { status: 404, headers });
    headers.set(
      "Content-Type",
      isFrame ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8",
    );
    if (isFrame)
      headers.set(
        "Content-Security-Policy",
        `default-src 'none'; script-src ${new URL(publicOrigin ?? url.origin).origin}; style-src 'unsafe-inline'; img-src data: blob:; font-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
      );
    else headers.set("Access-Control-Allow-Origin", "*");
    if (path.includes("/chunks/"))
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
    return new Response(req.method === "HEAD" ? null : file, { headers });
  };
}
