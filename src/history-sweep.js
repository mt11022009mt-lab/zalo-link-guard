const MAX_CLOCK_SKEW_MS = 10_000;

// zca-js 2.2.0 still calls /api/group/history, which Zalo can return 404 for.
// Its custom API hook lets us use the cloud history endpoint without editing
// node_modules or replacing the library used for the rest of the bot.
export function createGroupHistoryReader(api, log = console) {
  let useCloudHistory = false;
  let cloudRegistered = false;

  function registerCloudHistory() {
    if (cloudRegistered) return;
    api.custom("linkGuardGetRecentGroupHistory", async ({ ctx, utils, props }) => {
      const groupId = String(props.groupId).replace(/^g(?=\d)/, "");
      const endpoint = api.zpwServiceMap?.group_cloud_message?.[0];
      if (!endpoint) throw new Error("Phiên Zalo không có máy chủ lịch sử nhóm cloud.");
      const params = {
        groupId, globalMsgId: 0, count: props.count,
        msgIds: [], imei: ctx.imei, src: 3,
      };
      const encrypted = utils.encodeAES(JSON.stringify(params));
      if (!encrypted) throw new Error("Không mã hóa được yêu cầu lịch sử nhóm.");
      const serviceURL = utils.makeURL(`${endpoint}/api/cm/getrecentv2`);
      const response = await utils.request(utils.makeURL(serviceURL, { params: encrypted, nretry: 0 }), {
        method: "GET",
      });
      return utils.resolve(response, (result) => {
        const data = typeof result.data === "string" ? JSON.parse(result.data) : result.data;
        if (!Array.isArray(data?.groupMsgs)) throw new Error("Zalo không trả danh sách tin nhắn nhóm.");
        return {
          ...data,
          groupMsgs: data.groupMsgs.map((raw) => {
            const messageData = { ...raw };
            const isSelf = String(messageData.uidFrom) === "0" || String(messageData.uidFrom) === String(ctx.uid);
            if (String(messageData.uidFrom) === "0") messageData.uidFrom = String(ctx.uid);
            return { type: 1, threadId: String(props.groupId), isSelf, data: messageData };
          }),
        };
      });
    });
    cloudRegistered = true;
  }

  return async function readGroupHistory(groupId, count) {
    if (!useCloudHistory) {
      try {
        return await api.getGroupChatHistory(groupId, count);
      } catch (error) {
        if (!/\b404\b/.test(String(error?.message))) throw error;
        useCloudHistory = true;
        log.warn("[KIỂM TRA LỊCH SỬ] API lịch sử cũ trả 404; chuyển sang lịch sử nhóm cloud.");
      }
    }
    registerCloudHistory();
    return api.linkGuardGetRecentGroupHistory({ groupId, count });
  };
}

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

export function createHistorySweep({ api, groupIds, startedAt, processMessage, log = console, now = Date.now,
  readGroupHistory = createGroupHistoryReader(api, log) }) {
  let running = false;
  return async function sweepHistory() {
    if (running) return;
    running = true;
    try {
      for (const groupId of groupIds) {
        try {
          const response = await readGroupHistory(groupId, 50);
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
