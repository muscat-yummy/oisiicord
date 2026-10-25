import { test, expect } from "bun:test";
import * as C from "../public/crypto.js";
import {
  createPersonalStore,
  expandTemplate,
  buttonMarkup,
} from "../public/personal-store.js";
test("private notes and templates survive reload as authenticated ciphertext", async () => {
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
  ]);
  const persisted = raw.get(store.key)!;
  expect(persisted).not.toContain("private-note-marker");
  expect(persisted).not.toContain("template secret");
  const restored = await createPersonalStore(identity, storage).load();
  expect(restored.notes.room).toBe("private-note-marker");
  expect(restored.templates.length).toBe(1);
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

test("existing personal data keeps notes and templates without restoring old drafts", async () => {
  const keys = await C.identity();
  const identity = {
    ...(await C.importIdentity(keys.privateKeys, keys.keys)),
    id: crypto.randomUUID(),
  };
  const envelope = await C.seal(
    {
      type: "personal-tools",
      data: {
        notes: { room: "keep" },
        templates: [],
        drafts: { room: { text: "old draft" } },
      },
    },
    {
      room: "oisiicord/local-tools/" + identity.id,
      author: identity.id,
      identity,
      recipients: [identity],
    },
  );
  let raw = JSON.stringify(envelope);
  const store = createPersonalStore(identity, {
    getItem: () => raw,
    setItem: (_key, value) => {
      raw = value;
    },
  });
  expect(await store.load()).toEqual({
    notes: { room: "keep" },
    templates: [],
  });
  await store.edit((data: any) => {
    data.notes.room = "updated";
  });
  expect(
    (
      await C.open(
        JSON.parse(raw),
        identity,
        identity.keys,
        "oisiicord/local-tools/" + identity.id,
      )
    ).data.drafts,
  ).toBeUndefined();
});
