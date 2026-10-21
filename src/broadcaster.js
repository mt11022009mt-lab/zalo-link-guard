import { ThreadType } from "zca-js";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractMessageLinks, isZaloGroupInvite } from "./policy.js";
import { createGroupHistoryReader } from "./history-sweep.js";

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

export function parseSpinText(template, randomFn = Math.random) {
  if (typeof template !== "string") return "";
  return template.replace(/\{([^{}]+)\}/g, (match, choices) => {
    if (!choices.includes("|")) return match;
    const parts = choices.split("|").map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return match;
    const index = Math.floor(randomFn() * parts.length);
    return parts[index] ?? match;
  });
}

export function formatBroadcastMessage(template, url, randomFn = Math.random) {
  let content = parseSpinText(template, randomFn);
  if (content.includes("{link}")) {
    content = content.replace(/\{link\}/g, url);
  } else if (!content.includes(url)) {
    content = `${content}\n${url}`;
  }
  return content.trim();
}

export class BroadcastStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = {
      version: 1,
      targetGroups: [],
      joinedLinks: [],
      campaign: null,
      dailyCounter: { date: new Date().toISOString().slice(0, 10), count: 0 },
    };
    this.load();
  }

  load() {
    if (this.filePath && existsSync(this.filePath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
        if (parsed && typeof parsed === "object") {
          this.data = { ...this.data, ...parsed };
        }
      } catch {
        // Fallback to fresh defaults
      }
    }
  }

  save() {
    if (!this.filePath) return;
    try {
      const tempPath = `${this.filePath}.tmp`;
      writeFileSync(tempPath, JSON.stringify(this.data, null, 2), "utf8");
      renameSync(tempPath, this.filePath);
    } catch {
      // Ephemeral disk or permission fallback
    }
  }
}

export function createBroadcaster({
  api,
  config,
  filePath = resolve(process.cwd(), "broadcast-state.json"),
  clock = () => Date.now(),
  randomFn = Math.random,
  log = console,
}) {
  const store = new BroadcastStore(filePath);

  // Khởi tạo danh sách nhóm mục tiêu ban đầu từ config nếu chưa có
  const configuredTargets = config.broadcast?.initialGroupIds || config.groupIds || [];
  for (const gid of configuredTargets) {
    const sId = String(gid);
    if (!store.data.targetGroups.includes(sId)) {
      store.data.targetGroups.push(sId);
    }
  }
  store.save();

  const getOperatorIds = () => {
    const list = config.broadcastOperatorIds ||
      config.broadcast?.operatorIds ||
      config.trustedUserIds || [];
    return new Set(list.map(String));
  };

  const isOperator = (userId) => getOperatorIds().has(String(userId));

  async function notifyOperators(text) {
    if (!text || typeof api?.sendMessage !== "function") return;
    const operatorIds = Array.from(getOperatorIds());
    for (const opId of operatorIds) {
      try {
        await api.sendMessage(text, opId, ThreadType.User);
      } catch (err) {
        log.warn(`[THÔNG BÁO OPERATOR] Không gửi được tin cho ${opId}:`, err.message);
      }
    }
  }

  const joinQueue = [];
  let isJoining = false;
  let lastJoinAt = 0;

  function queueGroupInvite(url) {
    if (!url || typeof url !== "string") return false;
    const cleanUrl = url.trim().replace(/[.,!?;:)}\]]+$/u, "");
    if (store.data.joinedLinks.includes(cleanUrl)) return false;
    if (joinQueue.includes(cleanUrl)) return false;
    joinQueue.push(cleanUrl);
    log.info(`[HÀNG ĐỢI VÀO NHÓM] Đã nhận link: ${cleanUrl} (đang chờ: ${joinQueue.length})`);
    return true;
  }

  async function stepJoinWorker() {
    if (isJoining || !joinQueue.length) return;
    const now = clock();
    const joinCooldown = (config.broadcast?.joinDelaySeconds ?? 30) * 1000;
    if (now - lastJoinAt < joinCooldown) return;

    const link = joinQueue.shift();
    isJoining = true;
    lastJoinAt = clock();

    try {
      log.info(`[TỰ ĐỘNG VÀO NHÓM] Đang thử tham gia: ${link}`);
      if (typeof api.joinGroupLink === "function") {
        await api.joinGroupLink(link);
      }
      store.data.joinedLinks.push(link);

      let newlyAddedGid = null;
      let newlyAddedName = "";
      try {
        if (typeof api.getAllGroups === "function") {
          const groups = await api.getAllGroups();
          const ids = Object.keys(groups.gridVerMap || {});
          for (const gid of ids) {
            if (!store.data.targetGroups.includes(gid)) {
              store.data.targetGroups.push(gid);
              newlyAddedGid = gid;
              log.info(`[VÀO NHÓM THÀNH CÔNG] Đã thêm nhóm mới ${gid} vào danh sách mục tiêu rải link!`);
              if (store.data.campaign && store.data.campaign.status === "running") {
                const inCampaign = store.data.campaign.items.some((it) => it.groupId === gid);
                if (!inCampaign) {
                  store.data.campaign.items.push({ groupId: gid, status: "queued", attempts: 0 });
                  log.info(`[CHIẾN DỊCH] Đã nối nhóm mới ${gid} vào hàng đợi chiến dịch hiện tại.`);
                }
              }
            }
          }
          if (newlyAddedGid && typeof api.getGroupInfo === "function") {
            try {
              const info = await api.getGroupInfo([newlyAddedGid]);
              newlyAddedName = info?.gridInfoMap?.[newlyAddedGid]?.name || "";
            } catch {}
          }
        }
      } catch (e) {
        log.warn("[VÀO NHÓM] Không cập nhật được danh sách nhóm sau khi join:", e.message);
      }
      store.save();

      // BÁO CÁO NGAY CHO TÀI KHOẢN ĐIỀU HÀNH
      const notifyLines = [
        "🎉 [BOT ĐÃ TỰ ĐỘNG VÀO NHÓM MỚI]",
        newlyAddedName ? `- Tên nhóm: ${newlyAddedName}` : null,
        newlyAddedGid ? `- ID nhóm: ${newlyAddedGid}` : null,
        `- Link nhóm: ${link}`,
        `- Đã nạp vào danh sách mục tiêu rải link! (Tổng: ${store.data.targetGroups.length} nhóm)`,
      ].filter(Boolean);
      await notifyOperators(notifyLines.join("\n"));

    } catch (err) {
      log.warn(`[VÀO NHÓM THẤT BẠI] ${link}: ${err.message}`);
      const errStr = String(err.message || "");
      const isAlreadyMember = err.code === 178 || errStr.includes("178");
      const isApprovalRequired = err.code === 240 || errStr.includes("240");

      if (isAlreadyMember) {
        store.data.joinedLinks.push(link);
        store.save();
      } else if (isApprovalRequired) {
        store.data.joinedLinks.push(link);
        store.save();
        await notifyOperators(
          `⏳ [CHỜ DUYỆT VÀO NHÓM]\n- Link: ${link}\n- Nhóm này bật chế độ phê duyệt. Bot đã gửi yêu cầu tham gia và đang đợi QTV duyệt.`
        );
      }
    } finally {
      isJoining = false;
    }
  }

  let isSending = false;
  async function stepBroadcastWorker() {
    if (isSending) return;
    const campaign = store.data.campaign;
    if (!campaign || campaign.status !== "running") return;

    const item = campaign.items.find((it) => it.status === "queued");
    if (!item) {
      campaign.status = "done";
      log.info(`[RẢI LINK] Hoàn tất chiến dịch #${campaign.id}! Tất cả các nhóm đã được gửi.`);
      store.save();
      const sentCount = campaign.items.filter((it) => it.status === "sent" || it.status === "simulated").length;
      await notifyOperators(
        `🏁 [HOÀN TẤT CHIẾN DỊCH RẢI LINK]\n- Chiến dịch #${campaign.id} đã hoàn tất!\n- Đã gửi thành công: ${sentCount} nhóm\n- Số tin hôm nay: ${store.data.dailyCounter.count}/${config.broadcast?.maxSendsPerDay ?? 30}`
      );
      return;
    }

    const now = clock();
    if (campaign.nextSendAt && now < campaign.nextSendAt) return;

    const today = new Date(now).toISOString().slice(0, 10);
    if (store.data.dailyCounter.date !== today) {
      store.data.dailyCounter = { date: today, count: 0 };
    }
    const maxSendsPerDay = config.broadcast?.maxSendsPerDay ?? 30;
    if (store.data.dailyCounter.count >= maxSendsPerDay) {
      log.warn(`[RẢI LINK] Đã đạt giới hạn an toàn ${maxSendsPerDay} tin/ngày. Tạm dừng chiến dịch đến ngày mai.`);
      campaign.status = "paused_daily_limit";
      store.save();
      return;
    }

    isSending = true;
    item.status = "sending";
    item.attempts = (item.attempts || 0) + 1;
    store.save();

    const minDelay = config.broadcast?.minDelaySeconds ?? 60;
    const maxDelay = config.broadcast?.maxDelaySeconds ?? 180;
    const nextIntervalSec = Math.floor(minDelay + randomFn() * (maxDelay - minDelay + 1));

    try {
      const messageContent = formatBroadcastMessage(campaign.template, campaign.url, randomFn);
      const dryRun = config.broadcast?.dryRun ?? config.dryRun ?? false;
      if (dryRun) {
        log.info(`[XEM TRƯỚC RẢI LINK] dryRun=true | Nhóm ${item.groupId}:\n${messageContent}`);
        item.status = "simulated";
      } else {
        await api.sendMessage(messageContent, item.groupId, ThreadType.Group);
        item.status = "sent";
        item.sentAt = new Date(now).toISOString();
        store.data.dailyCounter.count++;
        log.info(`[ĐÃ GỬI RẢI LINK] Nhóm ${item.groupId} thành công. Nghỉ ${nextIntervalSec}s trước nhóm tiếp theo.`);
      }
    } catch (err) {
      log.error(`[LỖI GỬI RẢI LINK] Nhóm ${item.groupId}:`, err.message);
      item.status = "failed";
      item.lastError = err.message;
    } finally {
      campaign.nextSendAt = clock() + nextIntervalSec * 1000;
      store.save();
      isSending = false;
    }
  }

  const joinTimer = setInterval(() => void stepJoinWorker(), 15_000);
  joinTimer.unref();

  const broadcastTimer = setInterval(() => void stepBroadcastWorker(), 5_000);
  broadcastTimer.unref();

  let isScanning = false;
  async function syncAllExistingGroups() {
    if (!api || typeof api.getAllGroups !== "function") return store.data.targetGroups;
    try {
      const groups = await api.getAllGroups();
      const ids = Object.keys(groups.gridVerMap || {});
      let added = 0;
      for (const gid of ids) {
        const sId = String(gid);
        if (!store.data.targetGroups.includes(sId)) {
          store.data.targetGroups.push(sId);
          added++;
        }
      }
      if (added > 0) {
        store.save();
        log.info(`[ĐỒNG BỘ NHÓM] Đã nạp ${added} nhóm hiện có vào danh sách mục tiêu rải link (tổng: ${store.data.targetGroups.length}).`);
      }
      return store.data.targetGroups;
    } catch (err) {
      log.warn("[ĐỒNG BỘ NHÓM] Lỗi lấy danh sách nhóm:", err.message);
      return store.data.targetGroups;
    }
  }

  async function scanAllGroupsForInvites(historyReaderOverride) {
    if (isScanning) return { inProgress: true };
    isScanning = true;
    try {
      await syncAllExistingGroups();
      const groupIds = [...store.data.targetGroups];
      if (!groupIds.length) {
        return { totalGroups: 0, linksFound: 0, queueLength: joinQueue.length, targetGroupsCount: 0 };
      }

      const historyReader = historyReaderOverride || createGroupHistoryReader(api, log);
      let linksFound = 0;

      for (const gid of groupIds) {
        try {
          const res = await historyReader(gid, 50);
          const msgs = res?.groupMsgs || [];
          for (const msg of msgs) {
            const links = extractMessageLinks(msg);
            for (const item of links) {
              if (isZaloGroupInvite(item)) {
                if (queueGroupInvite(item.url)) {
                  linksFound++;
                }
              }
            }
          }
        } catch (err) {
          log.warn(`[QUÉT LỊCH SỬ] Nhóm ${gid}: ${err.message}`);
        }
      }

      return {
        totalGroups: groupIds.length,
        linksFound,
        queueLength: joinQueue.length,
        targetGroupsCount: store.data.targetGroups.length,
      };
    } finally {
      isScanning = false;
    }
  }

  async function handleCommand(message) {
    const text = getCommandText(message);
    if (!text) return false;
    const senderId = String(message.data?.uidFrom || message.threadId);

    if (/^\/myid(?:\s|$)/i.test(text)) {
      await api.sendMessage(`UID Zalo của bạn là: ${senderId}`, message.threadId, message.type);
      return true;
    }

    const match = text.match(/^\/(railink|stoprai|joinnhom|trangthairai|themtarget|quetnhom|quetlink|danhsachnhom)(?:\s+([\s\S]*))?$/i);
    if (!match) return false;

    if (!isOperator(senderId)) {
      if (message.type === ThreadType.User) {
        await api.sendMessage("Bạn không có quyền sử dụng các lệnh rải link của bot.", senderId, ThreadType.User);
      }
      return true;
    }

    const command = match[1].toLowerCase();
    const arg = (match[2] || "").trim();

    if (command === "railink") {
      const parts = arg.split(/\s+/);
      const url = parts[0];
      const template = parts.slice(1).join(" ").trim();
      if (!url || !/^https?:\/\//i.test(url) || !template) {
        await api.sendMessage(
          "Cú pháp: /railink <URL> <mẫu nội dung spin>\nVí dụ: /railink https://zalo.me/g/abc {Chào cả nhà|Xin chào anh em}, tham gia nhóm mới nhé!\n(Hoặc đơn giản: /railink https://zalo.me/g/abc Vào nhóm nhé)",
          message.threadId, message.type
        );
        return true;
      }

      if (store.data.campaign && store.data.campaign.status === "running") {
        await api.sendMessage(
          `Đang có chiến dịch #${store.data.campaign.id} đang chạy. Hãy gõ /stoprai trước khi tạo chiến dịch mới.`,
          message.threadId, message.type
        );
        return true;
      }

      await syncAllExistingGroups();

      if (!store.data.targetGroups.length) {
        await api.sendMessage(
          "⚠️ Chưa có nhóm mục tiêu nào để rải link! Hãy gõ /quetnhom để bot tự tìm nhóm từ các box bot đang tham gia.",
          message.threadId, message.type
        );
        return true;
      }

      const campaignId = `C${Date.now().toString(36).toUpperCase()}`;
      const items = store.data.targetGroups.map((gid) => ({
        groupId: gid,
        status: "queued",
        attempts: 0,
      }));

      store.data.campaign = {
        id: campaignId,
        url,
        template,
        operatorId: senderId,
        status: "running",
        createdAt: new Date().toISOString(),
        nextSendAt: clock(),
        items,
      };
      store.save();

      const preview = formatBroadcastMessage(template, url, randomFn);
      await api.sendMessage(
        `🚀 Đã khởi tạo chiến dịch rải link #${campaignId}!\n- Tổng nhóm mục tiêu: ${items.length} nhóm\n- Giãn cách an toàn: ${config.broadcast?.minDelaySeconds ?? 60}s - ${config.broadcast?.maxDelaySeconds ?? 180}s\n- Mẫu xem trước:\n"${preview}"\n\nBot đang tiến hành rải lác đác từng nhóm...`,
        message.threadId, message.type
      );
      return true;
    }

    if (command === "stoprai") {
      if (!store.data.campaign || store.data.campaign.status !== "running") {
        await api.sendMessage("Hiện không có chiến dịch rải link nào đang chạy.", message.threadId, message.type);
        return true;
      }
      store.data.campaign.status = "stopped";
      store.save();
      const sentCount = store.data.campaign.items.filter((it) => it.status === "sent" || it.status === "simulated").length;
      const queuedCount = store.data.campaign.items.filter((it) => it.status === "queued").length;
      await api.sendMessage(
        `⏹️ Đã dừng chiến dịch #${store.data.campaign.id}.\n- Đã gửi: ${sentCount} nhóm\n- Đã hủy: ${queuedCount} nhóm`,
        message.threadId, message.type
      );
      return true;
    }

    if (command === "joinnhom") {
      if (!arg || !/zalo\.me\/g\//i.test(arg)) {
        await api.sendMessage("Cú pháp: /joinnhom https://zalo.me/g/xxxxxx", message.threadId, message.type);
        return true;
      }
      const queued = queueGroupInvite(arg);
      if (queued) {
        await api.sendMessage("✅ Đã thêm link nhóm vào hàng đợi tham gia. Bot sẽ tự động join sau ít phút.", message.threadId, message.type);
      } else {
        await api.sendMessage("Link nhóm này đã được xử lý hoặc đã có sẵn trong hàng đợi.", message.threadId, message.type);
      }
      return true;
    }

    if (command === "themtarget") {
      if (!arg) {
        await api.sendMessage("Cú pháp: /themtarget ID_NHOM", message.threadId, message.type);
        return true;
      }
      if (!store.data.targetGroups.includes(arg)) {
        store.data.targetGroups.push(arg);
        store.save();
        await api.sendMessage(`✅ Đã thêm nhóm ${arg} vào danh sách nhận link (Tổng: ${store.data.targetGroups.length} nhóm).`, message.threadId, message.type);
      } else {
        await api.sendMessage(`Nhóm ${arg} đã có trong danh sách nhận link.`, message.threadId, message.type);
      }
      return true;
    }

    if (command === "quetnhom" || command === "quetlink") {
      await api.sendMessage("🔍 Đang bắt đầu quét tin nhắn trong tất cả các nhóm bot đang tham gia để tìm link mời nhóm mới...", message.threadId, message.type);
      const res = await scanAllGroupsForInvites();
      if (res.inProgress) {
        await api.sendMessage("Tiến trình quét nhóm đang chạy, vui lòng chờ trong giây lát.", message.threadId, message.type);
        return true;
      }
      await api.sendMessage(
        `✅ Đã quét xong ${res.totalGroups} nhóm!\n` +
        `- Tìm thấy: ${res.linksFound} link mời nhóm mới\n` +
        `- Hàng đợi chờ tự động vào nhóm: ${res.queueLength} link (tự join mỗi 30s)\n` +
        `- Tổng nhóm mục tiêu rải link hiện có: ${res.targetGroupsCount} nhóm`,
        message.threadId, message.type
      );
      return true;
    }

    if (command === "danhsachnhom") {
      await syncAllExistingGroups();
      const list = store.data.targetGroups;
      await api.sendMessage(
        `📋 DANH SÁCH NHÓM MỤC TIÊU (${list.length} nhóm):\n${list.slice(0, 20).map((id, idx) => `${idx + 1}. ID: ${id}`).join("\n")}${list.length > 20 ? `\n... và còn ${list.length - 20} nhóm khác.` : ""}`,
        message.threadId, message.type
      );
      return true;
    }

    if (command === "trangthairai") {
      const camp = store.data.campaign;
      const totalGroups = store.data.targetGroups.length;
      const todayCount = store.data.dailyCounter?.count ?? 0;
      let textRes = `📊 TRẠNG THÁI RẢI LINK:\n- Tổng nhóm mục tiêu: ${totalGroups} nhóm\n- Số tin đã gửi hôm nay: ${todayCount}/${config.broadcast?.maxSendsPerDay ?? 30}\n- Hàng đợi join nhóm: ${joinQueue.length} link đang chờ\n`;
      if (!camp || camp.status === "stopped" || camp.status === "done") {
        textRes += "- Chiến dịch: Không có chiến dịch nào đang chạy.";
      } else {
        const sent = camp.items.filter((it) => it.status === "sent" || it.status === "simulated").length;
        const queued = camp.items.filter((it) => it.status === "queued").length;
        const failed = camp.items.filter((it) => it.status === "failed").length;
        const remainingSeconds = Math.max(0, Math.round(((camp.nextSendAt || clock()) - clock()) / 1000));
        textRes += `- Chiến dịch #${camp.id}: ${camp.status.toUpperCase()}\n- Tiến độ: ${sent}/${camp.items.length} nhóm (Chờ: ${queued}, Lỗi: ${failed})\n- Gửi nhóm kế tiếp sau: ${remainingSeconds} giây`;
      }
      await api.sendMessage(textRes, message.threadId, message.type);
      return true;
    }

    return false;
  }

  function inspectMessageForInvites(message) {
    if (message?.isSelf) return;
    const links = extractMessageLinks(message);
    for (const link of links) {
      if (isZaloGroupInvite(link)) {
        queueGroupInvite(link.url);
      }
    }
  }

  return {
    handleCommand,
    inspectMessageForInvites,
    queueGroupInvite,
    joinQueue,
    store,
    stepJoinWorker,
    stepBroadcastWorker,
    syncAllExistingGroups,
    scanAllGroupsForInvites,
    close: () => {
      clearInterval(joinTimer);
      clearInterval(broadcastTimer);
    },
  };
}
