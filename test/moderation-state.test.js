import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModerationState } from "../src/moderation-state.js";

test("a temporary database write failure does not poison later counter saves", async () => {
  let attempts = 0;
  let persisted;
  const state = new ModerationState("unused.json", {
    initialData: { version: 1, incidents: [], cases: [], manualKicks: [] },
    saveHook: async (snapshot) => {
      if (++attempts === 1) throw new Error("temporary database outage");
      persisted = structuredClone(snapshot);
    },
  });
  const violation = (messageId) => ({
    groupId: "group-1", userId: "member-1", messageId,
    links: [{ url: "https://spam.example/a" }],
  });
  assert.equal(state.recordViolation(violation("1")).count, 1);
  await assert.rejects(state.flush(), /temporary database outage/);
  assert.equal(state.recordViolation(violation("2")).count, 2);
  await state.flush();
  assert.equal(persisted.incidents.length, 2);
});

test("allowed users whitelist management in ModerationState", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mod-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = new ModerationState(join(dir, "state.json"), {
    initialData: { version: 1, incidents: [], cases: [], manualKicks: [] },
  });

  assert.deepEqual(state.getAllowedUsers(), []);
  assert.equal(state.isUserAllowed("123"), false);

  assert.equal(state.addAllowedUser("123"), true);
  assert.equal(state.addAllowedUser("123"), false); // duplicate
  assert.equal(state.addAllowedUser("456"), true);
  assert.deepEqual(state.getAllowedUsers(), ["123", "456"]);
  assert.equal(state.isUserAllowed("123"), true);
  assert.equal(state.isUserAllowed("456"), true);
  assert.equal(state.isUserAllowed("789"), false);

  assert.equal(state.removeAllowedUser("123"), true);
  assert.equal(state.removeAllowedUser("123"), false);
  assert.deepEqual(state.getAllowedUsers(), ["456"]);
  assert.equal(state.isUserAllowed("123"), false);
});

test("strictAdminOnly and activeGroups management in ModerationState", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mod-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = new ModerationState(join(dir, "state.json"), {
    initialData: { version: 1, incidents: [], cases: [], manualKicks: [] },
  });

  // strictAdminOnly
  assert.equal(state.isStrictAdminOnly("g1"), false);
  state.setStrictAdminOnly("g1", true);
  assert.equal(state.isStrictAdminOnly("g1"), true);
  state.setStrictAdminOnly("g1", false);
  assert.equal(state.isStrictAdminOnly("g1"), false);

  // activeGroups
  assert.equal(state.isGroupActive("g1", ["cfg-group"]), false);
  assert.equal(state.isGroupActive("cfg-group", ["cfg-group"]), true);

  state.activateGroup("g1");
  assert.equal(state.isGroupActive("g1", ["cfg-group"]), true);

  state.disableGroup("g1");
  assert.equal(state.isGroupActive("g1", ["cfg-group"]), false);

  state.enableGroup("g1");
  assert.equal(state.isGroupActive("g1", ["cfg-group"]), true);

  state.deactivateGroup("g1");
  assert.equal(state.isGroupActive("g1", ["cfg-group"]), false);
});
