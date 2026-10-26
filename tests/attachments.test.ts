import { test, expect } from "bun:test";
import {
  uploadAttachment,
  attachmentParts,
  verifiedPart,
  removeAttachment,
  MAX_FILE_SIZE,
  CHUNK_SIZE,
} from "../public/attachments.js";
test("2GiB boundary uploads 128 independently encrypted bounded parts sequentially", async () => {
  let count = 0,
    active = 0,
    max = 0,
    progress = 0;
  const source = new Blob([new Uint8Array(CHUNK_SIZE)]);
  // Virtual input: actual encryption of all 128 parts, no 2GiB plaintext allocation.
  const file = {
    name: "boundary.bin",
    type: "application/octet-stream",
    size: MAX_FILE_SIZE,
    slice(start: number, end: number) {
      expect(end - start).toBe(CHUNK_SIZE);
      expect(start).toBe(count * CHUNK_SIZE);
      return source;
    },
  };
  const result = await uploadAttachment(file, {
    maximum: MAX_FILE_SIZE,
    request: async (_path: string, options: any) => {
      if (_path === "/api/file-transfers")
        return Response.json({ id: "boundary_transfer", size: file.size });
      if (options.method === "DELETE") return Response.json({ ok: true });
      active++;
      max = Math.max(max, active);
      count++;
      expect(options.body.byteLength).toBe(CHUNK_SIZE + 16);
      active--;
      return Response.json({ id: "part_" + count, removePassword: "secret" });
    },
    progress(bytes: number) {
      progress = bytes;
    },
  });
  expect(count).toBe(128);
  expect(max).toBe(1);
  expect(progress).toBe(MAX_FILE_SIZE);
  expect(attachmentParts(result)).toHaveLength(128);
  const swapped = structuredClone(result);
  if (!swapped.chunks) throw Error("missing chunks");
  [swapped.chunks[0], swapped.chunks[1]] = [
    swapped.chunks[1],
    swapped.chunks[0],
  ];
  expect(() => attachmentParts(swapped)).toThrow();
  expect(() =>
    attachmentParts({ ...result, size: MAX_FILE_SIZE + 1 }),
  ).toThrow();
  await expect(
    uploadAttachment(
      { ...file, size: MAX_FILE_SIZE + 1 },
      { maximum: MAX_FILE_SIZE },
    ),
  ).rejects.toThrow("2048 MiB");
  let deleted = 0;
  await removeAttachment(result, async () => {
    deleted++;
    return Response.json({ ok: true });
  });
  expect(deleted).toBe(128);
}, 60000);
test("failed upload removes completed parts, small attachments stay compatible and tampering fails", async () => {
  const original = new File(["verified attachment"], "hello.txt", {
    type: "text/plain",
  });
  let encrypted: any;
  const descriptor = await uploadAttachment(original, {
    request: async (_path: string, options: any) => {
      encrypted = options.body;
      return Response.json({ id: "single", removePassword: "secret" });
    },
  });
  expect(descriptor.v).toBeUndefined();
  expect(
    new TextDecoder().decode(
      await verifiedPart(descriptor, async () => new Response(encrypted)),
    ),
  ).toBe("verified attachment");
  const bad = encrypted.slice(0);
  new Uint8Array(bad)[0] ^= 1;
  await expect(
    verifiedPart(descriptor, async () => new Response(bad)),
  ).rejects.toThrow("ハッシュ");
  await expect(
    verifiedPart(descriptor, async () => new Response(encrypted.slice(1))),
  ).rejects.toThrow("サイズ");
  let posts = 0,
    deletes = 0;
  const large = {
    name: "failure.bin",
    type: "",
    size: 32 * 1024 * 1024,
    slice() {
      return new Blob([new Uint8Array(CHUNK_SIZE)]);
    },
  };
  await expect(
    uploadAttachment(large, {
      request: async (_path: string, options: any) => {
        if (_path === "/api/file-transfers")
          return Response.json({ id: "failure_transfer", size: large.size });
        if (_path.startsWith("/api/file-transfers/"))
          return Response.json({ ok: true });
        if (options.method === "DELETE") {
          deletes++;
          return Response.json({ ok: true });
        }
        if (++posts === 2) return new Response(null, { status: 503 });
        return Response.json({ id: "cleanup", removePassword: "secret" });
      },
    }),
  ).rejects.toThrow("送信");
  expect(posts).toBe(2);
  expect(deletes).toBe(1);
});
