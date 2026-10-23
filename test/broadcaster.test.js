import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseSpinText,
  formatBroadcastMessage,
  BroadcastStore,
  createBroadcaster,
} from "../src/broadcaster.js";

const OPERATOR = "123456789";
const MEMBER = "987654321";
const BOT = "111222333";

test("parseSpinText and formatBroadcastMessage properly expand spin syntax and format links", () => {
  const template = "{Chào bạn|Xin chào} mời vào nhóm {nhé|ngay}!";
  const parsed1 = parseSpinText(template, () => 0.1);
  assert.equal(parsed1, "Chào bạn mời vào nhóm nhé!");
  const parsed2 = parseSpinText(template, () => 0.9);
  assert.equal(parsed2, "Xin chào mời vào nhóm ngay!");

  const withPlaceholder = "Tham gia ngay: {link} nhé!";
  const formatted1 = formatBroadcastMessage(withPlaceholder, "https://zalo.me/g/abc");
  assert.equal(formatted1, "Tham gia ngay: https://zalo.me/g/abc nhé!");

  const withoutPlaceholder = "Tham gia cùng anh em";
  const formatted2 = formatBroadcastMessage(withoutPlaceholder, "https://zalo.me/g/abc");
  assert.equal(formatted2, "Tham gia cùng anh em\nhttps://zalo.me/g/abc");
});

function createTestBroadcaster(t, { targets = ["group-1", "group-2"], configOverrides = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "zalo-broadcaster-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const sent = [];
  const joined = [];
  const left = [];

  const api = {
    getOwnId: () => BOT,
    sendMessage: async (text, threadId, type) => {
      sent.push({ text, threadId, type });
      return { status: 0 };
    },
    joinGroupLink: async (link) => {
      joined.push(link);
      return { status: 0 };
    },
    leaveGroup: async (groupId) => {
      left.push(groupId);
      return { status: 0 };
    },
    getAllGroups: async () => ({
      gridVerMap: { "group-1": 0, "group-2": 0 },
    }),
    getGroupInfo: async (ids) => ({
      gridInfoMap: {
        "group-1": { name: "Nhóm 1", creatorId: "other", adminIds: [], setting: { lockSendMsg: 0 } },
        "group-2": { name: "Nhóm 2", creatorId: "other", adminIds: [], setting: { lockSendMsg: 0 } },
      },
    }),
  };

  const config = {
    trustedUserIds: [OPERATOR],
    broadcast: {
      initialGroupIds: targets,
      minDelaySeconds: 1,
      maxDelaySeconds: 2,
      maxSendsPerDay: 50,
      dryRun: false,
      ...configOverrides,
    },
  };

  const broadcaster = createBroadcaster({
    api,
    config,
    filePath: join(directory, "broadcast-state.json"),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  t.after(() => broadcaster.stop());

  return { api, broadcaster, sent, joined, left };
}

test("unauthorized user cannot trigger broadcast commands", async (t) => {
  const { broadcaster, sent } = createTestBroadcaster(t);

  const handled = await broadcaster.handleCommand({
    type: 0,
    isSelf: false,
    threadId: MEMBER,
    data: { uidFrom: MEMBER, content: "/railink https://zalo.me/g/test Hello" },
  });

  assert.equal(handled, true);
  assert.equal(broadcaster.store.data.campaign, null);
  assert.match(sent.at(-1).text, /không có quyền/);
});

test("/railink creates campaign and /stoprai cancels it", async (t) => {
  const { broadcaster, sent } = createTestBroadcaster(t);

  // 1. Operator triggers /railink
  const handled = await broadcaster.handleCommand({
    type: 0,
    isSelf: false,
    threadId: OPERATOR,
    data: { uidFrom: OPERATOR, content: "/railink https://zalo.me/g/test {Xin chào|Chào bạn} vào nhóm nhé!" },
  });

  assert.equal(handled, true);
  const campaign = broadcaster.store.data.campaign;
  assert.ok(campaign);
  assert.equal(campaign.status, "running");
  assert.equal(campaign.url, "https://zalo.me/g/test");
  assert.equal(campaign.items.length, 2);
  assert.match(sent.at(-1).text, /ĐÃ KHỞI TẠO CHIẾN DỊCH RẢI LINK/);

  // 2. /trangthairai shows status
  await broadcaster.handleCommand({
    type: 0,
    isSelf: false,
    threadId: OPERATOR,
    data: { uidFrom: OPERATOR, content: "/trangthairai" },
  });
  assert.match(sent.at(-1).text, /Chiến dịch đang chạy/);

  // 3. /stoprai stops campaign
  await broadcaster.handleCommand({
    type: 0,
    isSelf: false,
    threadId: OPERATOR,
    data: { uidFrom: OPERATOR, content: "/stoprai" },
  });
  assert.equal(broadcaster.store.data.campaign.status, "stopped");
  assert.match(sent.at(-1).text, /ĐÃ DỪNG CHIẾN DỊCH/);
});

test("managing target groups via /themtarget, /xoatarget, and /dsnhom", async (t) => {
  const { broadcaster, sent } = createTestBroadcaster(t);

  // Add target
  await broadcaster.handleCommand({
    type: 0,
    isSelf: false,
    threadId: OPERATOR,
    data: { uidFrom: OPERATOR, content: "/themtarget group-99" },
  });
  assert.ok(broadcaster.store.data.targetGroups.includes("group-99"));
  assert.match(sent.at(-1).text, /Đã thêm nhóm group-99/);

  // List targets
  await broadcaster.handleCommand({
    type: 0,
    isSelf: false,
    threadId: OPERATOR,
    data: { uidFrom: OPERATOR, content: "/dsnhom" },
  });
  assert.match(sent.at(-1).text, /DANH SÁCH NHÓM MỤC TIÊU/);
  assert.match(sent.at(-1).text, /group-99/);

  // Remove target
  await broadcaster.handleCommand({
    type: 0,
    isSelf: false,
    threadId: OPERATOR,
    data: { uidFrom: OPERATOR, content: "/xoatarget group-99" },
  });
  assert.equal(broadcaster.store.data.targetGroups.includes("group-99"), false);
  assert.match(sent.at(-1).text, /Đã xóa nhóm group-99/);
});

test("/joinnhom provides guidance for safe manual joining", async (t) => {
  const { broadcaster, sent } = createTestBroadcaster(t);

  await broadcaster.handleCommand({
    type: 0,
    isSelf: false,
    threadId: OPERATOR,
    data: { uidFrom: OPERATOR, content: "/joinnhom https://zalo.me/g/newbox123" },
  });

  assert.match(sent.at(-1).text, /tự bấm tham gia nhóm/);
});

test("self-sent commands from bot account are supported", async (t) => {
  const { broadcaster, sent } = createTestBroadcaster(t);

  await broadcaster.handleCommand({
    type: 1,
    isSelf: true,
    threadId: "group-1",
    data: { uidFrom: BOT, content: "/dsnhom" },
  });

  assert.match(sent.at(-1).text, /DANH SÁCH NHÓM MỤC TIÊU/);
});
