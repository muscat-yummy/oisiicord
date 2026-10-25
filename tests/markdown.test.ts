import { test, expect } from "bun:test";
import {
  markdownInline as inline,
  markdownBlocks as blocks,
} from "../public/markdown.js";

test("Discord headings require a space at the beginning of the line, with three levels", () => {
  expect(
    blocks("# こんにちは\n## 二番目\n### 三番目\n-# 補足").map((b) => b.type),
  ).toEqual(["heading", "heading", "heading", "subtext"]);
  for (const text of [
    "#こんにちは",
    "#### heading",
    " # heading",
    "text # heading",
    "\\# heading",
    "-#small",
  ])
    expect(blocks(text)[0].type).toBe("paragraph");
  expect(blocks("# heading\r\ntext")[1].text).toBe("text");
});
test("emphasis composes with underline, nesting, escapes and literal inline code", () => {
  expect(
    inline(
      "**bold** *italic* _italic_ __underline__ ~~strike~~ ***both*** ||secret||",
    )
      .filter((t) => t.type !== "text")
      .map((t) => t.type),
  ).toEqual([
    "bold",
    "italic",
    "italic",
    "underline",
    "strike",
    "boldItalic",
    "spoiler",
  ]);
  expect(inline("__***all***__")[0].children[0].type).toBe("boldItalic");
  expect(inline("**bold *italic***")[0].children[1].type).toBe("italic");
  expect(inline("**a `**` b**")[0].children[1]).toMatchObject({
    type: "code",
    text: "**",
  });
  expect(inline("snake_case_name")).toEqual([
    { type: "text", text: "snake_case_name" },
  ]);
  expect(
    inline("\\*literal\\*")
      .map((t) => t.text)
      .join(""),
  ).toBe("*literal*");
  expect(inline("`# **literal** @everyone`")[0]).toMatchObject({
    type: "code",
    text: "# **literal** @everyone",
  });
  expect(
    inline("**unfinished")
      .map((t) => t.text)
      .join(""),
  ).toBe("**unfinished");
});
test("lists, two-space nesting, ordered starts, quotes and fenced code remain distinct", () => {
  const list = blocks("- first\n  * nested\n- second\n3. third\n4. fourth");
  expect(list[0].items.length).toBe(2);
  expect(list[0].items[0][1].type).toBe("list");
  expect(list[1]).toMatchObject({ type: "list", ordered: true, start: 3 });
  expect(blocks("> one\n> two\noutside").map((b) => b.type)).toEqual([
    "quote",
    "paragraph",
  ]);
  const quoted = blocks(">>> all\n```js\n# literal\n```\nlast")[0];
  expect(quoted.children[1]).toMatchObject({
    type: "code",
    language: "js",
    text: "# literal",
  });
  expect(blocks("```mermaid\nflowchart LR\n A-->B")[0]).toMatchObject({
    type: "code",
    language: "mermaid",
  });
  expect(blocks("one\n\nthree")[0].text).toBe("one\n\nthree");
});
test("masked links preserve URL parentheses and application tokens stay opaque", () => {
  expect(inline("[docs](https://example.com/a_(b))")[0]).toMatchObject({
    type: "link",
    text: "docs",
    url: "https://example.com/a_(b)",
  });
  for (const value of [
    "[bad](javascript:alert(1))",
    "[bad](data:text/html,test)",
    "![image](https://example.com)",
  ])
    expect(inline(value).some((t) => t.type === "link")).toBe(false);
  for (const value of [
    "<button:https://example.com|__label__>",
    "<:custom_emoji:>",
    "<@role_id>",
    "https://example.com/a_b",
  ])
    expect(inline(value)).toEqual([{ type: "text", text: value }]);
  expect(inline("<img src=x onerror=alert(1)>")[0].type).toBe("text");
});

test("italic can contain bold and underline", () => {
  expect(inline("*italic **bold***")[0].children[1].type).toBe("bold");
  expect(inline("_italic __underline___")[0].children[1].type).toBe(
    "underline",
  );
});

test("same-line triple backticks stay inline rather than consuming following text", () => {
  const parsed = blocks("```literal```\nnormal");
  expect(parsed[0].type).toBe("paragraph");
  expect(inline(parsed[0].text)[0]).toMatchObject({
    type: "code",
    text: "literal",
  });
});
