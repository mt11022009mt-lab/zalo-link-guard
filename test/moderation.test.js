import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModerationState } from "../src/moderation-state.js";
import { createModeration, parseManualKickTarget } from "../src/moderation.js";
import { checkMessage } from "../src/policy.js";
import { AIService } from "../src/ai-service.js";

const GROUP = "700001";
const BOT = "900001";
const OWNER = "900002";
const ADMIN = "900003";
const MEMBER = "900004";
const config = { groupIds: [GROUP], trustedUserIds: [], allowedDomains: [], dryRun: false };
const logger = { info() {}, error() {} };

function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "zalo-link-guard-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const state = new ModerationState(join(directory, "state.json"), {
    now: () => 1_000_000_000, windowHours: overrides.violationWindowHours ?? 24,
  });
  const sent = [];
  const kicked = [];
  const api = {
    getOwnId: () => BOT,
    getGroupInfo: async (id) => ({ gridInfoMap: { [id]: { creatorId: OWNER, adminIds: [BOT, ADMIN] } } }),
    sendMessage: async (text, id, type) => { sent.push({ text, id, type }); },
    removeUserFromGroup: async (id, groupId) => { kicked.push({ id, groupId }); return { errorMembers: [] }; },
  };
  const moderation = createModeration({ api, config: { ...config, ...overrides }, state, aiService: overrides.aiService, log: logger });
  return { api, state, sent, kicked, moderation };
}

const linkMessage = (id) => ({
  type: 1, isSelf: false, threadId: GROUP,
  data: { msgId: String(id), uidFrom: MEMBER, dName: "Người gửi", content: "https://spam.site/a" },
});
const approval = (command, sender = ADMIN) => ({
  type: 1, isSelf: false, threadId: GROUP, data: { uidFrom: sender, content: command },
});
const manualKick = (sender = ADMIN, mentions = [{ uid: MEMBER, pos: 6, len: 7, type: 0 }]) => ({
  type: 1, isSelf: false, threadId: GROUP,
  data: { uidFrom: sender, content: "/kick @Member", mentions },
});
const manualTha = (sender = ADMIN, mentions = [{ uid: MEMBER, pos: 5, len: 7, type: 0 }]) => ({
  type: 1, isSelf: false, threadId: GROUP,
  data: { uidFrom: sender, content: "/tha @Member", mentions },
});

test("three zalo.me messages create a review case when autoKick is false; only a live admin approval kicks one member", async (t) => {
  const { state, sent, kicked, moderation } = fixture(t, { allowedDomains: ["zalo.me"], autoKick: false });
  let lastMessage;
  let lastResult;
  for (let id = 1; id <= 3; id++) {
    const message = linkMessage(id);
    message.data.content = id === 2 ? { href: "https://zalo.me/abc" } : "https://zalo.me/abc";
    if (id === 2) message.data.msgType = "chat.recommended";
    const result = checkMessage(message, { ...config, allowedDomains: ["zalo.me"] });
    assert.ok(result);
    await moderation.onViolation(message, result);
    lastMessage = message;
    lastResult = result;
  }
  await moderation.onViolation(lastMessage, lastResult); // Duplicate webhook delivery.

  const pending = state.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].evidence.length, 3);
  assert.equal(pending[0].displayName, "Người gửi");
  assert.equal(state.listViolations()[0].count, 3);
  assert.equal(kicked.length, 0);
  assert.equal(sent.length, 0); // Không gửi tin cảnh báo hay DM tự động

  await moderation.handleCommand(approval("/vipham"));
  const list = sent.at(-1);
  assert.equal(list.id, GROUP);
  assert.equal(typeof list.text, "object");
  assert.equal(list.text.msg.includes(MEMBER), false);
  assert.equal(list.text.msg.includes("hiện còn 3 lần"), true);
  assert.equal(list.text.msg.includes("hồ sơ 3 tin"), true);
  assert.deepEqual(list.text.mentions, [{
    pos: list.text.msg.indexOf("@Người gửi"), uid: MEMBER, len: "@Người gửi".length,
  }]);

  await moderation.handleCommand(approval(`/duyetkick ${pending[0].id}`, MEMBER));
  assert.equal(kicked.length, 0);
  await moderation.handleCommand(approval(`/duyetkick ${pending[0].id}`));
  assert.deepEqual(kicked, [{ id: MEMBER, groupId: GROUP }]);
  await moderation.handleCommand(approval(`/duyetkick ${pending[0].id}`));
  assert.equal(kicked.length, 1);
});

test("three strikes auto-kicks member silently without sending group notices or DMs", async (t) => {
  const { state, sent, kicked, moderation } = fixture(t);
  for (let id = 1; id <= 3; id++) {
    const message = linkMessage(id);
    const result = checkMessage(message, { ...config, allowedDomains: ["zalo.me"] });
    assert.ok(result);
    await moderation.onViolation(message, result);
  }
  assert.deepEqual(kicked, [{ id: MEMBER, groupId: GROUP }]);
  assert.equal(state.listViolations()[0].count, 3);
  assert.equal(sent.length, 0); // Im lặng 100%
});

test("/vipham shows 1–2 strikes to admins before a review case exists", async (t) => {
  const { state, sent, kicked, moderation } = fixture(t);
  const result = { links: [
    { url: "https://spam.site/a", hostname: "spam.site" },
    { url: "https://zalo.me/g/a", hostname: "zalo.me" },
  ] };
  for (let id = 1; id <= 2; id++) {
    await moderation.onViolation(linkMessage(id), result);
    assert.equal(state.listViolations()[0].count, id);
    assert.equal(state.listPending().length, 0);
  }
  assert.equal(sent.length, 0); // Chưa gõ lệnh thì không có tin cảnh báo tự động nào
  await moderation.handleCommand(approval("/vipham"));
  const groupList = sent.at(-1);
  assert.equal(groupList.id, GROUP);
  assert.equal(groupList.text.msg.includes("2/3 lần"), true);
  assert.deepEqual(groupList.text.mentions, [{
    pos: groupList.text.msg.indexOf("@Người gửi"), uid: MEMBER, len: "@Người gửi".length,
  }]);
  await moderation.handleCommand(approval("/vipham", MEMBER));
  assert.equal(sent.at(-1).text.includes("Chỉ QTV"), true);
  assert.equal(kicked.length, 0);
  assert.equal(state.listViolations()[0].count, 2);
});

test("image-only moderation does not create a link strike or kick case", async (t) => {
  const { state, kicked, moderation } = fixture(t);
  await moderation.onViolation(linkMessage("photo-1"), { links: [], image: true });
  assert.equal(state.listViolations().length, 0);
  assert.equal(state.listPending().length, 0);
  assert.equal(kicked.length, 0);
});

test("/vipham via private message shows counts without disclosing other groups", async (t) => {
  const { sent, moderation } = fixture(t);
  await moderation.onViolation(linkMessage(1), { links: [{ url: "https://spam.site/a" }] });
  await moderation.handleCommand({ type: 0, isSelf: false, threadId: ADMIN, data: { uidFrom: ADMIN, content: "/vipham" } });
  const privateList = sent.findLast((item) => item.id === ADMIN && typeof item.text === "string" && item.text.includes("1/3 lần"));
  assert.ok(privateList);
  assert.equal(privateList.text.includes("@Người gửi"), true);
});

test("configured violation window is shown and old strikes leave the list", async (t) => {
  const { sent, moderation } = fixture(t, { violationWindowHours: 12 });
  await moderation.onViolation(linkMessage(1), { links: [{ url: "https://spam.site/a" }] });
  await moderation.handleCommand(approval("/vipham"));
  assert.equal(sent.at(-1).text.msg.includes("1/3 lần trong 12 giờ"), true);

  const directory = mkdtempSync(join(tmpdir(), "zalo-link-guard-window-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let time = 1_000_000_000;
  const state = new ModerationState(join(directory, "state.json"), { now: () => time, windowHours: 1 });
  state.recordViolation({ groupId: GROUP, userId: MEMBER, messageId: "old", links: [{ url: "https://spam.site/a" }] });
  time += 30 * 60 * 1000;
  state.recordViolation({ groupId: GROUP, userId: MEMBER, messageId: "new", links: [{ url: "https://spam.site/a" }] });
  assert.equal(state.listViolations()[0].count, 2);
  time += 31 * 60 * 1000;
  assert.equal(state.listViolations()[0].count, 1);
});

test("old pending cases use the current group name for a real mention", async (t) => {
  const { api, state, sent, moderation } = fixture(t);
  const otherMember = "900005";
  for (let id = 1; id <= 4; id++) {
    state.recordViolation({ groupId: GROUP, userId: MEMBER, messageId: String(id), links: [{ url: "spam.site" }] });
    state.recordViolation({ groupId: GROUP, userId: otherMember, messageId: `other-${id}`, links: [{ url: "spam.site" }] });
  }
  api.getGroupInfo = async (id) => ({ gridInfoMap: { [id]: {
    creatorId: OWNER, adminIds: [BOT, ADMIN], currentMems: [
      { id: MEMBER, dName: "Tên mới" }, { id: otherMember, dName: "Người thứ hai" },
    ],
  } } });
  await moderation.handleCommand(approval("/vipham"));
  const list = sent.at(-1);
  assert.equal(list.text.msg.includes("@Tên mới"), true);
  assert.deepEqual(list.text.mentions, [
    { pos: list.text.msg.indexOf("@Tên mới"), uid: MEMBER, len: "@Tên mới".length },
    { pos: list.text.msg.indexOf("@Người thứ hai"), uid: otherMember, len: "@Người thứ hai".length },
  ]);
});

test("manual /kick requires one real tag and a current group admin", async (t) => {
  const { state, kicked, moderation } = fixture(t);
  assert.equal(parseManualKickTarget(manualKick()), MEMBER);
  assert.equal(parseManualKickTarget(manualKick(ADMIN, [{ uid: "-1", pos: 6, len: 7, type: 1 }])), null);
  assert.equal(parseManualKickTarget(manualKick(ADMIN, [
    { uid: MEMBER, pos: 6, len: 7, type: 0 }, { uid: OWNER, pos: 6, len: 7, type: 0 },
  ])), null);
  await moderation.handleCommand(manualKick(MEMBER));
  assert.equal(kicked.length, 0);
  await moderation.handleCommand(manualKick(ADMIN, [{ uid: OWNER, pos: 6, len: 7, type: 0 }]));
  assert.equal(kicked.length, 0);
  for (let id = 1; id <= 4; id++) state.recordViolation({ groupId: GROUP, userId: MEMBER, messageId: String(id), links: [{ url: "spam.site" }] });
  await moderation.handleCommand(manualKick());
  assert.deepEqual(kicked, [{ id: MEMBER, groupId: GROUP }]);
  assert.equal(state.listPending().length, 0);
});

test("dry run never kicks for approval or manual command", async (t) => {
  const { state, kicked, moderation } = fixture(t, { dryRun: true });
  await moderation.onViolation(linkMessage("dry-run"), { links: [{ url: "https://spam.site/a" }] });
  assert.equal(state.data.incidents.length, 0);
  assert.equal(state.listViolations().length, 0);
  const item = state.recordViolation({ groupId: GROUP, userId: MEMBER, messageId: "1", links: [{ url: "spam.site" }] });
  for (let id = 2; id <= 4; id++) state.recordViolation({ groupId: GROUP, userId: MEMBER, messageId: String(id), links: [{ url: "spam.site" }] });
  const caseId = state.listPending()[0].id;
  assert.equal(item.newCase, false);
  await moderation.handleCommand(approval(`/duyetkick ${caseId}`));
  await moderation.handleCommand(manualKick());
  assert.equal(kicked.length, 0);
  assert.equal(state.getCase(caseId).status, "pending");
});

test("rejection resets strikes and leaves the member in the group", async (t) => {
  const { state, kicked, moderation } = fixture(t);
  for (let id = 1; id <= 4; id++) state.recordViolation({ groupId: GROUP, userId: MEMBER, messageId: String(id), links: [{ url: "spam.site" }] });
  const caseId = state.listPending()[0].id;
  await moderation.handleCommand(approval(`/tuchoikick ${caseId}`));
  assert.equal(state.getCase(caseId).status, "rejected");
  assert.equal(state.data.incidents.length, 0);
  assert.equal(state.listViolations().length, 0);
  assert.equal(kicked.length, 0);
});

test("two simultaneous approvals send only one kick request", async (t) => {
  const { state, kicked, moderation } = fixture(t);
  for (let id = 1; id <= 4; id++) state.recordViolation({ groupId: GROUP, userId: MEMBER, messageId: String(id), links: [{ url: "spam.site" }] });
  const caseId = state.listPending()[0].id;
  await Promise.all([
    moderation.handleCommand(approval(`/duyetkick ${caseId}`)),
    moderation.handleCommand(approval(`/duyetkick ${caseId}`)),
  ]);
  assert.equal(kicked.length, 1);
});

test("failed Zalo kick leaves the case pending for review", async (t) => {
  const { api, state, moderation } = fixture(t);
  api.removeUserFromGroup = async () => ({ errorMembers: [MEMBER] });
  for (let id = 1; id <= 4; id++) state.recordViolation({ groupId: GROUP, userId: MEMBER, messageId: String(id), links: [{ url: "spam.site" }] });
  const caseId = state.listPending()[0].id;
  await moderation.handleCommand(approval(`/duyetkick ${caseId}`));
  assert.equal(state.getCase(caseId).status, "pending");
});

test("a target promoted to admin cannot be kicked from an older case", async (t) => {
  const { api, state, kicked, moderation } = fixture(t);
  for (let id = 1; id <= 4; id++) state.recordViolation({ groupId: GROUP, userId: MEMBER, messageId: String(id), links: [{ url: "spam.site" }] });
  const caseId = state.listPending()[0].id;
  api.getGroupInfo = async (id) => ({ gridInfoMap: { [id]: { creatorId: OWNER, adminIds: [BOT, ADMIN, MEMBER] } } });
  await moderation.handleCommand(approval(`/duyetkick ${caseId}`));
  assert.equal(kicked.length, 0);
  assert.equal(state.getCase(caseId).status, "pending");
});

test("expired cases are never approved", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "zalo-link-guard-expiry-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let time = 1_000_000_000;
  const state = new ModerationState(join(directory, "state.json"), { now: () => time });
  for (let id = 1; id <= 4; id++) state.recordViolation({ groupId: GROUP, userId: MEMBER, messageId: String(id), links: [{ url: "spam.site" }] });
  const caseId = state.listPending()[0].id;
  time += 25 * 60 * 60 * 1000;
  assert.equal(state.getCase(caseId).status, "expired");
  assert.equal(state.listPending().length, 0);
});

test("manual kick stops before the API call if intent cannot be saved", async (t) => {
  const { state, kicked, moderation } = fixture(t);
  state.startManualKick = () => { throw new Error("Disk unavailable"); };
  await moderation.handleCommand(manualKick());
  assert.equal(kicked.length, 0);
});

test("manual kick waits for durable storage before calling Zalo", async (t) => {
  const { state, kicked, sent, moderation } = fixture(t);
  state.saveHook = async () => { throw new Error("Database unavailable"); };
  await moderation.handleCommand(manualKick());
  assert.equal(kicked.length, 0);
  assert.match(sent.at(-1).text, /Database unavailable/);
});

test("/tha clears strikes for a tagged member", async (t) => {
  const { state, sent, moderation } = fixture(t);
  for (let id = 1; id <= 2; id++) {
    state.recordViolation({ groupId: GROUP, userId: MEMBER, messageId: String(id), links: [{ url: "spam.site" }] });
  }
  assert.equal(state.listViolations()[0].count, 2);
  await moderation.handleCommand(manualTha(MEMBER)); // Member cannot clear
  assert.equal(state.listViolations()[0].count, 2);
  await moderation.handleCommand(manualTha(ADMIN)); // Admin clears
  assert.equal(state.listViolations().length, 0);
  assert.match(sent.at(-1).text, /Đã xóa lịch sử vi phạm/);
});

test("/status and /help commands respond with bot information and guide", async (t) => {
  const { sent, moderation } = fixture(t);
  await moderation.handleCommand(approval("/status"));
  assert.match(sent.at(-1).text, /ZALO LINK GUARD BOT/);
  await moderation.handleCommand(approval("/help"));
  assert.match(sent.at(-1).text, /CÁC LỆNH QUẢN TRỊ VIÊN/);
});

test("reply does not fall back to DM when group send throws", async (t) => {
  const { api, sent, moderation } = fixture(t);
  api.sendMessage = async (text, id, type) => {
    if (type === 1) throw new Error("Không thể nhận tin nhắn từ bạn.");
    sent.push({ text, id, type });
  };
  await moderation.handleCommand({
    type: 1, isSelf: false, threadId: GROUP,
    data: { uidFrom: ADMIN, content: "/status" },
  });
  assert.equal(sent.length, 0); // Không gửi DM riêng cho thành viên khi lỗi
});

test("/tatbot and /batbot toggle group moderation status", async (t) => {
  const { state, sent, moderation } = fixture(t);

  // Ordinary member cannot toggle
  await moderation.handleCommand(approval("/tatbot", MEMBER));
  assert.equal(state.isGroupDisabled(GROUP), false);
  assert.match(sent.at(-1).text, /Chỉ QTV nhóm mới có quyền tắt bot/);

  // Admin toggles OFF
  await moderation.handleCommand(approval("/tatbot", ADMIN));
  assert.equal(state.isGroupDisabled(GROUP), true);
  assert.match(sent.at(-1).text, /Đã TẠM DỪNG bảo vệ/);

  // Status shows paused
  await moderation.handleCommand(approval("/status", ADMIN));
  assert.match(sent.at(-1).text, /ĐANG TẮT/);

  // Admin toggles ON
  await moderation.handleCommand(approval("/batbot", ADMIN));
  assert.equal(state.isGroupDisabled(GROUP), false);
  assert.match(sent.at(-1).text, /Đã KÍCH HOẠT LẠI bảo vệ/);

  // Status shows active
  await moderation.handleCommand(approval("/status", ADMIN));
  assert.match(sent.at(-1).text, /ĐANG BẬT/);
});

test("/ai command provides syntax guide and config guidance", async (t) => {
  const aiService = new AIService({ apiKey: "" });
  const { sent, moderation } = fixture(t, { aiService });

  // Empty prompt
  await moderation.handleCommand(approval("/ai"));
  assert.match(sent.at(-1).text, /Cú pháp: \/ai <câu hỏi của bạn>/);

  // Unconfigured API key
  await moderation.handleCommand(approval("/ai hôm nay trời đẹp không?"));
  assert.match(sent.at(-1).text, /chưa được kích hoạt/);
});

test("/ai command answers questions and enforces cooldown", async (t) => {
  const aiService = new AIService({ apiKey: "sk-test-key-123456" });
  aiService.ask = async (prompt) => `DeepSeek trả lời cho: ${prompt}`;
  const { sent, moderation } = fixture(t, { aiService });

  // Normal question
  await moderation.handleCommand(approval("/ai thời tiết hôm nay thế nào?", MEMBER));
  assert.equal(sent.at(-1).text, "DeepSeek trả lời cho: thời tiết hôm nay thế nào?");

  // Rapid question within cooldown
  await moderation.handleCommand(approval("/ai câu hỏi tiếp theo?", MEMBER));
  assert.match(sent.at(-1).text, /Bạn hỏi nhanh quá/);
});

test("AIService handles insufficient balance (402) promptly", async (t) => {
  const service = new AIService({ apiKey: "sk-test-key", baseUrl: "http://127.0.0.1:9" });
  // Mock fetch failure
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 402,
    json: async () => ({ error: { message: "Insufficient Balance" } }),
  });

  try {
    const res = await service.ask("test query");
    assert.match(res, /hết số dư \(\$0 - Insufficient Balance\)/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("tagging @Bot in group triggers AI assistant", async (t) => {
  const aiService = new AIService({ apiKey: "sk-test-key-123456" });
  aiService.ask = async (prompt) => `Trợ lý AI trả lời: ${prompt}`;
  const { sent, moderation } = fixture(t, { aiService });

  // Tag bot without prompt
  await moderation.handleCommand({
    type: 1, isSelf: false, threadId: GROUP,
    data: { uidFrom: MEMBER, content: "@Bot", mentions: [{ uid: BOT, pos: 0, len: 4, type: 0 }] },
  });
  assert.match(sent.at(-1).text, /Chào bạn! Bạn có thể hỏi mình bất cứ điều gì/);

  // Tag bot with question
  await moderation.handleCommand({
    type: 1, isSelf: false, threadId: GROUP,
    data: { uidFrom: MEMBER, content: "@Bot ai là người phát minh máy tính?", mentions: [{ uid: BOT, pos: 0, len: 4, type: 0 }] },
  });
  assert.match(sent.at(-1).text, /Trợ lý AI trả lời: ai là người phát minh máy tính\?/);
});

test("direct message (DM) to bot automatically calls AI", async (t) => {
  const aiService = new AIService({ apiKey: "sk-test-key-123456" });
  aiService.ask = async (prompt) => `DM AI: ${prompt}`;
  const { sent, moderation } = fixture(t, { aiService });

  await moderation.handleCommand({
    type: 0, isSelf: false, threadId: MEMBER,
    data: { uidFrom: MEMBER, content: "Xin chào bot" },
  });
  assert.equal(sent.at(-1).text, "DM AI: Xin chào bot");
});
