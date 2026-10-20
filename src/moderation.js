import { ThreadType } from "zca-js";

const COMMAND_RE = /^\/(kick|duyetkick|tuchoikick|vipham)(?:\s|$)/i;

export function parseManualKickTarget(message) {
  const text = message.data?.content;
  const mentions = message.data?.mentions;
  if (message.type !== ThreadType.Group || typeof text !== "string" ||
      !/^\s*\/kick\s+/i.test(text) || !Array.isArray(mentions) || mentions.length !== 1) return null;
  const mention = mentions[0];
  const userId = String(mention.uid ?? "");
  if (!/^\d{5,}$/.test(userId) || mention.type === 1) return null; // Never accept @all.
  const start = Number(mention.pos);
  const length = Number(mention.len);
  if (!Number.isInteger(start) || !Number.isInteger(length) || length < 2 ||
      start < 0 || start + length > text.length ||
      text.slice(0, start).trim().toLowerCase() !== "/kick" ||
      text.slice(start + length).trim() !== "") return null;
  return userId;
}

function isAdmin(info, userId) {
  return String(info.creatorId) === String(userId) ||
    (info.adminIds ?? []).some((id) => String(id) === String(userId));
}

function safeDisplayName(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().replace(/^@+/, "").slice(0, 60) || "Thành viên";
}

function caseDisplayName(item, info) {
  const member = info?.currentMems?.find((person) => String(person.id) === String(item.userId));
  return safeDisplayName(item.displayName || member?.dName || member?.zaloName);
}

function describeCase(item, info, { compact = false } = {}) {
  const mentionText = `@${caseDisplayName(item, info)}`;
  const prefix = compact
    ? `#${item.id} | Nhóm ${item.groupId} | `
    : `HỒ SƠ VI PHẠM #${item.id}\nNhóm: ${item.groupId}\nNgười gửi: `;
  const mention = { pos: prefix.length, uid: String(item.userId), len: mentionText.length };
  if (compact) {
    return { msg: `${prefix}${mentionText} | ${item.evidence.length} lần | /duyetkick ${item.id} | /tuchoikick ${item.id}`, mention };
  }
  const evidence = item.evidence.map((entry, index) => {
    const time = new Date(entry.at).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
    return `${index + 1}. ${time} | tin ${entry.messageId} | ${entry.links.join(", ")}`;
  }).join("\n");
  return {
    msg: `${prefix}${mentionText}\n${item.evidence.length} lần gửi link bị cấm trong 24 giờ:\n${evidence}\n\nDuyệt kick: /duyetkick ${item.id}\nTừ chối: /tuchoikick ${item.id}\nBot KHÔNG tự kick khi chưa được duyệt.`,
    mention,
  };
}

function combineCases(entries) {
  let msg = "";
  const mentions = [];
  for (const entry of entries) {
    if (msg) msg += "\n\n";
    const offset = msg.length;
    msg += entry.msg;
    mentions.push({ ...entry.mention, pos: offset + entry.mention.pos });
  }
  return { msg, mentions };
}

export function createModeration({ api, config, state, log = console }) {
  const ownId = String(api.getOwnId());
  const kicksInFlight = new Set();

  async function groupInfo(groupId) {
    const result = await api.getGroupInfo(groupId);
    const info = result.gridInfoMap?.[groupId];
    if (!info || !info.creatorId || !Array.isArray(info.adminIds)) {
      throw new Error("Không xác minh được quản trị viên của nhóm trên Zalo.");
    }
    return info;
  }

  async function reply(message, text) {
    try {
      await api.sendMessage(text, message.threadId, message.type);
    } catch (error) {
      log.error("Không gửi được phản hồi lệnh:", error);
    }
  }

  async function groupNotice(groupId, message) {
    try {
      await api.sendMessage(message, groupId, ThreadType.Group);
    } catch (error) {
      log.error("Không gửi được thông báo vào nhóm:", error);
    }
  }

  async function notifyAdmins(item) {
    const summary = describeCase(item);
    let sent = 0;
    if (config.reviewGroupId) {
      try {
        await api.sendMessage(summary.msg, config.reviewGroupId, ThreadType.Group);
        sent++;
      } catch (error) {
        log.error("Không gửi được hồ sơ tới nhóm QTV:", error);
      }
    }
    let info;
    try {
      info = await groupInfo(item.groupId);
    } catch (error) {
      log.error("Không xác minh được QTV để gửi hồ sơ:", error);
      return sent;
    }
    const admins = [...new Set([info.creatorId, ...info.adminIds].map(String))]
      .filter((id) => id !== ownId);
    for (const adminId of admins) {
      if (item.notifiedIds.includes(adminId)) continue;
      try {
        await api.sendMessage(summary.msg, adminId, ThreadType.User);
        state.markNotified(item.id, adminId);
        sent++;
      } catch (error) {
        log.error(`Không gửi được hồ sơ riêng tới QTV ${adminId}:`, error);
      }
    }
    return sent;
  }

  async function onViolation(message, result) {
    const groupId = String(message.threadId);
    const userId = String(message.data.uidFrom);
    const messageId = String(message.data.msgId);
    const displayName = message.data.dName ? safeDisplayName(message.data.dName) : undefined;
    const mentionText = `@${displayName ?? "Thành viên"}`;
    if (config.dryRun) {
      log.info(`[XEM TRƯỚC] Sẽ ghi một vi phạm của ${userId} trong nhóm ${groupId}; chưa gửi cảnh báo hoặc kick.`);
      return;
    }
    const recorded = state.recordViolation({ groupId, userId, messageId, links: result.links, displayName });
    if (recorded.duplicate) return;
    if (recorded.count <= 3) {
      const prefix = "⚠️ ";
      await groupNotice(groupId, {
        msg: `${prefix}${mentionText} đã gửi link không được phép ${recorded.count}/3 lần trong 24 giờ. Lần tiếp theo sẽ chuyển hồ sơ cho QTV duyệt kick.`,
        mentions: [{ pos: prefix.length, uid: userId, len: mentionText.length }],
      });
    } else if (recorded.newCase) {
      const sent = await notifyAdmins(recorded.pendingCase);
      const prefix = `⚠️ Đã lập hồ sơ #${recorded.pendingCase.id} cho `;
      await groupNotice(groupId, {
        msg: `${prefix}${mentionText} sau ${recorded.count} lần gửi link. QTV sẽ duyệt trước khi kick.${sent ? "" : " Chưa gửi được hồ sơ riêng cho QTV; kiểm tra quyền nhắn tin hoặc nhóm duyệt."}`,
        mentions: [{ pos: prefix.length, uid: userId, len: mentionText.length }],
      });
    }
  }

  function validateKickTarget(info, userId) {
    if (userId === ownId || isAdmin(info, userId) || config.trustedUserIds.includes(userId)) {
      throw new Error("Không kick tài khoản bot, QTV hoặc người trong danh sách tin cậy.");
    }
  }

  async function kickOne(userId, groupId) {
    const key = `${groupId}:${userId}`;
    if (kicksInFlight.has(key)) throw new Error("Đã có lệnh kick đang chạy cho thành viên này.");
    kicksInFlight.add(key);
    try {
      const result = await api.removeUserFromGroup(userId, groupId); // Always one scalar user ID.
      if (!Array.isArray(result?.errorMembers)) throw new Error("Zalo không xác nhận rõ kết quả kick.");
      if (result.errorMembers.length) throw new Error(`Zalo không kick được ID ${result.errorMembers.join(", ")}`);
    } finally {
      kicksInFlight.delete(key);
    }
  }

  async function handleCommand(message) {
    if (message.isSelf || typeof message.data?.content !== "string") return false;
    const text = message.data.content.trim();
    const matched = text.match(COMMAND_RE);
    if (!matched) return false;
    const command = matched[1].toLowerCase();
    const senderId = String(message.data.uidFrom);

    if (command === "kick") {
      const groupId = String(message.threadId);
      const targetId = parseManualKickTarget(message);
      if (!config.groupIds.includes(groupId) || !targetId) {
        await reply(message, "Cú pháp: /kick @một_người (tag đúng một thành viên trong nhóm được bot quản lý).");
        return true;
      }
      try {
        const info = await groupInfo(groupId);
        if (!isAdmin(info, senderId) || !isAdmin(info, ownId)) throw new Error("Chỉ QTV nhóm có bot làm QTV mới được dùng lệnh này.");
        validateKickTarget(info, targetId);
        if (config.dryRun) {
          await reply(message, `[XEM TRƯỚC] QTV ${senderId} yêu cầu kick ${targetId}; dryRun=true nên chưa thực hiện.`);
          return true;
        }
        const actionId = state.startManualKick({ groupId, userId: targetId, adminId: senderId });
        try {
          await kickOne(targetId, groupId);
        } catch (error) {
          state.finishManualKick(actionId, { success: false, error: error.message });
          throw error;
        }
        try {
          state.finishManualKick(actionId, { success: true });
        } catch (error) {
          log.error("Zalo đã xác nhận kick nhưng không lưu được trạng thái:", error);
          await reply(message, `Zalo đã xác nhận kick ${targetId}, nhưng bot chưa lưu được trạng thái. Kiểm tra thành viên nhóm và file trạng thái trước khi ra lệnh tiếp.`);
          return true;
        }
        await reply(message, `Đã kick thành viên ${targetId} theo lệnh của QTV ${senderId}.`);
      } catch (error) {
        await reply(message, `Không kick: ${error.message}`);
      }
      return true;
    }

    if (command === "vipham") {
      const pending = state.listPending();
      const visible = [];
      for (const item of pending) {
        try {
          const info = await groupInfo(item.groupId);
          if (isAdmin(info, senderId)) visible.push({ item, info });
        } catch (error) {
          log.error("Không kiểm tra được quyền QTV khi liệt kê hồ sơ:", error);
        }
      }
      if (!visible.length) {
        await reply(message, "Không có hồ sơ chờ duyệt mà bạn có quyền xem.");
        return true;
      }
      const inOriginalGroup = message.type === ThreadType.Group && config.groupIds.includes(String(message.threadId));
      const selected = inOriginalGroup
        ? visible.filter(({ item }) => item.groupId === String(message.threadId)).slice(0, 10)
        : visible.slice(0, 10);
      if (!selected.length) {
        await reply(message, "Nhóm này không có hồ sơ chờ duyệt.");
        return true;
      }
      const summary = combineCases(selected.map(({ item, info }) => describeCase(item, info, { compact: inOriginalGroup })));
      try {
        if (inOriginalGroup) {
          await api.sendMessage(summary, message.threadId, ThreadType.Group);
        } else {
          await api.sendMessage(summary.msg, senderId, ThreadType.User);
          await reply(message, `Đã gửi riêng ${selected.length} hồ sơ chờ duyệt cho QTV.`);
        }
      } catch (error) {
        log.error("Không gửi được danh sách vi phạm riêng:", error);
        await reply(message, inOriginalGroup
          ? "Không gửi được danh sách có tag vào nhóm. Hãy kiểm tra quyền nhắn tin của bot."
          : "Không gửi được danh sách riêng. Hãy kiểm tra quyền nhắn tin với tài khoản bot.");
      }
      return true;
    }

    const caseId = text.slice(matched[0].length).trim().toUpperCase();
    if (!/^[A-F0-9]{8}$/.test(caseId)) {
      await reply(message, `Cú pháp: /${command} MA_HO_SO`);
      return true;
    }
    const item = state.getCase(caseId);
    if (!item || item.status !== "pending") {
      await reply(message, "Hồ sơ không tồn tại, đã hết hạn hoặc đã được xử lý.");
      return true;
    }
    if (message.type === ThreadType.Group && message.threadId !== item.groupId && message.threadId !== config.reviewGroupId) {
      await reply(message, "Hãy duyệt trong nhóm gốc, nhóm QTV hoặc nhắn riêng cho bot.");
      return true;
    }
    try {
      const info = await groupInfo(item.groupId);
      if (!isAdmin(info, senderId) || !isAdmin(info, ownId)) throw new Error("Chỉ QTV nhóm có bot làm QTV mới được duyệt.");
      if (command === "tuchoikick") {
        state.setCaseStatus(caseId, "rejected", { reviewedBy: senderId, reviewedAt: Date.now() });
        await reply(message, `Đã từ chối hồ sơ #${caseId}; bộ đếm vi phạm của thành viên được đặt lại.`);
        return true;
      }
      validateKickTarget(info, item.userId);
      if (item.evidence.length < 4) throw new Error("Hồ sơ thiếu ít nhất 4 lần vi phạm.");
      if (config.dryRun) {
        await reply(message, `[XEM TRƯỚC] Hồ sơ #${caseId} đủ điều kiện nhưng dryRun=true; chưa kick.`);
        return true;
      }
      if (state.getCase(caseId)?.status !== "pending") {
        throw new Error("Hồ sơ đã được QTV khác xử lý.");
      }
      state.setCaseStatus(caseId, "executing", { reviewedBy: senderId, reviewedAt: Date.now() });
      try {
        await kickOne(item.userId, item.groupId);
      } catch (error) {
        state.setCaseStatus(caseId, "pending", { lastError: error.message });
        throw error;
      }
      try {
        state.setCaseStatus(caseId, "kicked");
      } catch (error) {
        log.error("Zalo đã xác nhận kick nhưng không lưu được hồ sơ:", error);
        await reply(message, `Zalo đã xác nhận kick thành viên ${item.userId}, nhưng bot chưa lưu được hồ sơ #${caseId}. Kiểm tra trạng thái nhóm trước khi duyệt lại.`);
        return true;
      }
      await reply(message, `Đã kick thành viên ${item.userId} theo hồ sơ #${caseId}, QTV ${senderId} duyệt.`);
    } catch (error) {
      await reply(message, `Không xử lý hồ sơ #${caseId}: ${error.message}`);
    }
    return true;
  }

  return { handleCommand, onViolation };
}
