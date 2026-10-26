import { test, expect } from "bun:test";
import {
  FileTransfers,
  STANDARD_FILE_SIZE,
  PLUS_FILE_SIZE,
} from "../src/file-transfers";
import {
  searchPredicate,
  exportSearchResults,
} from "../public/search-model.js";
import { uploadAttachment } from "../public/attachments.js";
test("standard and Plus boundaries fail before reading plaintext, transfer slots reject replays and outsiders", async () => {
  await expect(
    uploadAttachment({ size: STANDARD_FILE_SIZE + 1 }),
  ).rejects.toThrow("1024 MiB");
  await expect(
    uploadAttachment({ size: PLUS_FILE_SIZE + 1 }, { maximum: PLUS_FILE_SIZE }),
  ).rejects.toThrow("2048 MiB");
  let now = 0;
  const transfers = new FileTransfers(() => now);
  expect(() =>
    transfers.create("free", STANDARD_FILE_SIZE + 1, STANDARD_FILE_SIZE),
  ).toThrow();
  const job = transfers.create("plus", PLUS_FILE_SIZE, PLUS_FILE_SIZE);
  expect(() =>
    transfers.reserve("outsider", job.id, 0, 16 * 1024 * 1024 + 16),
  ).toThrow();
  expect(() => transfers.reserve("plus", job.id, 0, 1)).toThrow();
  const finish = transfers.reserve("plus", job.id, 0, 16 * 1024 * 1024 + 16);
  expect(() =>
    transfers.reserve("plus", job.id, 0, 16 * 1024 * 1024 + 16),
  ).toThrow();
  finish(false);
  const retry = transfers.reserve("plus", job.id, 0, 16 * 1024 * 1024 + 16);
  retry(true);
  retry(true);
  expect(() =>
    transfers.reserve("plus", job.id, 0, 16 * 1024 * 1024 + 16),
  ).toThrow();
  const next = transfers.reserve(
    "plus",
    job.id,
    16 * 1024 * 1024,
    16 * 1024 * 1024 + 16,
  );
  next(false);
  now = 3600001;
  transfers.prune();
  expect(() =>
    transfers.reserve("plus", job.id, 16 * 1024 * 1024, 16 * 1024 * 1024 + 16),
  ).toThrow();
});
test("cross-conversation search combines phrases, exact-case regex, authors, dates and file names", () => {
  const message = {
    id: "m",
    room: "r",
    parent: "Server",
    channel: "code",
    author: "a",
    authorName: "Alice",
    username: "alice",
    created: 1000,
    text: "```ts\nconst issue = 'Alpha Beta';\n```",
    files: [
      {
        name: "report.JSON",
        size: 12,
        mime: "application/json",
        key: "never-export",
        removePassword: "never-export",
      },
    ],
  };
  expect(searchPredicate({ query: '"alpha beta" issue' })(message)).toBe(true);
  expect(
    searchPredicate({
      query: "report.json",
      kind: "file",
      author: "ali",
      after: 1000,
      before: 1001,
    })(message),
  ).toBe(true);
  expect(
    searchPredicate({ query: "report.json", kind: "file", before: 1000 })(
      message,
    ),
  ).toBe(false);
  expect(
    searchPredicate({
      query: "const\\s+issue",
      regex: true,
      caseSensitive: true,
      kind: "code",
    })(message),
  ).toBe(true);
  expect(
    searchPredicate({ query: "CONST", regex: true, caseSensitive: true })(
      message,
    ),
  ).toBe(false);
  expect(searchPredicate({ query: "", kind: "diagram" })(message)).toBe(false);
  expect(() => searchPredicate({ query: "[", regex: true })).toThrow(
    "正規表現",
  );
  const json = exportSearchResults([message]);
  expect(json).not.toContain("never-export");
  expect(JSON.parse(json).messages[0].text).toBe(message.text);
  const md = exportSearchResults(
    [{ ...message, text: "~~~\n**code**\n~~~" }],
    "markdown",
  );
  expect(md).toContain("~~~~text\n~~~\n**code**\n~~~\n~~~~");
});
