const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const pictograph = String.raw`\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?`;
const emoji = new RegExp(
  String.raw`^(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|${pictograph}(?:\u200D${pictograph})*(?:[\u{E0020}-\u{E007E}]+\u{E007F})?)$`,
  "u",
);
export function emojiOnlyCount(value, custom = []) {
  const source = String(value).trim();
  if (!source) return 0;
  let count = 0;
  const rest = source.replace(
    /<:([\w-]{1,100}):>|:([A-Za-z0-9_]{2,32}):/g,
    (token, id, name) => {
      if (
        !custom.some((e) =>
          id ? e.id === id : e.name.toLowerCase() === name.toLowerCase(),
        )
      )
        return token;
      count++;
      return " ";
    },
  );
  for (const { segment } of graphemes.segment(rest)) {
    if (/^\s+$/u.test(segment)) continue;
    if (!emoji.test(segment) || ++count > 3) return 0;
  }
  return count >= 1 && count <= 3 ? count : 0;
}
