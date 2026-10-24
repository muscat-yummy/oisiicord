import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type HeaderValues = ConstructorParameters<typeof Headers>[0];
const rootDirectory = fileURLToPath(new URL("..", import.meta.url));
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function createBranding(
  root = rootDirectory,
  commonHeaders: HeaderValues = {},
) {
  function regularAsset(name: string, maximum: number) {
    const directory = join(root, "settings"),
      path = join(directory, name);
    try {
      const folder = lstatSync(directory),
        file = lstatSync(path);
      if (
        folder.isSymbolicLink() ||
        !folder.isDirectory() ||
        file.isSymbolicLink() ||
        !file.isFile() ||
        file.size < 1 ||
        file.size > maximum
      )
        return null;
      return { path, size: file.size };
    } catch {
      return null;
    }
  }
  function customIcon() {
    const asset = regularAsset("icon.png", 10 * 1024 * 1024);
    if (!asset) return null;
    try {
      const data = readFileSync(asset.path);
      if (
        data.length < 33 ||
        !data.subarray(0, 8).equals(pngSignature) ||
        data.readUInt32BE(8) !== 13 ||
        data.toString("ascii", 12, 16) !== "IHDR"
      )
        return null;
      const width = data.readUInt32BE(16),
        height = data.readUInt32BE(20);
      if (!width || !height || width > 8192 || height > 8192) return null;
      return data;
    } catch {
      return null;
    }
  }
  function headers(extra: HeaderValues = {}) {
    const result = new Headers(commonHeaders);
    result.set("Cache-Control", "no-cache");
    result.set("X-Content-Type-Options", "nosniff");
    for (const [name, value] of new Headers(extra)) result.set(name, value);
    return result;
  }
  const missing = () => new Response(null, { status: 404, headers: headers() });
  return async function handle(
    req: Request,
    url: URL,
  ): Promise<Response | undefined> {
    const route = url.pathname;
    if (
      ![
        "/app-icon",
        "/settings/icon.png",
        "/settings/dm.mp3",
        "/api/branding",
        "/api/changelog",
        "/manifest.webmanifest",
      ].includes(route)
    )
      return undefined;
    if (!["GET", "HEAD"].includes(req.method))
      return new Response(null, {
        status: 405,
        headers: headers({ Allow: "GET, HEAD" }),
      });
    const head = req.method === "HEAD";
    if (route === "/api/changelog") {
      const asset = regularAsset("changelog.md", 128 * 1024);
      let content = "";
      if (asset) {
        try {
          content = new TextDecoder("utf-8", { fatal: true }).decode(
            readFileSync(asset.path),
          );
        } catch {
          /* An unreadable local file does not break the home screen. */
        }
      }
      return new Response(head ? null : JSON.stringify({ content }), {
        headers: headers({ "Content-Type": "application/json; charset=utf-8" }),
      });
    }
    if (route === "/api/branding") {
      return new Response(
        head
          ? null
          : JSON.stringify({
              icon: !!customIcon(),
              dmSound: !!regularAsset("dm.mp3", 20 * 1024 * 1024),
            }),
        {
          headers: headers({
            "Content-Type": "application/json; charset=utf-8",
          }),
        },
      );
    }
    if (route === "/app-icon" || route === "/settings/icon.png") {
      const icon = customIcon();
      if (icon)
        return new Response(head ? null : icon, {
          headers: headers({
            "Content-Type": "image/png",
            "Content-Length": String(icon.length),
          }),
        });
      if (route === "/settings/icon.png") return missing();
      const file = Bun.file(join(root, "public", "icon.svg"));
      if (!(await file.exists())) return missing();
      return new Response(head ? null : file, {
        headers: headers({
          "Content-Type": "image/svg+xml",
          "Content-Length": String(file.size),
        }),
      });
    }
    if (route === "/manifest.webmanifest") {
      let manifest: Record<string, any>;
      try {
        manifest = JSON.parse(
          readFileSync(join(root, "public", "manifest.webmanifest"), "utf8"),
        );
      } catch {
        manifest = {
          name: "Oisiicord",
          short_name: "Oisiicord",
          start_url: "/",
          display: "standalone",
        };
      }
      manifest.icons = [
        {
          src: "/app-icon",
          sizes: "any",
          type: customIcon() ? "image/png" : "image/svg+xml",
          purpose: "any",
        },
      ];
      return new Response(head ? null : JSON.stringify(manifest), {
        headers: headers({
          "Content-Type": "application/manifest+json; charset=utf-8",
        }),
      });
    }
    const asset = regularAsset("dm.mp3", 20 * 1024 * 1024);
    if (!asset) return missing();
    const file = Bun.file(asset.path),
      range = req.headers.get("range");
    let start = 0,
      end = asset.size - 1,
      status = 200;
    if (range) {
      const match = range.match(/^bytes=(\d*)-(\d*)$/);
      if (!match || (!match[1] && !match[2]))
        return new Response(null, {
          status: 416,
          headers: headers({ "Content-Range": `bytes */${asset.size}` }),
        });
      if (match[1]) {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : end;
      } else {
        const suffix = Number(match[2]);
        if (!Number.isSafeInteger(suffix) || suffix < 1)
          return new Response(null, {
            status: 416,
            headers: headers({ "Content-Range": `bytes */${asset.size}` }),
          });
        start = Math.max(0, asset.size - suffix);
      }
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end < start ||
        start >= asset.size
      )
        return new Response(null, {
          status: 416,
          headers: headers({ "Content-Range": `bytes */${asset.size}` }),
        });
      end = Math.min(end, asset.size - 1);
      status = 206;
    }
    return new Response(head ? null : file.slice(start, end + 1), {
      status,
      headers: headers({
        "Content-Type": "audio/mpeg",
        "Accept-Ranges": "bytes",
        "Content-Length": String(end - start + 1),
        ...(status === 206
          ? { "Content-Range": `bytes ${start}-${end}/${asset.size}` }
          : {}),
      }),
    });
  };
}
