import test from "node:test";
import assert from "node:assert/strict";
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
