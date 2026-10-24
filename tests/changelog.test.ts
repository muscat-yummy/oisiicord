import { test, expect } from "bun:test";
import { parseChangelog } from "../public/changelog.js";
test("host-written changelog renders ordered entries, paragraphs and bullets", () => {
  expect(
    parseChangelog(
      "\uFEFF## 2026-10-25 タイトル\r\n\r\n本文\r\n続き\r\n\r\n- 変更1\r\n* 変更2\r\n\r\n## 日付なし\n次の本文",
    ),
  ).toEqual([
    {
      title: "タイトル",
      date: "2026-10-25",
      blocks: [
        { type: "paragraph", text: "本文\n続き" },
        { type: "bullet", text: "変更1" },
        { type: "bullet", text: "変更2" },
      ],
    },
    {
      title: "日付なし",
      date: "",
      blocks: [{ type: "paragraph", text: "次の本文" }],
    },
  ]);
  expect(parseChangelog(" \n\n")).toEqual([]);
  expect(
    parseChangelog("<script>window.pwned=true</script>")[0].blocks[0].text,
  ).toBe("<script>window.pwned=true</script>");
});
