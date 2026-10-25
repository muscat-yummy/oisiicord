import { test, expect } from "bun:test";
import {
  messageBlocks,
  inlineCode,
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

test("audio previews normalize MIME aliases and require matching container signatures", () => {
  for (const mime of [
    "audio/mpeg",
    "audio/wav",
    "audio/ogg",
    "audio/mp4",
    "audio/webm",
    "audio/flac",
    "audio/aac",
    "audio/x-m4a",
    "audio/mp3",
  ])
    expect(previewKind({ mime })).toBe("audio");
  expect(previewKind({ name: "song.mp3", mime: "" })).toBe("audio");
  expect(previewKind({ name: "song.mp3", mime: "text/html" })).toBeNull();
  const fixtures = [
    ["audio/mpeg", [255, 251, 144, 0]],
    ["audio/mpeg", [73, 68, 51, 4, 0, 0, 0, 0, 0, 0]],
    ["audio/wav", [...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WAVE")]],
    ["audio/ogg", [...Buffer.from("OggS"), ...new Array(23).fill(0)]],
    ["audio/mp4", [0, 0, 0, 12, ...Buffer.from("ftypM4A ")]],
    ["audio/webm", [26, 69, 223, 163]],
    ["audio/flac", [...Buffer.from("fLaC"), 128, 0, 0, 34]],
    ["audio/aac", [255, 241, 80, 128, 0, 255, 252]],
  ] as const;
  for (const [mime, bytes] of fixtures) {
    expect(() => validateMedia(new Uint8Array(bytes), mime)).not.toThrow();
    expect(() =>
      validateMedia(new TextEncoder().encode("<html>not audio</html>"), mime),
    ).toThrow();
  }
});
