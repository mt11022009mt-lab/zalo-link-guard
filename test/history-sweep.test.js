import test from "node:test";
import assert from "node:assert/strict";
import { createGroupHistoryReader, createHistorySweep, recentGroupMessages } from "../src/history-sweep.js";

const startedAt = 1_700_000_000_000;
const message = (id, ts, extras = {}) => ({
  type: 1, threadId: "group-1", isSelf: false,
  data: { msgId: id, ts: String(ts), content: "https://zalo.me/g/abc" },
  ...extras,
});

test("history sweep selects only new group messages and keeps their order", () => {
  const result = recentGroupMessages({ groupMsgs: [
    message("later", (startedAt + 20_000) / 1000),
    message("old", (startedAt - 60_000) / 1000),
    message("just-before-start", (startedAt - 1000) / 1000),
    message("self", (startedAt + 1000) / 1000, { isSelf: true }),
    message("other", (startedAt + 1000) / 1000, { threadId: "group-2" }),
    message("missing-ts", ""),
    message("first", (startedAt + 1000) / 1000),
  ] }, "group-1", startedAt, startedAt + 30_000);
  assert.deepEqual(result.map((entry) => entry.data.msgId), ["first", "later"]);
});

test("history sweep reads at most 50 messages per group and passes history source", async () => {
  const calls = [];
  const processed = [];
  const sweep = createHistorySweep({
    api: { getGroupChatHistory: async (id, count) => {
      calls.push({ id, count });
      return { groupMsgs: [message(`${id}-one`, (startedAt + 1000) / 1000, { threadId: id })] };
    } },
    groupIds: ["group-1", "group-2"], startedAt,
    now: () => startedAt + 10_000,
    processMessage: async (entry, options) => { processed.push([entry.data.msgId, options.source]); },
  });
  await sweep();
  assert.deepEqual(calls, [
    { id: "group-1", count: 50 }, { id: "group-2", count: 50 },
  ]);
  assert.deepEqual(processed, [
    ["group-1-one", "history"], ["group-2-one", "history"],
  ]);
});

test("history reader falls back from 404 to cloud history and normalizes messages", async () => {
  let oldCalls = 0;
  let encoded;
  const logs = [];
  const api = {
    zpwServiceMap: { group_cloud_message: ["https://cloud.example"] },
    getGroupChatHistory: async () => { oldCalls++; throw new Error("Request failed with status code 404"); },
    custom(name, callback) {
      this[name] = (props) => callback({
        ctx: { imei: "test-imei", uid: "self-id" }, props,
        utils: {
          encodeAES: (value) => { encoded = JSON.parse(value); return "encrypted"; },
          makeURL: (url) => url,
          request: async () => ({}),
          resolve: (_response, transform) => transform({
            data: { groupMsgs: [
              { msgId: "one", uidFrom: "member", ts: String((startedAt + 1000) / 1000) },
              { msgId: "self", uidFrom: "0", ts: String((startedAt + 2000) / 1000) },
            ] },
          }),
        },
      });
    },
  };
  const read = createGroupHistoryReader(api, { warn: (line) => logs.push(line) });
  const first = await read("group-1", 50);
  const second = await read("group-1", 50);
  assert.equal(oldCalls, 1);
  assert.equal(encoded.imei, "test-imei");
  assert.equal(encoded.count, 50);
  assert.equal(first.groupMsgs[0].threadId, "group-1");
  assert.equal(first.groupMsgs[1].isSelf, true);
  assert.deepEqual(recentGroupMessages(second, "group-1", startedAt, startedAt + 3000)
    .map((entry) => entry.data.msgId), ["one"]);
  assert.equal(logs.length, 1);
});
