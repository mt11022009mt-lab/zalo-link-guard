const MAX_CLOCK_SKEW_MS = 10_000;

export function messageTimeMs(message) {
  const raw = Number(message?.data?.ts);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return raw < 1_000_000_000_000 ? raw * 1000 : raw;
}

export function recentGroupMessages(response, groupId, startedAt, now = Date.now()) {
  if (!Array.isArray(response?.groupMsgs)) return [];
  return response.groupMsgs
    .filter((message) => {
      const ts = messageTimeMs(message);
      return String(message.threadId) === String(groupId) && !message.isSelf &&
        ts !== null && ts >= startedAt && ts <= now + MAX_CLOCK_SKEW_MS;
    })
    .sort((a, b) => messageTimeMs(a) - messageTimeMs(b));
}

export function createHistorySweep({ api, groupIds, startedAt, processMessage, log = console, now = Date.now }) {
  let running = false;
  return async function sweepHistory() {
    if (running) return;
    running = true;
    try {
      for (const groupId of groupIds) {
        try {
          const response = await api.getGroupChatHistory(groupId, 50);
          for (const message of recentGroupMessages(response, groupId, startedAt, now())) {
            await processMessage(message, { source: "history" });
          }
        } catch (error) {
          log.error(`[KIỂM TRA LỊCH SỬ] Không đọc được nhóm ${groupId}:`, error);
        }
      }
    } finally {
      running = false;
    }
  };
}
