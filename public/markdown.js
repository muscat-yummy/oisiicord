// User input becomes tokens, never HTML. Bound recursion for untrusted messages.
/** @returns {any[]} */
export function markdownInline(value, depth = 0) {
  const text = String(value),
    out = [];
  if (depth >= 16) return [{ type: "literal", text }];
  let pending = "";
  const flush = () => {
    if (pending) out.push({ type: "text", text: pending });
    pending = "";
  };
  for (let i = 0; i < text.length;) {
    const rest = text.slice(i),
      escape = /^\\([\\`*_{}\[\]()#+\-.!>|~])/.exec(rest);
    if (escape) {
      flush();
      out.push({ type: "literal", text: escape[1] });
      i += escape[0].length;
      continue;
    }
    const code = /^(`+)([^\n]*?)\1(?!`)/.exec(rest);
    if (code?.[2]) {
      flush();
      out.push({ type: "code", text: code[2] });
      i += code[0].length;
      continue;
    }
    const atom =
      /^(?:<button:[^<>]+>|<:[a-zA-Z0-9_-]{1,100}:>|<@!?[^<>\s]+>|https?:\/\/[^\s<>]+)/.exec(
        rest,
      );
    if (atom) {
      pending += atom[0];
      i += atom[0].length;
      continue;
    }
    const label =
      rest[0] === "[" && text[i - 1] !== "!"
        ? /^\[((?:\\.|[^\]\\\n])+)\]\(/.exec(rest)
        : null;
    if (label) {
      let end = i + label[0].length,
        balance = 1;
      for (; end < text.length && text[end] !== "\n"; end++) {
        if (text[end] === "\\") {
          end++;
          continue;
        }
        if (text[end] === "(") balance++;
        if (text[end] === ")" && --balance === 0) break;
      }
      if (!balance) {
        let url = text.slice(i + label[0].length, end);
        if (url.startsWith("<") && url.endsWith(">")) url = url.slice(1, -1);
        if (/^https?:\/\/[^\s<>]+$/i.test(url)) {
          flush();
          out.push({
            type: "link",
            url,
            text: label[1].replace(/\\([\\\[\]])/g, "$1"),
          });
          i = end + 1;
          continue;
        }
      }
    }
    const marker = /^(\*\*\*|\*\*|__|~~|\|\||\*|_)/.exec(rest)?.[0];
    if (
      marker &&
      !/\s/.test(text[i + marker.length] ?? " ") &&
      !(marker === "_" && /[\p{L}\p{N}]/u.test(text[i - 1] ?? ""))
    ) {
      let end = i + marker.length;
      while (end < text.length) {
        const opaque = /^(`+)([^\n]*?)\1(?!`)/.exec(text.slice(end));
        if (opaque?.[2]) {
          end += opaque[0].length;
          continue;
        }
        if (text[end] === "\\") {
          end += 2;
          continue;
        }
        if (
          (marker === "*" || marker === "_") &&
          text.startsWith(marker + marker, end) &&
          !/\s/.test(text[end + 2] ?? " ")
        ) {
          const nestedEnd = text.indexOf(marker + marker, end + 2);
          if (nestedEnd > end + 2) {
            end = nestedEnd + 2;
            continue;
          }
        }
        if (!text.startsWith(marker, end)) {
          end++;
          continue;
        }
        let escapes = 0;
        for (let p = end - 1; p >= 0 && text[p] === "\\"; p--) escapes++;
        if (escapes % 2 || /\s/.test(text[end - 1])) {
          end += marker.length;
          continue;
        }
        if (
          marker === "**" &&
          text[end + 2] === "*" &&
          text.slice(i + 2, end).includes("*")
        )
          end++;
        if (marker === "_" && /[\p{L}\p{N}]/u.test(text[end + 1] ?? "")) {
          end++;
          continue;
        }
        break;
      }
      if (end < text.length) {
        flush();
        out.push({
          type: {
            "***": "boldItalic",
            "**": "bold",
            __: "underline",
            "~~": "strike",
            "||": "spoiler",
            "*": "italic",
            _: "italic",
          }[marker],
          children: markdownInline(
            text.slice(i + marker.length, end),
            depth + 1,
          ),
        });
        i = end + marker.length;
        continue;
      }
    }
    pending += text[i++];
  }
  flush();
  return out;
}
/** @returns {any[]} */
function proseBlocks(text, depth = 0) {
  if (depth >= 16) return [{ type: "paragraph", text }];
  const lines = text.split("\n"),
    out = [];
  let paragraph = [];
  const flush = () => {
    if (paragraph.length)
      out.push({ type: "paragraph", text: paragraph.join("\n") });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i],
      heading = /^(#{1,3}) (.+)$/.exec(line),
      subtext = /^-# (.*)$/.exec(line);
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence && !fence[2].includes(fence[1][0])) {
      flush();
      const body = [],
        closing = new RegExp(
          "^ {0,3}" + fence[1][0] + "{" + fence[1].length + ",}[ \\t]*$",
        );
      while (i + 1 < lines.length && !closing.test(lines[i + 1]))
        body.push(lines[++i]);
      if (i + 1 < lines.length) i++;
      out.push({
        type: "code",
        language: fence[2].trim().split(/\s/)[0].toLowerCase(),
        text: body.join("\n"),
      });
      continue;
    }
    if (heading || subtext) {
      flush();
      out.push(
        heading
          ? { type: "heading", level: heading[1].length, text: heading[2] }
          : { type: "subtext", text: subtext[1] },
      );
      continue;
    }
    if (/^>>> /.test(line)) {
      flush();
      out.push({
        type: "quote",
        children: proseBlocks(
          [line.slice(4), ...lines.slice(i + 1)].join("\n"),
          depth + 1,
        ),
      });
      break;
    }
    if (/^> /.test(line)) {
      flush();
      const quoted = [line.slice(2)];
      while (i + 1 < lines.length && /^> /.test(lines[i + 1]))
        quoted.push(lines[++i].slice(2));
      out.push({
        type: "quote",
        children: proseBlocks(quoted.join("\n"), depth + 1),
      });
      continue;
    }
    const item = /^( *)([-*]|\d+\.) (.*)$/.exec(line);
    if (item) {
      flush();
      const ordered = /\d/.test(item[2]),
        list = {
          type: "list",
          ordered,
          start: ordered ? Math.min(Number.parseInt(item[2]), 2147483647) : 1,
          items: [],
        },
        indent = item[1].length;
      for (;;) {
        const current = /^( *)([-*]|\d+\.) (.*)$/.exec(lines[i]);
        if (
          !current ||
          current[1].length !== indent ||
          /\d/.test(current[2]) !== ordered
        ) {
          i--;
          break;
        }
        const body = [current[3]];
        while (
          i + 1 < lines.length &&
          lines[i + 1].startsWith(" ".repeat(indent + 2))
        )
          body.push(lines[++i].slice(indent + 2));
        list.items.push(proseBlocks(body.join("\n"), depth + 1));
        i++;
        if (i >= lines.length) {
          i--;
          break;
        }
      }
      out.push(list);
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return out;
}
/** @returns {any[]} */
export function markdownBlocks(value) {
  return proseBlocks(String(value).replace(/\r\n?/g, "\n"));
}
