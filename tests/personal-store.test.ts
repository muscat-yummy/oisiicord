import { test, expect } from "bun:test";
import * as C from "../public/crypto.js";
import {
  createPersonalStore,
  expandTemplate,
  buttonMarkup,
} from "../public/personal-store.js";
test("private notes, templates and drafts survive reload as authenticated ciphertext", async () => {
  const raw = new Map<string, string>(),
    storage = {
      getItem: (k: string) => raw.get(k) ?? null,
      setItem: (k: string, v: string) => {
        raw.set(k, v);
      },
    };
  const keys = await C.identity(),
    identity = {
      ...(await C.importIdentity(keys.privateKeys, keys.keys)),
      id: crypto.randomUUID(),
    },
    store = createPersonalStore(identity, storage);
  await Promise.all([
    store.edit((d: any) => {
      d.notes.room = "private-note-marker";
    }),
    store.edit((d: any) => {
      d.templates.push({
        id: "t",
        name: "private-template",
        text: "template secret",
      });
    }),
    store.edit((d: any) => {
      d.drafts.room = { text: "draft-secret", reply: null };
    }),
  ]);
  const persisted = raw.get(store.key)!;
  expect(persisted).not.toContain("private-note-marker");
  expect(persisted).not.toContain("template secret");
  expect(persisted).not.toContain("draft-secret");
  const restored = await createPersonalStore(identity, storage).load();
  expect(restored.notes.room).toBe("private-note-marker");
  expect(restored.templates.length).toBe(1);
  expect(restored.drafts.room.text).toBe("draft-secret");
  const envelope = JSON.parse(persisted);
  envelope.payload.ct = envelope.payload.ct.slice(0, -4) + "AAAA";
  raw.set(store.key, JSON.stringify(envelope));
  await expect(store.load()).rejects.toThrow();
  expect(raw.get(store.key)).toBe(JSON.stringify(envelope));
});
test("template variables expand at insertion time and unknown variables stay literal", () => {
  expect(
    expandTemplate(
      "{date} {time} {channel} {me} {other}",
      { channel: "一般", me: "Panda" },
      new Date(2026, 9, 25, 9, 4),
    ),
  ).toBe("2026-10-25 09:04 一般 Panda {other}");
});
test("button insertion validates protocols, credentials, delimiters and labels", () => {
  expect(buttonMarkup("https://example.com", "詳細")).toBe(
    "<button:https://example.com/|詳細>",
  );
  expect(buttonMarkup("https://example.com/a|b")).toBe(
    "<button:https://example.com/a%7Cb>",
  );
  for (const raw of [
    "javascript:alert(1)",
    "data:text/plain,foo",
    "https://test:" + crypto.randomUUID() + "@example.com",
    "https://exa mple.com",
    "broken",
  ])
    expect(() => buttonMarkup(raw)).toThrow();
  expect(() => buttonMarkup("https://example.com", "a>b")).toThrow();
});
