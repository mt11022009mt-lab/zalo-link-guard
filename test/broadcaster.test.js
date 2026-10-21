import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadType } from "zca-js";
import { createBroadcaster, formatBroadcastMessage, parseSpinText, getCommandText } from "../src/broadcaster.js";

const OPERATOR_1 = "1111111111";
const OPERATOR_2 = "2222222222";
const STRANGER = "9999999999";

function createFixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "broadcaster-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const sent = [];
  const joinedLinks = [];
  let currentTime = 1_000_000_000;

  const api = {
    sendMessage: async (text, threadId, type) => {
      sent.push({ text, threadId, type });
      return { message: { msgId: `msg-${sent.length}` }, attachment: [] };
    },
    joinGroupLink: async (link) => {
      joinedLinks.push(link);
      return "";
    },
    getAllGroups: async () => ({
      gridVerMap: { "group-1": "1", "group-2": "1" },
    }),
  };

  const config = {
    groupIds: ["group-1", "group-2"],
    broadcastOperatorIds: [OPERATOR_1, OPERATOR_2],
    broadcast: {
      minDelaySeconds: 60,
      maxDelaySeconds: 180,
      joinDelaySeconds: 10,
      maxSendsPerDay: 30,
      dryRun: false,
      ...overrides.broadcast,
    },
    ...overrides,
  };

  const broadcaster = createBroadcaster({
    api,
    config,
    filePath: join(dir, "broadcast-state.json"),
    clock: () => currentTime,
    randomFn: () => 0.5,
  });

  t.after(() => broadcaster.close());

  return {
    api,
    sent,
    joinedLinks,
    broadcaster,
    setTime: (tMs) => { currentTime = tMs; },
    advanceTime: (s) => { currentTime += s * 1000; },
  };
}

test("parseSpinText chooses variants and formatBroadcastMessage appends link", () => {
  const spin = parseSpinText("{Xin chào|Chào bạn}", () => 0);
  assert.equal(spin, "Xin chào");

  const spin2 = parseSpinText("{Xin chào|Chào bạn}", () => 0.9);
  assert.equal(spin2, "Chào bạn");

  const formatted = formatBroadcastMessage("{Xin chào}, xem ngay nhé!", "https://example.com/promo");
  assert.ok(formatted.includes("https://example.com/promo"));

  const formattedWithPlaceholder = formatBroadcastMessage("Xem link {link} ở đây!", "https://example.com/promo");
  assert.equal(formattedWithPlaceholder, "Xem link https://example.com/promo ở đây!");
});

test("/myid command returns the sender's UID", async (t) => {
  const { broadcaster, sent } = createFixture(t);

  const handled = await broadcaster.handleCommand({
    isSelf: false,
    threadId: "user-123",
    type: ThreadType.User,
    data: { uidFrom: "user-123", content: "/myid" },
  });

  assert.equal(handled, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "UID Zalo của bạn là: user-123");
});

test("stranger cannot start or stop broadcast; authorized operators can", async (t) => {
  const { broadcaster, sent } = createFixture(t);

  // Stranger tries /railink
  const strangerHandled = await broadcaster.handleCommand({
    isSelf: false,
    threadId: STRANGER,
    type: ThreadType.User,
    data: { uidFrom: STRANGER, content: "/railink https://zalo.me/g/test Chào mọi người" },
  });
  assert.equal(strangerHandled, true);
  assert.ok(sent.at(-1).text.includes("không có quyền"));

  // Operator 1 starts broadcast
  const opHandled = await broadcaster.handleCommand({
    isSelf: false,
    threadId: OPERATOR_1,
    type: ThreadType.User,
    data: { uidFrom: OPERATOR_1, content: "/railink https://example.com/app {Chào anh em|Hello}, tải app ngay" },
  });
  assert.equal(opHandled, true);
  assert.ok(sent.at(-1).text.includes("Đã khởi tạo chiến dịch"));

  assert.equal(broadcaster.store.data.campaign.status, "running");
  assert.equal(broadcaster.store.data.campaign.items.length, 2);

  // Operator 2 stops broadcast
  const stopHandled = await broadcaster.handleCommand({
    isSelf: false,
    threadId: OPERATOR_2,
    type: ThreadType.User,
    data: { uidFrom: OPERATOR_2, content: "/stoprai" },
  });
  assert.equal(stopHandled, true);
  assert.ok(sent.at(-1).text.includes("Đã dừng chiến dịch"));
  assert.equal(broadcaster.store.data.campaign.status, "stopped");
});

test("auto-detects group invites in incoming messages and joins them", async (t) => {
  const { api, broadcaster, joinedLinks, advanceTime } = createFixture(t);
  api.getAllGroups = async () => ({
    gridVerMap: { "group-1": "1", "group-2": "1", "group-joined": "1" },
  });

  // Message containing a group invite
  broadcaster.inspectMessageForInvites({
    isSelf: false,
    threadId: "group-1",
    type: ThreadType.Group,
    data: {
      uidFrom: "spammer-1",
      content: "Vào nhóm giao lưu nhé cả nhà: https://zalo.me/g/newgroup123",
    },
  });

  // Join worker runs
  advanceTime(35);
  await broadcaster.stepJoinWorker();

  assert.equal(joinedLinks.length, 1);
  assert.equal(joinedLinks[0], "https://zalo.me/g/newgroup123");
  assert.ok(broadcaster.store.data.targetGroups.includes("group-joined"));
});

test("staggered broadcast worker sends one by one with delay and respects daily limit", async (t) => {
  const { broadcaster, sent, advanceTime } = createFixture(t);

  // Start campaign
  await broadcaster.handleCommand({
    isSelf: false,
    threadId: OPERATOR_1,
    type: ThreadType.User,
    data: { uidFrom: OPERATOR_1, content: "/railink https://example.com/app {Chào anh em|Hello}, tải app ngay" },
  });

  // Step 1: First item is sent immediately
  await broadcaster.stepBroadcastWorker();
  const group1Msg = sent.find((s) => s.threadId === "group-1" && s.type === ThreadType.Group);
  assert.ok(group1Msg);
  assert.ok(group1Msg.text.includes("https://example.com/app"));

  // Before delay expires, second item is NOT sent
  await broadcaster.stepBroadcastWorker();
  let group2Msg = sent.find((s) => s.threadId === "group-2" && s.type === ThreadType.Group);
  assert.equal(group2Msg, undefined);

  // Advance time past delay (e.g. 150s)
  advanceTime(150);
  await broadcaster.stepBroadcastWorker();
  group2Msg = sent.find((s) => s.threadId === "group-2" && s.type === ThreadType.Group);
  assert.ok(group2Msg);

  // Campaign reaches done
  await broadcaster.stepBroadcastWorker();
  assert.equal(broadcaster.store.data.campaign.status, "done");
});

test("getCommandText extracts slash commands from string, object and rich link formats", () => {
  // Plain string
  assert.equal(getCommandText({ data: { content: "/myid" } }), "/myid");

  // Object with description
  assert.equal(
    getCommandText({
      data: {
        msgType: "chat.link",
        content: {
          title: "Dame By NCK",
          href: "https://zalo.me/g/sae9jnelddyql12uuymv",
          description: "/railink https://zalo.me/g/sae9jnelddyql12uuymv vao de",
        },
      },
    }),
    "/railink https://zalo.me/g/sae9jnelddyql12uuymv vao de"
  );

  // Serialized JSON content
  assert.equal(
    getCommandText({
      data: {
        content: JSON.stringify({
          href: "https://zalo.me/g/test",
          desc: "/quetnhom",
        }),
      },
    }),
    "/quetnhom"
  );
});

test("scanAllGroupsForInvites reads all existing groups and queues invites found in history", async (t) => {
  const { broadcaster, sent } = createFixture(t);

  // Mock history reader
  const mockHistoryReader = async (groupId) => {
    if (groupId === "group-1") {
      return {
        groupMsgs: [
          { data: { content: "Chào cả nhà, tham gia nhóm này nha https://zalo.me/g/historyinvite1" } },
        ],
      };
    }
    return { groupMsgs: [] };
  };

  const scanResult = await broadcaster.scanAllGroupsForInvites(mockHistoryReader);
  assert.equal(scanResult.linksFound, 1);
  assert.ok(broadcaster.joinQueue.includes("https://zalo.me/g/historyinvite1"));

  // Trigger /quetnhom command via chat
  const handled = await broadcaster.handleCommand({
    isSelf: false,
    threadId: OPERATOR_1,
    type: ThreadType.User,
    data: { uidFrom: OPERATOR_1, content: "/quetnhom" },
  });

  assert.equal(handled, true);
  const finishMsg = sent.find((s) => s.text.includes("Đã quét xong"));
  assert.ok(finishMsg);
});
