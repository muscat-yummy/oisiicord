import { test, expect } from "bun:test";
import {
  messageBlocks,
  inlineCode,
  transformText,
  validateMermaid,
} from "../public/developer-format.js";
import { previewKind, validateMedia } from "../public/media-preview.js";
import { mentions } from "../public/mentions.js";
test("fenced code and inline code stay literal and do not create mentions", () => {
  const source =
    'text\n```js\nconst x = "@everyone <button:https://example.com>";\n```\n`<@alice>` @everyone';
  const blocks = messageBlocks(source);
  expect(blocks.map((b) => b.type)).toEqual(["text", "code", "text"]);
  expect(blocks[1].language).toBe("js");
  expect(blocks[1].text).toContain("<button:");
  expect(mentions(source).map((m) => m.kind)).toEqual(["everyone"]);
  expect(inlineCode("a `x` b")[1].text).toBe("x");
  expect(messageBlocks("```mermaid\nflowchart LR\n A-->B")[0].language).toBe(
    "mermaid",
  );
  expect(() =>
    validateMermaid('%%{init: {"securityLevel":"loose"}}%%\nflowchart LR'),
  ).toThrow();
  expect(() => validateMermaid("---\nconfig:\n---\nflowchart LR")).toThrow();
});
test("developer transformations handle UTF-8, JSON, URL escapes and SHA-256", async () => {
  const encoded = await transformText("日本語", "base64-encode");
  expect(await transformText(encoded, "base64-decode")).toBe("日本語");
  expect(await transformText('{"x":1}', "json")).toBe('{\n  "x": 1\n}');
  expect(await transformText("a b", "url-encode")).toBe("a%20b");
  expect(await transformText("a%20b", "url-decode")).toBe("a b");
  expect(await transformText("abc", "sha256")).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  await expect(transformText("broken", "json")).rejects.toThrow();
});
test("media preview requires a supported signature and bounded image dimensions", () => {
  expect(previewKind({ mime: "image/svg+xml" })).toBeNull();
  expect(previewKind({ mime: "image/png" })).toBe("image");
  expect(previewKind({ mime: "video/webm" })).toBe("video");
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6do8AAAAASUVORK5CYII=",
    "base64",
  );
  expect(() => validateMedia(image, "image/png")).not.toThrow();
  image.writeUInt32BE(100000, 16);
  expect(() => validateMedia(image, "image/png")).toThrow();
  expect(() =>
    validateMedia(
      new TextEncoder().encode('<svg onload="bad()">'),
      "image/png",
    ),
  ).toThrow();
});
