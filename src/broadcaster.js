import { ThreadType } from "zca-js";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractMessageLinks, isZaloGroupInvite } from "./policy.js";
import { createGroupHistoryReader } from "./history-sweep.js";
import { getCommandText } from "./moderation.js";

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
  if (url) {
    if (content.includes("{link}")) {
      content = content.replace(/\{link\}/g, url);
    } else if (!content.includes(url)) {
      content = `${content}\n${url}`;
    }
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
      dailyJoins: { date: new Date().toISOString().slice(0, 10), count: 0 },
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
        // Fallback to defaults
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
      // Ephemeral disk fallback
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

  // Nạp danh sách nhóm mục tiêu ban đầu từ config nếu có
  const initialTargets = config.broadcast?.initialGroupIds || [];
  for (const gid of initialTargets) {
    const sId = String(gid);
    if (!store.data.targetGroups.includes(sId)) {
      store.data.targetGroups.push(sId);
    }
  }
  store.save();

  const getOperatorIds = () => {
    const ownId = typeof api.getOwnId === "function" ? String(api.getOwnId()) : String(api.ctx?.uid || "");
    const list = [
      ownId,
      ...(config.trustedUserIds || []),
      ...(config.broadcast?.operatorIds || []),
      ...(config.broadcastOperatorIds || []),
    ].filter(Boolean).map(String);
    return new Set(list);
  };

  const isOperator = (userId) => getOperatorIds().has(String(userId));

  async function reply(message, text) {
    try {
      await api.sendMessage(text, message.threadId, message.type);
    } catch (err) {
      log.error?.("[BROADCASTER] Không gửi được phản hồi:", err.message);
    }
  }

  async function notifyOperators(text) {
    if (!text || typeof api?.sendMessage !== "function") return;
    const opIds = Array.from(getOperatorIds()).filter((id) => {
      const ownId = typeof api.getOwnId === "function" ? String(api.getOwnId()) : String(api.ctx?.uid || "");
      return id !== ownId; // Không tự gửi DM cho chính nick bot
    });
    for (const opId of opIds) {
      try {
        await api.sendMessage(text, opId, ThreadType.User);
      } catch (err) {
        log.warn?.(`[THÔNG BÁO OPERATOR] Không gửi được tin cho ${opId}:`, err.message);
      }
    }
  }

  const joinQueue = [];

  function getMaxSendsPerDay() {
    if (store.data.customMaxSends && Number.isInteger(store.data.customMaxSends) && store.data.customMaxSends > 0) {
      return store.data.customMaxSends;
    }
    const envVal = Number.parseInt(process.env.MAX_SENDS_PER_DAY || process.env.BROADCAST_MAX_SENDS_PER_DAY, 10);
    if (Number.isInteger(envVal) && envVal > 0) return envVal;
    return config.broadcast?.maxSendsPerDay ?? 100;
  }

  function queueGroupInvite(url) {
    return false;
  }

  async function syncAllExistingGroups() {
    if (!api || typeof api.getAllGroups !== "function") return store.data.targetGroups;
    try {
      const groups = await api.getAllGroups();
      const ids = Object.keys(groups?.gridVerMap || {});
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
        log.info?.(`[ĐỒNG BỘ NHÓM] Đã nạp ${added} nhóm mới bạn vừa tham gia vào danh sách mục tiêu rải link (tổng: ${store.data.targetGroups.length}).`);
      }
      return store.data.targetGroups;
    } catch (err) {
      log.warn?.("[ĐỒNG BỘ NHÓM] Lỗi lấy danh sách nhóm:", err.message);
      return store.data.targetGroups;
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
      log.info?.(`[RẢI LINK] Hoàn tất chiến dịch #${campaign.id}! Tất cả các nhóm đã được gửi.`);
      store.save();
      const sentCount = campaign.items.filter((it) => it.status === "sent" || it.status === "simulated").length;
      await notifyOperators(
        `🏁 [HOÀN TẤT CHIẾN DỊCH RẢI LINK]\n- Chiến dịch #${campaign.id} đã hoàn tất!\n- Đã gửi thành công: ${sentCount} nhóm\n- Số tin hôm nay: ${store.data.dailyCounter.count}/${getMaxSendsPerDay()}`
      );
      return;
    }

    const now = clock();
    if (campaign.nextSendAt && now < campaign.nextSendAt) return;

    const today = new Date(now).toISOString().slice(0, 10);
    if (!store.data.dailyCounter || store.data.dailyCounter.date !== today) {
      store.data.dailyCounter = { date: today, count: 0 };
    }
    const maxSendsPerDay = getMaxSendsPerDay();
    if (store.data.dailyCounter.count >= maxSendsPerDay) {
      log.warn?.(`[RẢI LINK] Đã đạt giới hạn an toàn ${maxSendsPerDay} tin/ngày. Tạm dừng chiến dịch đến ngày mai.`);
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
      const dryRun = Boolean(config.broadcast?.dryRun ?? config.dryRun ?? false);
      if (dryRun) {
        log.info?.(`[XEM TRƯỚC RẢI LINK] dryRun=true | Nhóm ${item.groupId}:\n${messageContent}`);
        item.status = "simulated";
      } else {
        await api.sendMessage(messageContent, item.groupId, ThreadType.Group);
        item.status = "sent";
        item.sentAt = new Date(now).toISOString();
        store.data.dailyCounter.count++;
        log.info?.(`[ĐÃ GỬI RẢI LINK] Nhóm ${item.groupId} thành công. Nghỉ ${nextIntervalSec}s trước nhóm tiếp theo.`);
      }
    } catch (err) {
      log.error?.(`[LỖI GỬI RẢI LINK] Nhóm ${item.groupId}:`, err.message);
      item.status = "failed";
      item.lastError = err.message;

      const errStr = String(err.message || "").toLowerCase();
      const isLocked = err.code === 166 || err.code === 178 ||
        /quyen|quyền|permission|lock|khóa|khoa|chỉ trưởng|chi truong/i.test(errStr);
      if (isLocked) {
        log.warn?.(`[TỰ RỜI NHÓM] Nhóm ${item.groupId} không có quyền gửi tin. Đang tự rời nhóm...`);
        if (typeof api.leaveGroup === "function") {
          try { await api.leaveGroup(item.groupId, true); } catch {}
        }
        store.data.targetGroups = store.data.targetGroups.filter((g) => g !== item.groupId);
      }

      const isRateLimited = err.code === 123 || err.code === 216 || err.code === 221 ||
        /giới hạn|gioi han|limit|quá nhanh|qua nhanh|tạm thời|tam thoi/i.test(errStr);
      if (isRateLimited) {
        log.warn?.(`[TẠM NGHỈ RẢI LINK] Zalo giới hạn tương tác (${err.message}). Tạm ngưng rải link 30 phút để bảo vệ nick.`);
        campaign.nextSendAt = clock() + 30 * 60 * 1000;
        store.save();
        isSending = false;
        return;
      }
    } finally {
      campaign.nextSendAt = clock() + nextIntervalSec * 1000;
      store.save();
      isSending = false;
    }
  }

  const broadcastTimer = setInterval(() => void stepBroadcastWorker(), 5_000);
  broadcastTimer.unref();

  let isScanning = false;
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
          log.warn?.(`[QUÉT LỊCH SỬ] Nhóm ${gid}:`, err.message);
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

  async function filterAndLeaveLockedGroups() {
    if (typeof api.getGroupInfo !== "function") {
      return { totalChecked: 0, leftGroups: [] };
    }
    const ownId = typeof api.getOwnId === "function" ? String(api.getOwnId()) : String(api.ctx?.uid || "");
    const targets = [...store.data.targetGroups];
    const leftGroups = [];

    for (const gid of targets) {
      try {
        const info = await api.getGroupInfo([gid]);
        const groupData = info?.gridInfoMap?.[gid];
        if (!groupData) continue;
        const isOwnAdmin = (
          String(groupData.creatorId) === ownId ||
          (Array.isArray(groupData.adminIds) && groupData.adminIds.some((id) => String(id) === ownId))
        );
        const isChatLocked = groupData?.setting?.lockSendMsg === 1;

        if (isChatLocked && !isOwnAdmin) {
          const gName = groupData.name || gid;
          log.info?.(`[LỌC NHÓM] Nhóm ${gid} (${gName}) khóa chat. Đang tự rời...`);
          if (typeof api.leaveGroup === "function") {
            try { await api.leaveGroup(gid, true); } catch {}
          }
          store.data.targetGroups = store.data.targetGroups.filter((g) => g !== gid);
          if (store.data.campaign && store.data.campaign.status === "running") {
            store.data.campaign.items = store.data.campaign.items.filter((it) => it.groupId !== gid);
          }
          leftGroups.push({ id: gid, name: gName });
        }
      } catch (err) {
        log.warn?.(`[LỌC NHÓM] Lỗi kiểm tra nhóm ${gid}:`, err.message);
      }
    }

    if (leftGroups.length > 0) store.save();
    return { totalChecked: targets.length, leftGroups, remainingTargets: store.data.targetGroups.length };
  }

  async function handleCommand(message) {
    const text = getCommandText(message);
    if (!text) return false;
    const ownId = typeof api.getOwnId === "function" ? String(api.getOwnId()) : String(api.ctx?.uid || "");
    const senderId = String(message.data?.uidFrom || (message.isSelf ? ownId : message.threadId));

    const match = text.match(/^\/(railink|stoprai|joinnhom|trangthairai|themtarget|xoatarget|quetnhom|quetlink|danhsachnhom|dsnhom|locnhom|donnhom|gioihanrai|limitrai|setlimit)(?:\s+([\s\S]*))?$/i);
    if (!match) return false;

    if (!isOperator(senderId)) {
      log.warn?.(`[BROADCAST TRUY CẬP] Người dùng ${senderId} không có quyền chạy lệnh rải link.`);
      if (message.type === ThreadType.User) {
        await reply(message, "🔒 Bạn không có quyền sử dụng các lệnh rải link của bot.");
      }
      return true;
    }

    const command = match[1].toLowerCase();
    const arg = (match[2] || "").trim();
    log.info?.(`[LỆNH RẢI LINK] Lệnh="/${command}" | Người_gửi=${senderId} | Tham_số="${arg}"`);

    if (command === "railink") {
      const parts = arg.split(/\s+/);
      const url = parts[0];
      const template = parts.slice(1).join(" ").trim();
      if (!url || !/^https?:\/\//i.test(url)) {
        await reply(message,
          "💡 Cú pháp: /railink <URL> [mẫu nội dung spin]\n" +
          "Ví dụ:\n" +
          "/railink https://zalo.me/g/abc {Xin chào|Chào anh em}, mời tham gia nhóm mới nhé!\n" +
          "Hoặc đơn giản: /railink https://zalo.me/g/abc Tham gia nhóm nhé"
        );
        return true;
      }

      if (store.data.campaign && store.data.campaign.status === "running") {
        await reply(message,
          `⚠️ Đang có chiến dịch rải link #${store.data.campaign.id} đang chạy dở.\n` +
          "👉 Gõ /stoprai nếu bạn muốn hủy chiến dịch cũ trước khi tạo chiến dịch mới."
        );
        return true;
      }

      await syncAllExistingGroups();

      if (!store.data.targetGroups.length) {
        await reply(message,
          "⚠️ Chưa có nhóm mục tiêu nào trong danh sách nhận link!\n" +
          "👉 Hãy gõ /quetnhom để bot tự tìm nhóm từ các box bot đang tham gia, hoặc thêm bằng lệnh: /themtarget <Mã_Nhóm>."
        );
        return true;
      }

      const campaignId = `C${Date.now().toString(36).toUpperCase()}`;
      const items = store.data.targetGroups.map((gid) => ({
        groupId: gid,
        status: "queued",
        attempts: 0,
      }));

      const finalTemplate = template || "{Xin chào cả nhà|Chào anh em}, tham gia nhóm giao lưu cùng nhé!";
      store.data.campaign = {
        id: campaignId,
        url,
        template: finalTemplate,
        operatorId: senderId,
        status: "running",
        createdAt: new Date().toISOString(),
        nextSendAt: clock(),
        items,
      };
      store.save();

      const preview = formatBroadcastMessage(finalTemplate, url, randomFn);
      const minDelay = config.broadcast?.minDelaySeconds ?? 60;
      const maxDelay = config.broadcast?.maxDelaySeconds ?? 180;
      await reply(message,
        `🚀 ĐÃ KHỞI TẠO CHIẾN DỊCH RẢI LINK #${campaignId}!\n` +
        `- Tổng số nhóm nhận: ${items.length} nhóm\n` +
        `- Giãn cách an toàn: ${minDelay}s - ${maxDelay}s / nhóm (tránh Zalo quét spam)\n` +
        `- Giới hạn ngày: ${getMaxSendsPerDay()} tin/ngày\n` +
        `- Mẫu xem trước ngẫu nhiên:\n"${preview}"\n\n` +
        `Bot bắt đầu rải tự động lác đác từng nhóm... (Gõ /trangthairai để xem tiến độ).`
      );
      return true;
    }

    if (command === "stoprai") {
      if (!store.data.campaign || store.data.campaign.status !== "running") {
        await reply(message, "Hiện không có chiến dịch rải link nào đang chạy.");
        return true;
      }
      store.data.campaign.status = "stopped";
      store.save();
      const sentCount = store.data.campaign.items.filter((it) => it.status === "sent" || it.status === "simulated").length;
      const queuedCount = store.data.campaign.items.filter((it) => it.status === "queued").length;
      await reply(message,
        `⏹️ ĐÃ DỪNG CHIẾN DỊCH RẢI LINK #${store.data.campaign.id}.\n` +
        `- Đã gửi thành công: ${sentCount} nhóm\n` +
        `- Đã hủy hàng đợi: ${queuedCount} nhóm`
      );
      return true;
    }

    if (command === "trangthairai") {
      const camp = store.data.campaign;
      const totalGroups = store.data.targetGroups.length;
      const todayCount = store.data.dailyCounter?.count ?? 0;
      const maxSends = getMaxSendsPerDay();
      let textRes = `📊 TRẠNG THÁI RẢI LINK:\n- Tổng nhóm mục tiêu: ${totalGroups} nhóm\n- Số tin đã gửi hôm nay: ${todayCount}/${maxSends}\n`;
      if (!camp || camp.status === "stopped" || camp.status === "done") {
        textRes += "- Chiến dịch: Hiện không có chiến dịch nào đang chạy.";
      } else {
        const sent = camp.items.filter((it) => it.status === "sent" || it.status === "simulated").length;
        const queued = camp.items.filter((it) => it.status === "queued").length;
        const failed = camp.items.filter((it) => it.status === "failed").length;
        const nextInSec = Math.max(0, Math.round(((camp.nextSendAt || clock()) - clock()) / 1000));
        textRes += `- Chiến dịch đang chạy: #${camp.id}\n- Tiến độ: Đã gửi ${sent}/${camp.items.length} nhóm (còn ${queued} nhóm chờ, ${failed} lỗi)\n- Gửi nhóm tiếp theo sau: ${nextInSec} giây\n- Link rải: ${camp.url}`;
      }
      await reply(message, textRes);
      return true;
    }

    if (command === "dsnhom" || command === "danhsachnhom") {
      await syncAllExistingGroups();
      const list = store.data.targetGroups;
      if (!list.length) {
        await reply(message, "Danh sách nhóm mục tiêu rải link hiện đang trống. Hãy dùng /quetnhom hoặc /themtarget để thêm.");
        return true;
      }
      const previewList = list.slice(0, 20).map((id, idx) => `${idx + 1}. ID: ${id}`).join("\n");
      const moreText = list.length > 20 ? `\n... và còn ${list.length - 20} nhóm khác.` : "";
      await reply(message,
        `📋 DANH SÁCH NHÓM MỤC TIÊU (${list.length} nhóm):\n${previewList}${moreText}`
      );
      return true;
    }

    if (command === "themtarget") {
      if (!arg) {
        await reply(message, "Cú pháp: /themtarget <Mã_Nhóm>");
        return true;
      }
      const gid = String(arg).trim();
      if (!store.data.targetGroups.includes(gid)) {
        store.data.targetGroups.push(gid);
        store.save();
        await reply(message, `✅ Đã thêm nhóm ${gid} vào danh sách mục tiêu rải link (Tổng: ${store.data.targetGroups.length} nhóm).`);
      } else {
        await reply(message, `Nhóm ${gid} đã có sẵn trong danh sách nhận link.`);
      }
      return true;
    }

    if (command === "xoatarget") {
      if (!arg) {
        await reply(message, "Cú pháp: /xoatarget <Mã_Nhóm>");
        return true;
      }
      const gid = String(arg).trim();
      if (store.data.targetGroups.includes(gid)) {
        store.data.targetGroups = store.data.targetGroups.filter((g) => g !== gid);
        store.save();
        await reply(message, `🗑️ Đã xóa nhóm ${gid} khỏi danh sách mục tiêu rải link (Còn lại: ${store.data.targetGroups.length} nhóm).`);
      } else {
        await reply(message, `Nhóm ${gid} không có trong danh sách.`);
      }
      return true;
    }

    if (command === "joinnhom") {
      await reply(message, "💡 Bạn cứ dùng điện thoại hoặc Zalo Desktop tự bấm tham gia nhóm nhé (an toàn 100% không lo Zalo quét hạn chế). Sau khi vào nhóm, bot sẽ tự động nhận diện tất cả nhóm bạn đã tham gia khi bạn gõ /dsnhom hoặc khi bắt đầu /railink!");
      return true;
    }

    if (command === "quetnhom" || command === "quetlink") {
      await reply(message, "🔄 Đang đồng bộ danh sách tất cả các nhóm bạn đã tham gia...");
      await syncAllExistingGroups();
      await reply(message,
        `✅ ĐÃ ĐỒNG BỘ XONG!\n` +
        `- Tổng số nhóm bot đang có mặt: ${store.data.targetGroups.length} nhóm\n` +
        `👉 Gõ /dsnhom để xem danh sách hoặc /railink để bắt đầu rải.`
      );
      return true;
    }

    if (command === "locnhom" || command === "donnhom") {
      await reply(message, "🧹 Đang kiểm tra quyền gửi tin ở tất cả các nhóm bot đang có mặt...");
      const res = await filterAndLeaveLockedGroups();
      if (!res.leftGroups.length) {
        await reply(message, `✅ Tất cả ${res.totalChecked} nhóm bot đang có mặt đều có quyền gửi tin nhắn!`);
      } else {
        const names = res.leftGroups.map((g) => `- ${g.name} (${g.id})`).join("\n");
        await reply(message,
          `🚪 Đã tự động rời ${res.leftGroups.length}/${res.totalChecked} nhóm bị khóa chat:\n${names}\n\nHiện còn ${res.remainingTargets} nhóm sẵn sàng rải link!`
        );
      }
      return true;
    }

    if (command === "gioihanrai" || command === "limitrai" || command === "setlimit") {
      const todayCount = store.data.dailyCounter?.count ?? 0;
      if (!arg) {
        await reply(message,
          `📊 GIỚI HẠN RẢI LINK HIỆN TẠI:\n` +
          `- Giới hạn tối đa: ${getMaxSendsPerDay()} tin/ngày\n` +
          `- Đã gửi hôm nay: ${todayCount}/${getMaxSendsPerDay()} tin\n` +
          `👉 Để thay đổi giới hạn, gõ: /gioihanrai <số_lượng> (Ví dụ: /gioihanrai 100)`
        );
        return true;
      }
      const newLimit = Number.parseInt(arg.trim(), 10);
      if (!Number.isInteger(newLimit) || newLimit < 1 || newLimit > 500) {
        await reply(message, "⚠️ Vui lòng nhập số lượng hợp lệ từ 1 đến 500 (Ví dụ: /gioihanrai 100).");
        return true;
      }
      store.data.customMaxSends = newLimit;
      if (store.data.campaign && store.data.campaign.status === "paused_daily_limit" && store.data.dailyCounter.count < newLimit) {
        store.data.campaign.status = "running";
        store.data.campaign.nextSendAt = clock();
      }
      store.save();
      await reply(message,
        `✅ ĐÃ CẬP NHẬT GIỚI HẠN RẢI LINK!\n` +
        `- Giới hạn mới: ${newLimit} tin/ngày\n` +
        `- Đã gửi hôm nay: ${todayCount}/${newLimit} tin.`
      );
      return true;
    }

    return false;
  }

  return {
    handleCommand,
    store,
    joinQueue,
    syncAllExistingGroups,
    scanAllGroupsForInvites,
    filterAndLeaveLockedGroups,
    stepBroadcastWorker,
    stop: () => {
      clearInterval(broadcastTimer);
    },
  };
}
