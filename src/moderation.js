import { ThreadType } from "zca-js";
import { getVerifiedGroupInfo, isGroupAdmin as isAdmin } from "./group-roles.js";
import { getCommandText } from "./broadcaster.js";

const COMMAND_RE = /^\/(kick|duyetkick|tuchoikick|vipham|myid)(?:\s|$)/i;

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

function safeDisplayName(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().replace(/^@+/, "").slice(0, 60) || "Thành viên";
}

function caseDisplayName(item, info) {
  const member = info?.currentMems?.find((person) => String(person.id) === String(item.userId));
  return safeDisplayName(item.displayName || member?.dName || member?.zaloName);
}

function describeCase(item, info, { compact = false, windowHours = 24 } = {}) {
  const mentionText = `@${caseDisplayName(item, info)}`;
  const prefix = compact
    ? `#${item.id} | Nhóm ${item.groupId} | `
    : `HỒ SƠ VI PHẠM #${item.id}\nNhóm: ${item.groupId}\nNgười gửi: `;
  const mention = { pos: prefix.length, uid: String(item.userId), len: mentionText.length };
  if (compact) {
    return { msg: `${prefix}${mentionText} | hồ sơ ${item.evidence.length} tin | /duyetkick ${item.id} | /tuchoikick ${item.id}`, mention };
  }
  const evidence = item.evidence.map((entry, index) => {
    const time = new Date(entry.at).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
    return `${index + 1}. ${time} | tin ${entry.messageId} | ${entry.links.join(", ")}`;
  }).join("\n");
  return {
    msg: `${prefix}${mentionText}\n${item.evidence.length} lần gửi link bị cấm trong ${windowHours} giờ:\n${evidence}\n\nDuyệt kick: /duyetkick ${item.id}\nTừ chối: /tuchoikick ${item.id}\nBot KHÔNG tự kick khi chưa được duyệt.`,
    mention,
  };
}

function describeViolation(entry, info, { compact = false, windowHours = 24 } = {}) {
  if (entry.pendingCase) {
    const described = describeCase({ ...entry.pendingCase, displayName: entry.displayName || entry.pendingCase.displayName }, info, { compact, windowHours });
    described.msg += compact
      ? ` | hiện còn ${entry.count} lần trong ${windowHours} giờ`
      : `\nHiện còn ${entry.count} lần trong ${windowHours} giờ.`;
    return described;
  }
  const mentionText = `@${caseDisplayName(entry, info)}`;
  const prefix = compact
    ? `Nhóm ${entry.groupId} | `
    : `Nhóm: ${entry.groupId}\nNgười gửi: `;
  const mention = { pos: prefix.length, uid: String(entry.userId), len: mentionText.length };
  const status = `${entry.count}/3 lần trong ${windowHours} giờ; chưa có hồ sơ chờ duyệt`;
  return { msg: compact ? `${prefix}${mentionText} | ${status}` : `${prefix}${mentionText}\n${status}`, mention };
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
  const windowHours = config.violationWindowHours ?? 24;

  async function groupInfo(groupId) {
    return getVerifiedGroupInfo(api, groupId);
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
    const summary = describeCase(item, undefined, { windowHours });
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
        await state.flush();
        sent++;
      } catch (error) {
        log.error(`Không gửi được hồ sơ riêng tới QTV ${adminId}:`, error);
      }
    }
    return sent;
  }

  async function onViolation(message, result) {
    if (!result?.links?.length) return; // Image-only deletions never increase link strikes.
    const groupId = String(message.threadId);
    const userId = String(message.data.uidFrom);
    const messageId = String(message.data.msgId);
    const displayName = message.data.dName ? safeDisplayName(message.data.dName) : undefined;
    const mentionText = `@${displayName ?? "Thành viên"}`;
    if (config.dryRun) {
      log.info(`[XEM TRƯỚC] Sẽ ghi một vi phạm của ${userId} trong nhóm ${groupId}; chưa gửi cảnh báo hoặc kick.`);
      return;
    }
    const maxViolations = config.maxViolations ?? 3;
    const autoKick = config.autoKick !== false;
    const recorded = state.recordViolation({ groupId, userId, messageId, links: result.links, displayName });
    if (recorded.duplicate) return;
    await state.flush();
    log.info(`[ĐẾM VI PHẠM] nhóm=${groupId} người_gửi=${userId} lượt=${recorded.count}/${maxViolations} trong ${windowHours} giờ`);
    const isSilent = config.silentModeration === true;
    if (recorded.count < maxViolations) {
      if (!isSilent) {
        const prefix = "⚠️ ";
        await groupNotice(groupId, {
          msg: `${prefix}${mentionText} đã gửi link không được phép ${recorded.count}/${maxViolations} lần trong ${windowHours} giờ. Đến lần thứ ${maxViolations} bot sẽ ${autoKick ? "kick khỏi nhóm" : "chuyển hồ sơ cho QTV duyệt kick"}.`,
          mentions: [{ pos: prefix.length, uid: userId, len: mentionText.length }],
        });
      }
    } else {
      let kickedDirectly = false;
      if (autoKick) {
        try {
          const info = await groupInfo(groupId);
          validateKickTarget(info, userId);
          if (config.dryRun) {
            log.info(`[XEM TRƯỚC] Sẽ auto-kick ${userId} trong nhóm ${groupId} sau ${recorded.count} lần vi phạm.`);
            kickedDirectly = true;
          } else {
            await kickOne(userId, groupId);
            kickedDirectly = true;
            log.info(`[AUTO-KICK] Đã kick ${userId} khỏi nhóm ${groupId} sau ${recorded.count} lần vi phạm.`);
          }
        } catch (error) {
          log.warn(`[AUTO-KICK THẤT BẠI] nhóm=${groupId} người_gửi=${userId}: ${error.message}; chuyển sang lập hồ sơ QTV duyệt.`);
        }

        if (kickedDirectly) {
          if (!isSilent) {
            const prefix = "⛔ ";
            await groupNotice(groupId, {
              msg: `${prefix}${mentionText} đã bị kick khỏi nhóm do vi phạm gửi link ${recorded.count}/${maxViolations} lần trong ${windowHours} giờ.`,
              mentions: [{ pos: prefix.length, uid: userId, len: mentionText.length }],
            });
          }
          if (recorded.pendingCase) {
            state.setCaseStatus(recorded.pendingCase.id, "approved", { reviewedBy: ownId, reviewedAt: Date.now() });
            await state.flush();
          }
          return;
        }
      }

      if (recorded.newCase) {
        const sent = await notifyAdmins(recorded.pendingCase);
        if (!isSilent) {
          const prefix = `⚠️ Đã lập hồ sơ #${recorded.pendingCase.id} cho `;
          await groupNotice(groupId, {
            msg: `${prefix}${mentionText} sau ${recorded.count} lần gửi link. QTV sẽ duyệt trước khi kick.${sent ? "" : " Chưa gửi được hồ sơ riêng cho QTV; kiểm tra quyền nhắn tin hoặc nhóm duyệt."}`,
            mentions: [{ pos: prefix.length, uid: userId, len: mentionText.length }],
          });
        }
      }
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
    const text = getCommandText(message);
    if (!text) return false;
    const matched = text.match(COMMAND_RE);
    if (!matched) return false;
    const command = matched[1].toLowerCase();
    const senderId = String(message.data?.uidFrom || message.threadId);

    if (command === "myid") {
      await reply(message, `UID Zalo của bạn là: ${senderId}`);
      return true;
    }

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
        await state.flush();
        try {
          await kickOne(targetId, groupId);
        } catch (error) {
          state.finishManualKick(actionId, { success: false, error: error.message });
          await state.flush();
          throw error;
        }
        try {
          state.finishManualKick(actionId, { success: true });
          await state.flush();
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
      const inOriginalGroup = message.type === ThreadType.Group && config.groupIds.includes(String(message.threadId));
      const groupsToCheck = inOriginalGroup ? [String(message.threadId)] : config.groupIds;
      const authorized = new Map();
      let failedChecks = 0;
      for (const groupId of groupsToCheck) {
        try {
          const info = await groupInfo(groupId);
          if (isAdmin(info, senderId)) authorized.set(groupId, info);
        } catch (error) {
          failedChecks++;
          log.error(`Không kiểm tra được quyền QTV của nhóm ${groupId} khi liệt kê vi phạm:`, error);
        }
      }
      if (!authorized.size) {
        await reply(message, failedChecks
          ? "Không xác minh được quyền QTV trên Zalo. Kiểm tra kết nối và thử lại."
          : "Chỉ QTV của nhóm được bot quản lý mới xem được danh sách vi phạm.");
        return true;
      }
      const selected = state.listViolations()
        .filter((entry) => authorized.has(entry.groupId))
        .slice(0, 10);
      if (!selected.length) {
        await reply(message, `Chưa có lần gửi link bị cấm nào còn hiệu lực trong ${windowHours} giờ ở nhóm bạn quản lý.`);
        return true;
      }
      const summary = combineCases(selected.map((entry) => describeViolation(entry, authorized.get(entry.groupId), { compact: inOriginalGroup, windowHours })));
      try {
        if (inOriginalGroup) {
          await api.sendMessage(summary, message.threadId, ThreadType.Group);
        } else {
          await api.sendMessage(summary.msg, senderId, ThreadType.User);
          await reply(message, `Đã gửi riêng ${selected.length} thành viên có vi phạm còn hiệu lực cho QTV.`);
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
        await state.flush();
        await reply(message, `Đã từ chối hồ sơ #${caseId}; bộ đếm vi phạm của thành viên được đặt lại.`);
        return true;
      }
      validateKickTarget(info, item.userId);
      const requiredCount = config.maxViolations ?? 3;
      if (item.evidence.length < requiredCount) throw new Error(`Hồ sơ thiếu ít nhất ${requiredCount} lần vi phạm.`);
      if (config.dryRun) {
        await reply(message, `[XEM TRƯỚC] Hồ sơ #${caseId} đủ điều kiện nhưng dryRun=true; chưa kick.`);
        return true;
      }
      if (state.getCase(caseId)?.status !== "pending") {
        throw new Error("Hồ sơ đã được QTV khác xử lý.");
      }
      state.setCaseStatus(caseId, "executing", { reviewedBy: senderId, reviewedAt: Date.now() });
      await state.flush();
      try {
        await kickOne(item.userId, item.groupId);
      } catch (error) {
        state.setCaseStatus(caseId, "pending", { lastError: error.message });
        await state.flush();
        throw error;
      }
      try {
        state.setCaseStatus(caseId, "kicked");
        await state.flush();
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
