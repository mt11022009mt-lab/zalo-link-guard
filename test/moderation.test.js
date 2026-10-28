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
  const groupSettingsUpdated = [];
  const api = {
    getOwnId: () => BOT,
    getGroupInfo: async (id) => ({
      gridInfoMap: {
        [id]: {
          creatorId: OWNER,
          adminIds: [BOT, ADMIN],
          setting: { lockSendMsg: 0, blockName: 1, signAdminMsg: 1 },
        },
      },
    }),
    sendMessage: async (text, id, type) => { sent.push({ text, id, type }); },
    removeUserFromGroup: async (id, groupId) => { kicked.push({ id, groupId }); return { errorMembers: [] }; },
    updateGroupSettings: async (settings, groupId) => { groupSettingsUpdated.push({ settings, groupId }); return ""; },
  };
  const moderation = createModeration({ api, config: { ...config, ...overrides }, state, aiService: overrides.aiService, log: logger });
  return { api, state, sent, kicked, groupSettingsUpdated, moderation };
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

test("/chiqtv and /khoachat toggle admin-only mode and lock/unlock group chat", async (t) => {
  const aiService = new AIService({ apiKey: "test-key" });
  aiService.ask = async (prompt) => `AI: ${prompt}`;
  const { state, sent, groupSettingsUpdated, moderation } = fixture(t, { aiService });

  // 1. Ordinary member cannot toggle /chiqtv
  await moderation.handleCommand(approval("/chiqtv", MEMBER));
  assert.equal(state.isAdminOnly(GROUP), false);
  assert.match(sent.at(-1).text, /Chỉ Trưởng nhóm\/Phó nhóm/);

  // 2. Admin enables /chiqtv on -> locks group chat on Zalo and enables admin-only
  await moderation.handleCommand(approval("/chiqtv on", ADMIN));
  assert.equal(state.isAdminOnly(GROUP), true);
  assert.equal(groupSettingsUpdated.at(-1).settings.lockSendMsg, true);
  assert.match(sent.at(-1).text, /ĐÃ KHÓA CHAT NHÓM THÀNH CÔNG/);

  // 3. Status shows admin-only is ON
  await moderation.handleCommand(approval("/status", ADMIN));
  assert.match(sent.at(-1).text, /Chế độ chỉ QTV: 🔒 BẬT/);

  // 4. Ordinary member tries /ai in admin-only group -> blocked with notice
  await moderation.handleCommand(approval("/ai test câu hỏi", MEMBER));
  assert.match(sent.at(-1).text, /CHỈ QUẢN TRỊ VIÊN mới được trò chuyện/);

  // 5. Ordinary member tries tagging @Bot in admin-only group -> blocked with notice
  await moderation.handleCommand({
    type: 1, isSelf: false, threadId: GROUP,
    data: { uidFrom: MEMBER, content: "@Bot alo", mentions: [{ uid: BOT, pos: 0, len: 4, type: 0 }] },
  });
  assert.match(sent.at(-1).text, /CHỈ QUẢN TRỊ VIÊN mới được trò chuyện/);

  // 6. Admin asks /ai in admin-only group -> answered normally
  await moderation.handleCommand(approval("/ai câu hỏi từ admin", ADMIN));
  assert.equal(sent.at(-1).text, "AI: câu hỏi từ admin");

  // 7. Admin unlocks chat via /mochat
  await moderation.handleCommand(approval("/mochat", ADMIN));
  assert.equal(state.isAdminOnly(GROUP), false);
  assert.equal(groupSettingsUpdated.at(-1).settings.lockSendMsg, false);
  assert.match(sent.at(-1).text, /ĐÃ MỞ CHAT NHÓM THÀNH CÔNG/);

  // 8. Ordinary member can now ask /ai
  await moderation.handleCommand(approval("/ai thành viên hỏi lại", MEMBER));
  assert.equal(sent.at(-1).text, "AI: thành viên hỏi lại");

  // 9. Admin locks chat via /khoachat
  await moderation.handleCommand(approval("/khoachat", ADMIN));
  assert.equal(state.isAdminOnly(GROUP), true);
  assert.equal(groupSettingsUpdated.at(-1).settings.lockSendMsg, true);
  assert.match(sent.at(-1).text, /ĐÃ KHÓA CHAT NHÓM THÀNH CÔNG/);

  // 10. Self-sent command (owner testing from bot account on Zalo Desktop)
  await moderation.handleCommand({
    type: 1, isSelf: true, threadId: GROUP,
    data: { uidFrom: BOT, content: "/mochat" },
  });
  assert.equal(state.isAdminOnly(GROUP), false);
  assert.equal(groupSettingsUpdated.at(-1).settings.lockSendMsg, false);
  assert.match(sent.at(-1).text, /ĐÃ MỞ CHAT NHÓM THÀNH CÔNG/);
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
  const aiService = new AIService({ apiKey: "test-key" });
  aiService.ask = async (prompt) => `Gemini trả lời cho: ${prompt}`;
  const { sent, moderation } = fixture(t, { aiService });

  // Normal question
  await moderation.handleCommand(approval("/ai thời tiết hôm nay thế nào?", MEMBER));
  assert.equal(sent.at(-1).text, "Gemini trả lời cho: thời tiết hôm nay thế nào?");

  // Rapid question within cooldown
  await moderation.handleCommand(approval("/ai câu hỏi tiếp theo?", MEMBER));
  assert.match(sent.at(-1).text, /Bạn hỏi nhanh quá/);
});

test("AIService handles Gemini API failure gracefully", async (t) => {
  const service = new AIService({ apiKey: "test-key" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    json: async () => ({ error: { message: "Internal error" } }),
  });

  try {
    const res = await service.ask("test query");
    assert.match(res, /AI đang bận một chút/);
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

test("direct message (DM) to bot only calls AI for authorized users", async (t) => {
  const aiService = new AIService({ apiKey: "sk-test-key-123456" });
  aiService.ask = async (prompt) => `DM AI: ${prompt}`;
  const { sent, moderation } = fixture(t, { aiService, aiDmUserIds: [ADMIN] });

  // 1. Unauthorized member sends regular DM -> completely ignored
  await moderation.handleCommand({
    type: 0, isSelf: false, threadId: MEMBER,
    data: { uidFrom: MEMBER, content: "Xin chào bot" },
  });
  assert.equal(sent.length, 0);

  // 2. Unauthorized member sends /ai command in DM -> gets locked message
  await moderation.handleCommand({
    type: 0, isSelf: false, threadId: MEMBER,
    data: { uidFrom: MEMBER, content: "/ai bạn là ai?" },
  });
  assert.match(sent.at(-1).text, /chỉ mở cho Quản trị viên điều hành/);

  // 3. Authorized user (ADMIN in aiDmUserIds) sends regular DM -> calls AI
  await moderation.handleCommand({
    type: 0, isSelf: false, threadId: ADMIN,
    data: { uidFrom: ADMIN, content: "Xin chào bot" },
  });
  assert.equal(sent.at(-1).text, "DM AI: Xin chào bot");
});

test("/khoaqtv and user whitelist (/themuser, /xoauser, /dsuser) blocks non-whitelisted admins", async (t) => {
  const aiService = new AIService({ apiKey: "test-key" });
  aiService.ask = async (prompt) => `AI: ${prompt}`;
  const OTHER_ADMIN_BOT = "999888";
  const { state, sent, moderation } = fixture(t, {
    aiService,
    trustedUserIds: [OWNER],
  });

  // 1. Non-operator (ordinary member or regular admin) cannot run /khoaqtv or /themuser
  await moderation.handleCommand(approval("/khoaqtv on", ADMIN));
  assert.match(sent.at(-1).text, /Chỉ Chủ sở hữu bot/);

  await moderation.handleCommand(approval("/themuser 999888", ADMIN));
  assert.match(sent.at(-1).text, /Chỉ Chủ sở hữu bot/);

  await moderation.handleCommand(approval("/dsuser", ADMIN));
  assert.match(sent.at(-1).text, /Chỉ Chủ sở hữu bot/);

  // 2. Owner enables /khoaqtv on
  await moderation.handleCommand(approval("/khoaqtv on", OWNER));
  assert.equal(state.isStrictAdminOnly(GROUP), true);
  assert.match(sent.at(-1).text, /ĐÃ BẬT KHÓA QUYỀN QTV TUYỆT ĐỐI/);

  // 3. Regular group admin (or other bot admin) tries /ai or tagging @Bot -> BLOCKED even though they are Zalo admin!
  await moderation.handleCommand(approval("/ai bot khác hỏi", ADMIN));
  assert.match(sent.at(-1).text, /KHÓA QUYỀN QTV TUYỆT ĐỐI/);

  await moderation.handleCommand({
    type: 1, isSelf: false, threadId: GROUP,
    data: { uidFrom: OTHER_ADMIN_BOT, content: "@Bot alo", mentions: [{ uid: BOT, pos: 0, len: 4, type: 0 }] },
  });
  assert.match(sent.at(-1).text, /KHÓA QUYỀN QTV TUYỆT ĐỐI/);

  // 4. Owner lists users -> empty
  await moderation.handleCommand(approval("/dsuser", OWNER));
  assert.match(sent.at(-1).text, /chưa có tài khoản nào được thêm/);

  // 5. Owner whitelists OTHER_ADMIN_BOT via /themuser
  await moderation.handleCommand(approval(`/themuser ${OTHER_ADMIN_BOT}`, OWNER));
  assert.match(sent.at(-1).text, /ĐÃ CẤP QUYỀN THÀNH CÔNG/);
  assert.equal(state.isUserAllowed(OTHER_ADMIN_BOT), true);

  // 6. Whitelisted user can now call AI in strict mode!
  await moderation.handleCommand({
    type: 1, isSelf: false, threadId: GROUP,
    data: { uidFrom: OTHER_ADMIN_BOT, content: "@Bot alo tôi là bot bạn", mentions: [{ uid: BOT, pos: 0, len: 4, type: 0 }] },
  });
  assert.equal(sent.at(-1).text, "AI: alo tôi là bot bạn");

  // 7. Owner removes user via /xoauser
  await moderation.handleCommand(approval(`/xoauser ${OTHER_ADMIN_BOT}`, OWNER));
  assert.match(sent.at(-1).text, /ĐÃ THU HỒI QUYỀN/);
  assert.equal(state.isUserAllowed(OTHER_ADMIN_BOT), false);

  // 8. Now blocked again
  await moderation.handleCommand({
    type: 1, isSelf: false, threadId: GROUP,
    data: { uidFrom: OTHER_ADMIN_BOT, content: "@Bot alo lại nè", mentions: [{ uid: BOT, pos: 0, len: 4, type: 0 }] },
  });
  assert.match(sent.at(-1).text, /KHÓA QUYỀN QTV TUYỆT ĐỐI/);

  // 9. Owner unlocks strict mode via /khoaqtv off
  await moderation.handleCommand(approval("/khoaqtv off", OWNER));
  assert.equal(state.isStrictAdminOnly(GROUP), false);
  assert.match(sent.at(-1).text, /ĐÃ TẮT KHÓA QUYỀN QTV TUYỆT ĐỐI/);
});

test("inactive stranger group is completely ignored until owner activates it via /batbot", async (t) => {
  const aiService = new AIService({ apiKey: "test-key" });
  aiService.ask = async (prompt) => `AI: ${prompt}`;
  const STRANGER_GROUP = "888888";
  const { state, sent, moderation } = fixture(t, {
    aiService,
    groupIds: [GROUP],
    trustedUserIds: [OWNER],
  });

  const initialSentCount = sent.length;

  // 1. Member in stranger group tags bot or calls /ai -> COMPLETELY IGNORED (0 replies)
  const ignoredCmd = await moderation.handleCommand({
    type: 1, isSelf: false, threadId: STRANGER_GROUP,
    data: { uidFrom: MEMBER, content: "@Bot xin chào", mentions: [{ uid: BOT, pos: 0, len: 4, type: 0 }] },
  });
  assert.equal(ignoredCmd, false);
  assert.equal(sent.length, initialSentCount);

  // 2. Regular admin in stranger group tries /status -> COMPLETELY IGNORED
  const ignoredAdmin = await moderation.handleCommand({
    type: 1, isSelf: false, threadId: STRANGER_GROUP,
    data: { uidFrom: ADMIN, content: "/status" },
  });
  assert.equal(ignoredAdmin, false);
  assert.equal(sent.length, initialSentCount);

  // 3. Owner issues /batbot in stranger group -> ACTIVATES group!
  const activated = await moderation.handleCommand({
    type: 1, isSelf: false, threadId: STRANGER_GROUP,
    data: { uidFrom: OWNER, content: "/batbot" },
  });
  assert.equal(activated, true);
  assert.match(sent.at(-1).text, /Đã KÍCH HOẠT LẠI bảo vệ nhóm 888888/);
  assert.equal(state.isGroupActive(STRANGER_GROUP), true);

  // 4. Now member in stranger group can ask AI!
  await moderation.handleCommand({
    type: 1, isSelf: false, threadId: STRANGER_GROUP,
    data: { uidFrom: MEMBER, content: "@Bot chào bạn", mentions: [{ uid: BOT, pos: 0, len: 4, type: 0 }] },
  });
  assert.equal(sent.at(-1).text, "AI: chào bạn");
});

test("/mute, /unmute, and /dsmute command flows with authorization and validation", async (t) => {
  const { state, sent, moderation } = fixture(t, {
    trustedUserIds: [OWNER],
  });

  // 1. Ordinary member cannot run /mute
  await moderation.handleCommand({
    type: 1, isSelf: false, threadId: GROUP,
    data: { uidFrom: MEMBER, content: "/mute @Admin 10m", mentions: [{ uid: ADMIN, pos: 6, len: 6, type: 0 }] },
  });
  assert.match(sent.at(-1).text, /Chỉ Quản trị viên nhóm mới có quyền/);
  assert.equal(state.isMemberMuted(GROUP, ADMIN), false);

  // 2. Admin cannot mute bot itself
  await moderation.handleCommand({
    type: 1, isSelf: false, threadId: GROUP,
    data: { uidFrom: ADMIN, content: "/mute @Bot 10m", mentions: [{ uid: BOT, pos: 6, len: 4, type: 0 }] },
  });
  assert.match(sent.at(-1).text, /Không thể cấm chat tài khoản bot/);

  // 3. Admin cannot mute another admin / owner
  await moderation.handleCommand({
    type: 1, isSelf: false, threadId: GROUP,
    data: { uidFrom: ADMIN, content: "/mute @Owner 10m", mentions: [{ uid: OWNER, pos: 6, len: 6, type: 0 }] },
  });
  assert.match(sent.at(-1).text, /Không thể cấm chat Chủ sở hữu bot/);

  // 4. Admin mutes ordinary member with custom duration (15m)
  await moderation.handleCommand({
    type: 1, isSelf: false, threadId: GROUP,
    data: { uidFrom: ADMIN, content: "/mute @Member 15m", mentions: [{ uid: MEMBER, pos: 6, len: 7, type: 0 }] },
  });
  assert.match(sent.at(-1).text, /ĐÃ CẤM CHAT \(MUTE\) THÀNH CÔNG/);
  assert.match(sent.at(-1).text, /15 phút/);
  assert.equal(state.isMemberMuted(GROUP, MEMBER), true);

  // 5. Admin views muted list via /dsmute
  await moderation.handleCommand(approval("/dsmute", ADMIN));
  assert.match(sent.at(-1).text, /DANH SÁCH THÀNH VIÊN ĐANG BỊ CẤM CHAT/);
  assert.match(sent.at(-1).text, new RegExp(MEMBER));

  // 6. Admin unmutes member via /unmute
  await moderation.handleCommand({
    type: 1, isSelf: false, threadId: GROUP,
    data: { uidFrom: ADMIN, content: "/unmute @Member", mentions: [{ uid: MEMBER, pos: 8, len: 7, type: 0 }] },
  });
  assert.match(sent.at(-1).text, /ĐÃ MỞ CHAT \(UNMUTE\) THÀNH CÔNG/);
  assert.equal(state.isMemberMuted(GROUP, MEMBER), false);

  // 7. /dsmute is now empty
  await moderation.handleCommand(approval("/dsmute", ADMIN));
  assert.match(sent.at(-1).text, /không có thành viên nào đang bị cấm chat/);

  // 8. In strict mode (/khoaqtv on), regular admin cannot mute unless whitelisted
  await moderation.handleCommand(approval("/khoaqtv on", OWNER));
  assert.equal(state.isStrictAdminOnly(GROUP), true);

  await moderation.handleCommand({
    type: 1, isSelf: false, threadId: GROUP,
    data: { uidFrom: ADMIN, content: "/mute @Member 10m", mentions: [{ uid: MEMBER, pos: 6, len: 7, type: 0 }] },
  });
  assert.match(sent.at(-1).text, /KHÓA QUYỀN QTV TUYỆT ĐỐI/);
  assert.equal(state.isMemberMuted(GROUP, MEMBER), false);

  // Owner can still mute in strict mode
  await moderation.handleCommand({
    type: 1, isSelf: false, threadId: GROUP,
    data: { uidFrom: OWNER, content: "/mute @Member 30m", mentions: [{ uid: MEMBER, pos: 6, len: 7, type: 0 }] },
  });
  assert.match(sent.at(-1).text, /ĐÃ CẤM CHAT \(MUTE\) THÀNH CÔNG/);
  assert.equal(state.isMemberMuted(GROUP, MEMBER), true);
});

test("locket gold workflow: customer registration, admin approval, rejection, and custom guide", async (t) => {
  const CUSTOMER = "888888";
  const { state, sent, moderation, api } = fixture(t, {
    trustedUserIds: [OWNER],
  });

  // 1. Customer sends 'locketgold' without slash in group
  await moderation.handleCommand({
    type: 1, isSelf: false, threadId: GROUP,
    data: { uidFrom: CUSTOMER, dName: "Khách VIP", content: "locketgold" },
  });
  assert.match(sent.at(-1).text, /Mã UID Zalo của bạn là: 888888/);
  assert.match(sent.at(-1).text, /gửi cho Shop\/Admin để được duyệt đơn/);
  const order = state.getLocketOrder(CUSTOMER);
  assert.ok(order);
  assert.equal(order.status, "pending");

  // 2. Customer sends '/locket' in private DM (ThreadType.User / 0)
  const CUSTOMER_2 = "777777";
  await moderation.handleCommand({
    type: 0, isSelf: false, threadId: CUSTOMER_2,
    data: { uidFrom: CUSTOMER_2, dName: "Khách DM", content: "/locket" },
  });
  assert.match(sent.at(-1).text, /Mã UID Zalo của bạn là: 777777/);
  assert.equal(state.getLocketOrder(CUSTOMER_2).status, "pending");

  // 3. Ordinary member cannot run /dslocket or /duyetlocket
  await moderation.handleCommand(approval("/dslocket", MEMBER));
  assert.match(sent.at(-1).text, /Chỉ Chủ sở hữu bot mới có quyền/);

  await moderation.handleCommand(approval(`/duyetlocket ${CUSTOMER}`, MEMBER));
  assert.match(sent.at(-1).text, /Chỉ Chủ sở hữu bot mới có quyền/);

  // 4. Owner lists pending orders via /dslocket
  await moderation.handleCommand(approval("/dslocket", OWNER));
  assert.match(sent.at(-1).text, /DANH SÁCH ĐƠN LOCKET GOLD ĐANG CHỜ DUYỆT \(2\)/);
  assert.match(sent.at(-1).text, new RegExp(CUSTOMER));
  assert.match(sent.at(-1).text, new RegExp(CUSTOMER_2));

  // 5. Owner approves CUSTOMER via /duyetlocket
  const prevSentCount = sent.length;
  await moderation.handleCommand(approval(`/duyetlocket ${CUSTOMER}`, OWNER));

  // Check that admin receives success reply and customer receives DM
  const adminReply = sent.find((s) => s.id === GROUP && s.text.includes("ĐÃ DUYỆT THÀNH CÔNG"));
  assert.ok(adminReply, "Admin should receive confirmation");

  const customerDM = sent.find((s) => (s.id === CUSTOMER || s.threadId === CUSTOMER) && (s.type === 0 || s.type === undefined));
  assert.ok(customerDM, "Customer should receive DM guide");
  const rawText = customerDM.text || customerDM.msg;
  const dmContent = typeof rawText === "object" ? (rawText.msg || "") : String(rawText || "");
  assert.match(dmContent, /Link cấu hình/);
  assert.match(dmContent, /SAO CHÉP link cấu hình/);
  assert.match(dmContent, /làm theo từng bước là được nhé/);
  if (typeof rawText === "object" && rawText.attachments) {
    assert.ok(rawText.attachments.length > 0, "Should attach the video file");
  }

  // Order state is now approved
  assert.equal(state.getLocketOrder(CUSTOMER).status, "approved");

  // 6. If approved customer sends 'locketgold' again, bot detects and re-sends DM guide
  await moderation.handleCommand({
    type: 1, isSelf: false, threadId: GROUP,
    data: { uidFrom: CUSTOMER, dName: "Khách VIP", content: "locketgold" },
  });
  assert.match(sent.at(-1).text, /ĐÃ ĐƯỢC DUYỆT LOCKET GOLD TRƯỚC ĐÓ/);

  // 7. Owner rejects CUSTOMER_2 via /tuchoilocket
  await moderation.handleCommand(approval(`/tuchoilocket ${CUSTOMER_2}`, OWNER));
  assert.match(sent.at(-1).text, /ĐÃ TỪ CHỐI ĐƠN LOCKET GOLD/);
  assert.equal(state.getLocketOrder(CUSTOMER_2).status, "rejected");

  // /dslocket is now empty
  await moderation.handleCommand(approval("/dslocket", OWNER));
  assert.match(sent.at(-1).text, /không có đơn nào đang chờ duyệt/);

  // 8. Customizing model file link: /setmodel, /xemmodel
  await moderation.handleCommand(approval("/setmodel https://drive.google.com/test-model.conf", OWNER));
  assert.match(sent.at(-1).text, /ĐÃ CẬP NHẬT LINK CẤU HÌNH THÀNH CÔNG/);
  assert.equal(state.getModelUrl(), "https://drive.google.com/test-model.conf");

  await moderation.handleCommand(approval("/xemmodel", OWNER));
  assert.match(sent.at(-1).text, /https:\/\/drive\.google\.com\/test-model\.conf/);

  // Reset model to default
  await moderation.handleCommand(approval("/setmodel default", OWNER));
  assert.match(sent.at(-1).text, /ĐÃ ĐẶT LẠI LINK CẤU HÌNH VỀ MẶC ĐỊNH/);
  assert.equal(state.getModelUrl(), "https://zalo-link-guard-1.onrender.com/download/model");

  // 9. Customizing video link: /setvideo, /xemvideo
  await moderation.handleCommand(approval("/setvideo https://youtu.be/custom-tutorial", OWNER));
  assert.match(sent.at(-1).text, /ĐÃ CẬP NHẬT LINK VIDEO HƯỚNG DẪN THÀNH CÔNG/);
  assert.equal(state.getVideoUrl(), "https://youtu.be/custom-tutorial");

  await moderation.handleCommand(approval("/xemvideo", OWNER));
  assert.match(sent.at(-1).text, /https:\/\/youtu\.be\/custom-tutorial/);
});
