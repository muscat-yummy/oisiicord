export function messageBlocks(value) {
  const text = String(value),
    blocks = [];
  const opening = /^ {0,3}(`{3,}|~{3,})([^\n]*)\n/gm;
  let cursor = 0,
    match;
  while ((match = opening.exec(text))) {
    const begin = match.index,
      bodyStart = opening.lastIndex,
      character = match[1][0],
      length = match[1].length;
    const closing = new RegExp(
      "^ {0,3}" + character + "{" + length + ",}[ \\t]*(?:\\n|$)",
      "gm",
    );
    closing.lastIndex = bodyStart;
    const end = closing.exec(text),
      finish = end ? closing.lastIndex : text.length;
    if (begin > cursor)
      blocks.push({
        type: "text",
        text: text.slice(cursor, begin),
        start: cursor,
        end: begin,
      });
    blocks.push({
      type: "code",
      language: match[2].trim().split(/\s/)[0].toLowerCase(),
      text: text.slice(bodyStart, end?.index ?? text.length).replace(/\n$/, ""),
      start: begin,
      end: finish,
    });
    cursor = finish;
    opening.lastIndex = finish;
    if (!end) break;
  }
  if (cursor < text.length || !blocks.length)
    blocks.push({
      type: "text",
      text: text.slice(cursor),
      start: cursor,
      end: text.length,
    });
  return blocks;
}
export function inlineCode(value) {
  const text = String(value),
    segments = [];
  let cursor = 0;
  for (const m of text.matchAll(/(`+)([^\n]*?)\1/g)) {
    if (m.index > cursor)
      segments.push({
        type: "text",
        text: text.slice(cursor, m.index),
        start: cursor,
        end: m.index,
      });
    segments.push({
      type: "code",
      text: m[2],
      start: m.index,
      end: m.index + m[0].length,
    });
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length || !segments.length)
    segments.push({
      type: "text",
      text: text.slice(cursor),
      start: cursor,
      end: text.length,
    });
  return segments;
}
export function codeRanges(text) {
  return messageBlocks(text).flatMap((b) =>
    b.type === "code"
      ? [[b.start, b.end]]
      : inlineCode(b.text)
          .filter((s) => s.type === "code")
          .map((s) => [b.start + s.start, b.start + s.end]),
  );
}
export function validateMermaid(source) {
  if (source.length > 8000) throw Error("図は8000文字まで");
  if (/%%\s*\{|^\s*---(?:\s|$)/m.test(source))
    throw Error("図内の設定変更には対応していない");
  return source;
}
