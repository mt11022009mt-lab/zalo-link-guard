import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModerationState } from "../src/moderation-state.js";
import { createModeration, parseManualKickTarget } from "../src/moderation.js";
import { checkMessage } from "../src/policy.js";

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
  const moderation = createModeration({ api, config: { ...config, ...overrides }, state, log: logger });
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
  assert.ok(sent.some((item) => item.id === ADMIN && item.text.includes("Người gửi: @Người gửi") && !item.text.includes(`Người gửi: ${MEMBER}`)));
  const notice = sent.find((item) => item.id === GROUP && typeof item.text === "object" && item.text.msg.includes("Đã lập hồ sơ"));
  assert.ok(notice);
  assert.deepEqual(notice.text.mentions, [{
    pos: notice.text.msg.indexOf("@Người gửi"), uid: MEMBER, len: "@Người gửi".length,
  }]);

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

test("three strikes auto-kicks member when autoKick is enabled (default)", async (t) => {
  const { state, sent, kicked, moderation } = fixture(t);
  for (let id = 1; id <= 3; id++) {
    const message = linkMessage(id);
    const result = checkMessage(message, { ...config, allowedDomains: ["zalo.me"] });
    assert.ok(result);
    await moderation.onViolation(message, result);
  }
  assert.deepEqual(kicked, [{ id: MEMBER, groupId: GROUP }]);
  assert.equal(state.listViolations()[0].count, 3);
  const kickNotice = sent.find((item) => item.id === GROUP && typeof item.text === "object" && item.text.msg.includes("đã bị kick khỏi nhóm"));
  assert.ok(kickNotice);
});

test("silentModeration: true deletes and kicks silently without sending group notices", async (t) => {
  const { state, sent, kicked, moderation } = fixture(t, { silentModeration: true });
  for (let id = 1; id <= 3; id++) {
    const message = linkMessage(id);
    const result = checkMessage(message, { ...config, allowedDomains: ["zalo.me"] });
    assert.ok(result);
    await moderation.onViolation(message, result);
  }
  assert.deepEqual(kicked, [{ id: MEMBER, groupId: GROUP }]);
  assert.equal(state.listViolations()[0].count, 3);
  const notices = sent.filter((item) => item.id === GROUP && typeof item.text === "object");
  assert.equal(notices.length, 0);
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
    assert.equal(sent.at(-1).text.msg.includes(`${id}/3 lần`), true);
  }
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
  assert.equal(sent.at(-1).text.msg.includes("1/3 lần trong 12 giờ"), true);
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
