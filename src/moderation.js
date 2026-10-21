import { ThreadType } from "zca-js";
import { getVerifiedGroupInfo, isGroupAdmin as isAdmin } from "./group-roles.js";

export function getCommandText(message) {
  if (!message || message.isSelf || !message.data) return "";
  const data = message.data;

  // 1. Direct string content
  if (typeof data.content === "string") {
    const trimmed = data.content.trim();
    if (trimmed.startsWith("/")) return trimmed;
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        const fromObj = findSlashCommandInObject(parsed);
        if (fromObj) return fromObj;
      } catch {}
    }
  }

  // 2. Object content (e.g. chat.link, rich attachments)
  if (data.content && typeof data.content === "object") {
    const fromObj = findSlashCommandInObject(data.content);
    if (fromObj) return fromObj;
  }

  // 3. Fallback fields on message.data
  for (const key of ["msg", "caption", "description", "desc"]) {
    if (typeof data[key] === "string" && data[key].trim().startsWith("/")) {
      return data[key].trim();
    }
  }

  // 4. Params field (often JSON string)
  if (typeof data.params === "string" && data.params.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(data.params);
      const fromObj = findSlashCommandInObject(parsed);
      if (fromObj) return fromObj;
    } catch {}
  }

  return typeof data.content === "string" ? data.content.trim() : "";
}

function findSlashCommandInObject(obj) {
  if (!obj || typeof obj !== "object") return "";
  for (const key of ["description", "desc", "caption", "text", "msg", "title", "content"]) {
    const val = obj[key];
    if (typeof val === "string" && val.trim().startsWith("/")) {
      return val.trim();
    }
  }
  return "";
}


const COMMAND_RE = /^\/(kick|duyetkick|tuchoikick|vipham|tha|xoavipham|tatbot|offbot|pause|batbot|onbot|resume|botinfo|status|help|myid|ai|ask|chat|deepseek)(?:\s|$)/i;

export function parseManualTarget(message, cmd = "kick") {
  const text = message.data?.content;
  const mentions = message.data?.mentions;
  const regex = new RegExp(`^\\s*\\/${cmd}\\s+`, "i");
  if (message.type !== ThreadType.Group || typeof text !== "string" ||
      !regex.test(text) || !Array.isArray(mentions) || mentions.length !== 1) return null;
  const mention = mentions[0];
  const userId = String(mention.uid ?? "");
  if (!/^\d{5,}$/.test(userId) || mention.type === 1) return null; // Never accept @all.
  const start = Number(mention.pos);
  const length = Number(mention.len);
  if (!Number.isInteger(start) || !Number.isInteger(length) || length < 2 ||
      start < 0 || start + length > text.length ||
      text.slice(0, start).trim().toLowerCase() !== `/${cmd}` ||
      text.slice(start + length).trim() !== "") return null;
  return userId;
}

export function parseManualKickTarget(message) {
  return parseManualTarget(message, "kick");
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

export function createModeration({ api, config, state, aiService, log = console }) {
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
      log.error("Không gửi được phản hồi lệnh:", error.message);
    }
  }

  async function groupNotice(groupId, message) {
    // Đã tắt hoàn toàn tin nhắn cảnh báo tự động vào nhóm để chống Zalo chặn nick bot vì spam.
  }

  async function notifyAdmins(item) {
    if (!config.reviewGroupId) return 0;
    const summary = describeCase(item, undefined, { windowHours });
    try {
      await api.sendMessage(summary.msg, config.reviewGroupId, ThreadType.Group);
      return 1;
    } catch (error) {
      log.error("Không gửi được hồ sơ tới nhóm QTV:", error);
      return 0;
    }
  }

  async function onViolation(message, result) {
    if (!result?.links?.length) return; // Image-only deletions never increase link strikes.
    const groupId = String(message.threadId);
    const userId = String(message.data.uidFrom);
    const messageId = String(message.data.msgId);
    const displayName = message.data.dName ? safeDisplayName(message.data.dName) : undefined;
    if (config.dryRun) {
      log.info(`[XEM TRƯỚC] Sẽ ghi một vi phạm của ${userId} trong nhóm ${groupId}; chưa kick.`);
      return;
    }
    const maxViolations = config.maxViolations ?? 3;
    const autoKick = config.autoKick !== false;
    const recorded = state.recordViolation({ groupId, userId, messageId, links: result.links, displayName });
    if (recorded.duplicate) return;
    await state.flush();
    log.info(`[ĐẾM VI PHẠM ÂM THẦM] nhóm=${groupId} người_gửi=${userId} lượt=${recorded.count}/${maxViolations} trong ${windowHours} giờ`);

    // Chế độ hoàn toàn âm thầm: KHÔNG gửi bất kỳ tin cảnh báo nào vào nhóm hay DM riêng cho QTV
    if (recorded.count >= maxViolations) {
      if (autoKick) {
        try {
          const info = await groupInfo(groupId);
          validateKickTarget(info, userId);
          if (config.dryRun) {
            log.info(`[XEM TRƯỚC] Sẽ auto-kick ${userId} trong nhóm ${groupId} sau ${recorded.count} lần vi phạm.`);
          } else {
            await kickOne(userId, groupId);
            log.info(`[AUTO-KICK ÂM THẦM] Đã kick ${userId} khỏi nhóm ${groupId} sau ${recorded.count} lần vi phạm.`);
          }
          if (recorded.pendingCase) {
            state.setCaseStatus(recorded.pendingCase.id, "approved", { reviewedBy: ownId, reviewedAt: Date.now() });
            await state.flush();
          }
        } catch (error) {
          log.warn(`[AUTO-KICK THẤT BẠI] nhóm=${groupId} người_gửi=${userId}: ${error.message}; lưu hồ sơ để QTV duyệt.`);
        }
      } else if (recorded.newCase && config.reviewGroupId) {
        await notifyAdmins(recorded.pendingCase);
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
    const mentions = message.data?.mentions;
    const isGroup = message.type === ThreadType.Group;
    const senderId = String(message.data?.uidFrom || message.threadId);
    const isBotTagged = isGroup && Array.isArray(mentions) && mentions.some((m) => String(m.uid) === ownId);

    // 1. Tag @Bot trong nhóm để trò chuyện AI
    if (aiService && isBotTagged) {
      let prompt = typeof text === "string" ? text : "";
      for (const m of mentions) {
        if (String(m.uid) === ownId && typeof prompt === "string") {
          const mentionStr = prompt.slice(m.pos, m.pos + m.len);
          prompt = prompt.replace(mentionStr, "").trim();
        }
      }
      prompt = prompt.replace(/^@\S+\s*/, "").trim();
      if (!prompt) {
        await reply(message, "👋 Chào bạn! Bạn có thể hỏi mình bất cứ điều gì bằng cách tag @mình kèm câu hỏi, hoặc dùng lệnh: /ai <câu hỏi> nhé!");
        return true;
      }
      const cooldown = aiService.checkCooldown(senderId);
      if (!cooldown.allowed) {
        await reply(message, `⏳ Bạn hỏi nhanh quá, vui lòng chờ ${cooldown.waitSec} giây nhé!`);
        return true;
      }
      const senderName = message.data?.dName || "Thành viên";
      const answer = await aiService.ask(prompt, { senderName });
      await reply(message, answer);
      return true;
    }

    // 2. Nhắn tin riêng (DM) với Bot (tự động hỏi AI)
    if (aiService && !isGroup && typeof text === "string" && text.trim() && !text.trim().startsWith("/")) {
      const cooldown = aiService.checkCooldown(senderId);
      if (!cooldown.allowed) {
        await reply(message, `⏳ Bạn nhắn nhanh quá, vui lòng chờ ${cooldown.waitSec} giây nhé!`);
        return true;
      }
      const senderName = message.data?.dName || "Bạn";
      const answer = await aiService.ask(text.trim(), { senderName });
      await reply(message, answer);
      return true;
    }

    if (!text) return false;
    const matched = text.match(COMMAND_RE);
    if (!matched) return false;
    const command = matched[1].toLowerCase();

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

    if (command === "tha" || command === "xoavipham") {
      const groupId = String(message.threadId);
      const targetId = parseManualTarget(message, "tha") || parseManualTarget(message, "xoavipham");
      if (!config.groupIds.includes(groupId) || !targetId) {
        await reply(message, "Cú pháp: /tha @thành_viên (tag đúng một người trong nhóm để xóa lịch sử vi phạm).");
        return true;
      }
      try {
        const info = await groupInfo(groupId);
        if (!isAdmin(info, senderId)) throw new Error("Chỉ QTV nhóm mới được dùng lệnh này.");
        const count = state.clearViolations(groupId, targetId);
        await state.flush();
        await reply(message, `Đã xóa lịch sử vi phạm cho thành viên ${targetId} (${count} lượt vi phạm đã được hủy).`);
      } catch (error) {
        await reply(message, `Không thực hiện được: ${error.message}`);
      }
      return true;
    }

    if (["tatbot", "offbot", "pause"].includes(command)) {
      let targetGroupId = String(message.threadId);
      const isGroup = message.type === ThreadType.Group;
      if (!isGroup) {
        const parts = text.split(/\s+/);
        if (parts[1] && /^\d+$/.test(parts[1].trim())) {
          targetGroupId = parts[1].trim();
        } else if (config.groupIds.length === 1) {
          targetGroupId = config.groupIds[0];
        } else {
          await reply(message, "Cú pháp trong tin nhắn riêng: /tatbot <Mã_Nhóm>");
          return true;
        }
      }

      try {
        const isOperator = Array.isArray(config.trustedUserIds) && config.trustedUserIds.includes(senderId);
        if (!isOperator) {
          const info = await groupInfo(targetGroupId);
          if (!isAdmin(info, senderId)) throw new Error("Chỉ QTV nhóm mới có quyền tắt bot.");
        }
        state.disableGroup(targetGroupId);
        await state.flush();
        await reply(message, `⏸️ Đã TẠM DỪNG bảo vệ nhóm ${targetGroupId}.\nBot sẽ không xóa ảnh, link hay kick thành viên cho đến khi bật lại bằng lệnh /batbot.`);
      } catch (error) {
        await reply(message, `Không tắt được bot: ${error.message}`);
      }
      return true;
    }

    if (["batbot", "onbot", "resume"].includes(command)) {
      let targetGroupId = String(message.threadId);
      const isGroup = message.type === ThreadType.Group;
      if (!isGroup) {
        const parts = text.split(/\s+/);
        if (parts[1] && /^\d+$/.test(parts[1].trim())) {
          targetGroupId = parts[1].trim();
        } else if (config.groupIds.length === 1) {
          targetGroupId = config.groupIds[0];
        } else {
          await reply(message, "Cú pháp trong tin nhắn riêng: /batbot <Mã_Nhóm>");
          return true;
        }
      }

      try {
        const isOperator = Array.isArray(config.trustedUserIds) && config.trustedUserIds.includes(senderId);
        if (!isOperator) {
          const info = await groupInfo(targetGroupId);
          if (!isAdmin(info, senderId)) throw new Error("Chỉ QTV nhóm mới có quyền bật bot.");
        }
        state.enableGroup(targetGroupId);
        await state.flush();
        await reply(message, `▶️ Đã KÍCH HOẠT LẠI bảo vệ nhóm ${targetGroupId}.\nBot sẽ tiếp tục xóa link, chặn ảnh spam và đếm vi phạm.`);
      } catch (error) {
        await reply(message, `Không bật được bot: ${error.message}`);
      }
      return true;
    }

    if (["ai", "ask", "chat", "deepseek"].includes(command)) {
      const prompt = text.replace(COMMAND_RE, "").trim();
      if (!prompt) {
        await reply(message, "💡 Cú pháp: /ai <câu hỏi của bạn>\nVí dụ: /ai giải thích hiện tượng nhật thực");
        return true;
      }
      if (!aiService) {
        await reply(message, "🤖 Module AI chưa được khởi tạo trên hệ thống.");
        return true;
      }
      const cooldown = aiService.checkCooldown(senderId);
      if (!cooldown.allowed) {
        await reply(message, `⏳ Bạn hỏi nhanh quá, vui lòng chờ ${cooldown.waitSec} giây nữa nhé!`);
        return true;
      }
      const senderName = message.data?.dName || "Thành viên";
      const answer = await aiService.ask(prompt, { senderName });
      await reply(message, answer);
      return true;
    }

    if (command === "botinfo" || command === "status") {
      const isGroup = message.type === ThreadType.Group;
      const targetGid = String(message.threadId);
      const isPaused = isGroup && Boolean(state?.isGroupDisabled?.(targetGid));
      const groupLine = isGroup
        ? `\n- Bảo vệ nhóm này: ${isPaused ? "⏸️ ĐANG TẮT (/batbot để bật lại)" : "🟢 ĐANG BẬT (/tatbot để tạm tắt)"}`
        : "";
      const aiStatus = aiService?.isConfigured?.() ? "🟢 ĐÃ KÍCH HOẠT (DeepSeek)" : "⚪ Chưa cấu hình DEEPSEEK_API_KEY";
      await reply(message, `🛡️ ZALO LINK GUARD BOT (v2.1.0)\n- Trạng thái tổng: Đang hoạt động${groupLine}\n- Trợ lý AI DeepSeek: ${aiStatus}\n- Nhóm đang quản lý: ${config.groupIds.length} nhóm\n- Lọc link không phép: BẬT\n- Chặn ảnh & Album spam: ${config.blockImages !== false ? "BẬT" : "TẮT"}\n- Tự động kick vi phạm: ${config.autoKick !== false ? `BẬT (${config.maxViolations ?? 3} lần/${config.violationWindowHours ?? 24}h)` : "TẮT"}\n- Chế độ im lặng: ${config.silentModeration ? "BẬT (100% Silent)" : "TẮT"}`);
      return true;
    }

    if (command === "help") {
      await reply(message, `📖 CÁC LỆNH QUẢN TRỊ VIÊN & TIỆN ÍCH:\n- /ai <câu hỏi> : Trò chuyện siêu tốc với AI DeepSeek (hoặc tag @bot trong nhóm).\n- /tatbot : Tạm dừng bảo vệ nhóm này (dừng xóa tin/ảnh & kick).\n- /batbot : Kích hoạt lại bảo vệ nhóm.\n- /vipham : Xem danh sách thành viên vi phạm trong nhóm.\n- /kick @tên : Kick trực tiếp thành viên vi phạm khỏi nhóm.\n- /tha @tên : Xóa điểm vi phạm cho thành viên (hoặc /xoavipham @tên).\n- /status : Xem trạng thái hoạt động của bot.\n- /myid : Xem UID Zalo của bạn.`);
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
