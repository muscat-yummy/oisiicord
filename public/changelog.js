// Only headings, paragraphs and bullet lists are supported. Content stays text.
export function parseChangelog(source) {
  const entries = [];
  let current = null,
    paragraph = [];
  function entry() {
    return (current ??= { title: "", date: "", blocks: [] });
  }
  function flush() {
    if (paragraph.length) {
      entry().blocks.push({ type: "paragraph", text: paragraph.join("\n") });
      paragraph = [];
    }
  }
  function finish() {
    flush();
    if (current && (current.title || current.blocks.length))
      entries.push(current);
    current = null;
  }
  for (const line of String(source)
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)) {
    const heading = /^#{1,3}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      finish();
      const dated = /^(\d{4}-\d{2}-\d{2})(?:\s+(.+))?$/.exec(heading[1]);
      current = {
        title: dated?.[2] ?? (dated ? "" : heading[1]),
        date: dated?.[1] ?? "",
        blocks: [],
      };
    } else {
      const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
      if (bullet) {
        flush();
        entry().blocks.push({ type: "bullet", text: bullet[1] });
      } else if (!line.trim()) flush();
      else paragraph.push(line);
    }
  }
  finish();
  return entries;
}
