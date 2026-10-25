import { test, expect } from "bun:test";
import { emojiOnlyCount } from "../public/emoji-format.js";
test("one to three grapheme emoji enlarge; prose, code and larger groups do not", () => {
  for (const [text, count] of [
    ["😀", 1],
    ["👍🏽 ❤️ 🇯🇵", 3],
    ["👨‍👩‍👧‍👦", 1],
    ["1️⃣#️⃣*️⃣", 3],
    [" 🐼\n🐻‍❄️ ", 2],
    ["🏴󠁧󠁢󠁥󠁮󠁧󠁿", 1],
  ] as const)
    expect(emojiOnlyCount(text)).toBe(count);
  for (const text of [
    "",
    " ",
    "😀😀😀😀",
    "hello 😀",
    "1",
    "#",
    "*",
    "`😀`",
    "<button:https://example.com>",
    ":unknown:",
    "<:unknown:>",
    "\u200d",
    "🇯",
  ])
    expect(emojiOnlyCount(text)).toBe(0);
  const custom = [{ id: "panda", name: "panda" }];
  expect(emojiOnlyCount("<:panda:> :Panda: 👍", custom)).toBe(3);
  expect(
    emojiOnlyCount("<:panda:> <:panda:> <:panda:> <:panda:>", custom),
  ).toBe(0);
});
