import { ThreadType } from "zca-js";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractMessageLinks, isZaloGroupInvite } from "./policy.js";

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

      try {
        if (typeof api.getAllGroups === "function") {
          const groups = await api.getAllGroups();
          const ids = Object.keys(groups.gridVerMap || {});
          for (const gid of ids) {
            if (!store.data.targetGroups.includes(gid)) {
              store.data.targetGroups.push(gid);
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
        }
      } catch (e) {
        log.warn("[VÀO NHÓM] Không cập nhật được danh sách nhóm sau khi join:", e.message);
      }
      store.save();
    } catch (err) {
      log.warn(`[VÀO NHÓM THẤT BẠI] ${link}: ${err.message}`);
      if (err.code === 178 || String(err.message).includes("178")) {
        store.data.joinedLinks.push(link);
        store.save();
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

  async function handleCommand(message) {
    if (message.isSelf || typeof message.data?.content !== "string") return false;
    const text = message.data.content.trim();
    const senderId = String(message.data.uidFrom);

    if (/^\/myid(?:\s|$)/i.test(text)) {
      await api.sendMessage(`UID Zalo của bạn là: ${senderId}`, message.threadId, message.type);
      return true;
    }

    const match = text.match(/^\/(railink|stoprai|joinnhom|trangthairai|themtarget)(?:\s+([\s\S]*))?$/i);
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
          "Cú pháp: /railink <URL> <mẫu nội dung spin>\nVí dụ: /railink https://zalo.me/g/abc {Chào cả nhà|Xin chào anh em}, tham gia nhóm mới nhé!",
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
        `🚀 Đã khởi tạo chiến dịch rải link #${campaignId}!\n- Tổng nhóm mục tiêu: ${items.length}\n- Giãn cách an toàn: ${config.broadcast?.minDelaySeconds ?? 60}s - ${config.broadcast?.maxDelaySeconds ?? 180}s\n- Mẫu xem trước:\n"${preview}"\n\nBot đang tiến hành rải lác đác từng nhóm...`,
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
    store,
    stepJoinWorker,
    stepBroadcastWorker,
    close: () => {
      clearInterval(joinTimer);
      clearInterval(broadcastTimer);
    },
  };
}
