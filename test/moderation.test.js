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
  const state = new ModerationState(join(directory, "state.json"), { now: () => 1_000_000_000 });
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

test("four zalo.me messages create a review case; only a live admin approval kicks one member", async (t) => {
  const { state, sent, kicked, moderation } = fixture(t, { allowedDomains: ["zalo.me"] });
  let lastMessage;
  let lastResult;
  for (let id = 1; id <= 4; id++) {
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
  assert.equal(pending[0].evidence.length, 4);
  assert.equal(pending[0].displayName, "Người gửi");
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
