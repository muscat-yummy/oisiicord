import { test, expect } from "bun:test";
import { mentions, isMentioned, shouldNotify } from "../public/mentions.js";
import { defaults } from "../public/preferences.js";
const guild = {
  roles: [{ id: "moderator" }, { id: "other" }],
  roleAssignments: { alice: ["moderator"] },
};
test("default notification mode and explicit server overrides", () => {
  expect(defaults.notificationMode).toBe("mentions");
  const payload = { type: "message", text: "hello" };
  expect(shouldNotify(payload, "alice", guild)).toBe(false);
  expect(shouldNotify(payload, "alice", guild, "all")).toBe(true);
  expect(
    shouldNotify(
      { type: "message", text: "<@alice>" },
      "alice",
      guild,
      "silent",
    ),
  ).toBe(false);
  expect(shouldNotify(payload, "alice", undefined)).toBe(true);
});
test("user, assigned role and everyone mentions match intended recipients", () => {
  expect(isMentioned("<@alice>", "alice", guild)).toBe(true);
  expect(isMentioned("<@bob>", "alice", guild)).toBe(false);
  expect(isMentioned("<@&moderator>", "alice", guild)).toBe(true);
  expect(isMentioned("<@&other>", "alice", guild)).toBe(false);
  expect(
    isMentioned("<@&deleted>", "alice", {
      roleAssignments: { alice: ["deleted"] },
    }),
  ).toBe(false);
  expect(isMentioned("@everyone お知らせ", "alice", guild)).toBe(true);
  expect(isMentioned("@everyone", "alice", undefined)).toBe(false);
});
test("links, malformed tokens and non-message events do not ping", () => {
  for (const type of ["edit", "pin", "reaction", "delete"])
    expect(
      shouldNotify({ type, text: "<@alice> @everyone" }, "alice", guild, "all"),
    ).toBe(false);
  expect(shouldNotify(undefined, "alice", guild)).toBe(false);
  expect(
    mentions("mail@everyone @@everyone @everyonex <@> <@&> <@a/b>"),
  ).toEqual([]);
  expect(
    mentions(
      "https://example.com/@everyone <button:https://example.com|@everyone>",
    ),
  ).toEqual([]);
  expect(
    mentions("<@alice> <@&moderator> @everyone").map((m) => m.kind),
  ).toEqual(["user", "role", "everyone"]);
});
