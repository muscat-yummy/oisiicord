export function searchPredicate(options) {
  const query = String(options.query ?? "").trim();
  if (query.length > 500) throw Error("検索語は500文字までです");
  let expression;
  if (options.regex && query) {
    try {
      expression = new RegExp(query, options.caseSensitive ? "u" : "iu");
    } catch {
      throw Error("正規表現が不正です");
    }
  }
  const fold = (s) => (options.caseSensitive ? s : s.toLocaleLowerCase());
  const words = [...query.matchAll(/"([^"]+)"|(\S+)/g)].map((m) =>
    fold(m[1] ?? m[2]),
  );
  const author = String(options.author ?? "")
    .trim()
    .toLocaleLowerCase();
  return (message) => {
    if (
      (options.after && message.created < options.after) ||
      (options.before && message.created >= options.before)
    )
      return false;
    if (
      author &&
      ![message.author, message.authorName, message.username].some((v) =>
        String(v ?? "")
          .toLocaleLowerCase()
          .includes(author),
      )
    )
      return false;
    const text = String(message.text ?? "");
    const files = Array.isArray(message.files) ? message.files : [];
    if (options.kind === "file" && !files.length) return false;
    if (options.kind === "code" && !/```/.test(text)) return false;
    if (options.kind === "diagram" && !/```mermaid(?:\s|$)/i.test(text))
      return false;
    if (options.kind === "link" && !/https?:\/\//i.test(text)) return false;
    const haystack =
      text + "\n" + files.map((f) => String(f.name ?? "")).join("\n");
    if (!query) return true;
    return expression
      ? expression.test(haystack)
      : words.every((word) => fold(haystack).includes(word));
  };
}
export function exportSearchResults(results, format = "json") {
  const records = results.map(
    ({
      id,
      room,
      parent,
      channel,
      author,
      authorName,
      created,
      text,
      files,
    }) => ({
      id,
      room,
      server: parent,
      channel,
      author,
      authorName,
      created: new Date(created).toISOString(),
      text,
      files: files.map(({ name, size, mime }) => ({ name, size, mime })),
    }),
  );
  if (format === "json")
    return JSON.stringify({ version: 1, messages: records }, null, 2) + "\n";
  // Keep the exact text inside a fence that cannot be closed by message content.
  return (
    records
      .map((m) => {
        const fence = "~".repeat(
          Math.max(
            3,
            ...[...m.text.matchAll(/~+/g)].map((v) => v[0].length + 1),
          ),
        );
        return (
          `## ${m.server.replace(/[\r\n]/g, " ")} / ${m.channel.replace(/[\r\n]/g, " ")}\n\n${m.authorName.replace(/[\r\n]/g, " ")} · ${m.created}\n\n${fence}text\n${m.text}\n${fence}\n` +
          m.files
            .map(
              (f) =>
                "\n- " +
                String(f.name).replace(/[\r\n]/g, " ") +
                " (" +
                f.size +
                " bytes)",
            )
            .join("")
        );
      })
      .join("\n") + "\n"
  );
}
