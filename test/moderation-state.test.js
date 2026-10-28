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

test("mute, unmute, and expiration in ModerationState", (t) => {
  let currentTime = 1_000_000;
  const dir = mkdtempSync(join(tmpdir(), "mod-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = new ModerationState(join(dir, "state.json"), {
    now: () => currentTime,
    initialData: { version: 1, incidents: [], cases: [], manualKicks: [] },
  });

  assert.equal(state.isMemberMuted("g1", "user-1"), false);
  assert.deepEqual(state.getMutedMembers("g1"), []);

  // Mute user-1 for 60 seconds (60,000 ms)
  state.muteMember({ groupId: "g1", userId: "user-1", mutedBy: "admin-1", durationMs: 60_000, reason: "spam" });
  assert.equal(state.isMemberMuted("g1", "user-1"), true);
  assert.equal(state.isMemberMuted("g1", "user-2"), false);
  assert.equal(state.getMutedMembers("g1").length, 1);

  // Advance time by 30 seconds -> still muted
  currentTime += 30_000;
  assert.equal(state.isMemberMuted("g1", "user-1"), true);

  // Unmute early
  assert.equal(state.unmuteMember("g1", "user-1"), true);
  assert.equal(state.isMemberMuted("g1", "user-1"), false);

  // Re-mute user-1 for 60 seconds, then advance past expiration
  state.muteMember({ groupId: "g1", userId: "user-1", mutedBy: "admin-1", durationMs: 60_000 });
  currentTime += 65_000;
  assert.equal(state.isMemberMuted("g1", "user-1"), false);
  assert.deepEqual(state.getMutedMembers("g1"), []);
});

test("locket gold orders and instructions management in ModerationState", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mod-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = new ModerationState(join(dir, "state.json"), {
    initialData: { version: 1, incidents: [], cases: [], manualKicks: [] },
  });

  // Default instruction
  assert.match(state.getLocketInstruction(), /HƯỚNG DẪN KÍCH HOẠT LOCKET GOLD/);
  assert.match(state.getLocketInstruction(), /Shadowrocket/);

  // Custom instruction
  state.setLocketInstruction("Hướng dẫn tùy chỉnh bước 1 2 3");
  assert.equal(state.getLocketInstruction(), "Hướng dẫn tùy chỉnh bước 1 2 3");
  state.resetLocketInstruction();
  assert.match(state.getLocketInstruction(), /HƯỚNG DẪN KÍCH HOẠT LOCKET GOLD/);

  // Create order
  assert.deepEqual(state.listPendingLocketOrders(), []);
  const res1 = state.createLocketOrder({ uid: "user-100", name: "Khách 1" });
  assert.equal(res1.isNew, true);
  assert.equal(res1.order.uid, "user-100");
  assert.equal(res1.order.status, "pending");

  // Duplicate create updates timestamp but isNew is false
  const res2 = state.createLocketOrder({ uid: "user-100", name: "Khách 1 Đổi Tên" });
  assert.equal(res2.isNew, false);
  assert.equal(res2.order.name, "Khách 1 Đổi Tên");

  // Add another order
  state.createLocketOrder({ uid: "user-200", name: "Khách 2" });
  assert.equal(state.listPendingLocketOrders().length, 2);

  // Approve user-100
  const approved = state.approveLocketOrder("user-100", "admin-999");
  assert.equal(approved.status, "approved");
  assert.equal(approved.approvedBy, "admin-999");

  // Only user-200 remains pending
  const pending = state.listPendingLocketOrders();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].uid, "user-200");

  // Reject user-200
  const rejected = state.rejectLocketOrder("user-200", "admin-999");
  assert.equal(rejected.status, "rejected");
  assert.equal(state.listPendingLocketOrders().length, 0);

  // Approve a direct UID that had no prior order
  const directApproved = state.approveLocketOrder("user-300", "admin-999");
  assert.equal(directApproved.status, "approved");
  assert.equal(state.getLocketOrder("user-300").status, "approved");

  // Model URL and Video URL management
  assert.equal(state.getModelUrl(), "https://zalo-link-guard-1.onrender.com/download/model");
  assert.equal(state.getVideoUrl(), "https://zalo-link-guard-1.onrender.com/download/video");

  state.setModelUrl("https://example.com/custom-model.conf");
  assert.equal(state.getModelUrl(), "https://example.com/custom-model.conf");

  state.setVideoUrl("https://example.com/custom-video.mp4");
  assert.equal(state.getVideoUrl(), "https://example.com/custom-video.mp4");
});
