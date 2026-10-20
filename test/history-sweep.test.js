import test from "node:test";
import assert from "node:assert/strict";
import { createHistorySweep, recentGroupMessages } from "../src/history-sweep.js";

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
