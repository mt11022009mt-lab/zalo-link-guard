import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Zalo, ThreadType } from "zca-js";
import { checkMessage, extractMessageLinks } from "./policy.js";
import { ModerationState } from "./moderation-state.js";
import { createModeration } from "./moderation.js";
import { createHistorySweep } from "./history-sweep.js";
import { loginWithSession } from "./session.js";

const configPath = resolve(process.cwd(), "config.json");
const listingGroups = process.argv.includes("--list-groups");
const debug = process.argv.includes("--debug");
let config;
const validIds = (value) => Array.isArray(value) && value.every((id) => typeof id === "string" && id.trim());
if (!listingGroups) {
  if (process.env.CONFIG_JSON) {
    try {
      config = JSON.parse(process.env.CONFIG_JSON);
    } catch {
      console.error("Biến môi trường CONFIG_JSON không đúng định dạng JSON.");
      process.exit(1);
    }
  } else {
    try {
      config = JSON.parse(await readFile(configPath, "utf8"));
    } catch {
      console.error("Thiếu hoặc không đọc được config.json. Hãy sao chép config.example.json thành config.json hoặc đặt biến môi trường CONFIG_JSON.");
      process.exit(1);
    }
  }
  if (!validIds(config.groupIds) || config.groupIds.length === 0 || config.groupIds.some((id) => id === "THAY_BANG_ID_NHOM") ||
      !validIds(config.trustedUserIds) || !validIds(config.allowedDomains) || typeof config.dryRun !== "boolean" ||
      (config.blockZaloLinks !== undefined && typeof config.blockZaloLinks !== "boolean") ||
      (config.blockZaloGroupInvites !== undefined && typeof config.blockZaloGroupInvites !== "boolean") ||
      (config.reviewGroupId !== undefined && (typeof config.reviewGroupId !== "string" || !config.reviewGroupId.trim() ||
        config.groupIds.includes(config.reviewGroupId))) ||
      (config.violationWindowHours !== undefined && (!Number.isInteger(config.violationWindowHours) ||
        config.violationWindowHours < 1 || config.violationWindowHours > 168)) ||
      (config.historySweepSeconds !== undefined && (config.historySweepSeconds !== 0 &&
        (!Number.isInteger(config.historySweepSeconds) || config.historySweepSeconds < 30 || config.historySweepSeconds > 300)))) {
    console.error("Cấu hình không hợp lệ. Kiểm tra groupIds, trustedUserIds, allowedDomains, reviewGroupId, violationWindowHours và dryRun trong config.json.");
    process.exit(1);
  }
}

const state = listingGroups ? null : new ModerationState(resolve(process.cwd(), "moderation-state.json"), {
  windowHours: config.violationWindowHours ?? 24,
});

const qrPath = resolve(process.cwd(), "zalo-login-qr.png");
const sessionPath = resolve(process.cwd(), "zalo-session.json");
const zalo = new Zalo();
let api;
try {
  api = await loginWithSession({
    zalo,
    sessionJson: process.env.SESSION_JSON,
    qrPath,
    sessionPath,
    isRender: process.env.RENDER === "true" || Boolean(process.env.RENDER),
  });
} catch (error) {
  console.error(`[ĐĂNG NHẬP] ${error.message}`);
  process.exit(1);
}
const startedAt = Date.now();

if (listingGroups) {
  const groups = await api.getAllGroups();
  console.log("ID nhóm của tài khoản:");
  const ids = Object.keys(groups.gridVerMap);
  let info = { gridInfoMap: {} };
  if (ids.length) {
    try {
      info = await api.getGroupInfo(ids);
    } catch (error) {
      console.warn("Không lấy được tên nhóm; vẫn hiển thị ID.", error.message);
    }
  }
  for (const id of ids) console.log(`${id}\t${info.gridInfoMap[id]?.name ?? ""}`);
  process.exit(0);
}

if (config.dryRun) {
  console.warn("[CHỈ XEM TRƯỚC] dryRun đang bật trong config.json: bot ghi nhận vi phạm nhưng KHÔNG xóa tin hay kick thành viên.");
}
console.log(`Đang theo dõi ${config.groupIds.length} nhóm; dryRun=${config.dryRun}.`);
try {
  const ownId = String(api.ctx.uid ?? "");
  const info = await api.getGroupInfo(config.groupIds);
  for (const groupId of config.groupIds) {
    const group = info?.gridInfoMap?.[groupId];
    if (!group) {
      console.warn(`[KIỂM TRA NHÓM] ${groupId}: tài khoản bot không lấy được thông tin nhóm. Kiểm tra groupIds và tài khoản đăng nhập.`);
      continue;
    }
    const isAdmin = String(group.creatorId) === ownId ||
      (group.adminIds ?? []).some((id) => String(id) === ownId);
    console.log(`[KIỂM TRA NHÓM] ${groupId} | ${group.name ?? "?"} | bot_là_QTV=${isAdmin}`);
    if (!isAdmin) console.warn(`[KIỂM TRA NHÓM] ${groupId}: bot chưa là QTV; có thể không xóa được tin của người khác.`);
  }
} catch (error) {
  console.warn("[KIỂM TRA NHÓM] Không xác minh được nhóm/quyền QTV lúc khởi động:", error.message);
}
const moderation = createModeration({ api, config, state });
const seenMessages = new Map();

async function processMessage(message, { source = "live" } = {}) {
  if (source === "live" && await moderation.handleCommand(message)) return;
  if (message.type !== ThreadType.Group) return;
  if (source === "history" && typeof message.data?.content === "string" &&
      /^\s*\/(?:kick|duyetkick|tuchoikick|vipham)(?:\s|$)/i.test(message.data.content)) return;
  const messageKey = message.data?.msgId && `${message.threadId}:${message.data.msgId}`;
  if (messageKey) {
    if (seenMessages.has(messageKey)) return;
    seenMessages.set(messageKey, Date.now());
    if (seenMessages.size > 5000) seenMessages.delete(seenMessages.keys().next().value);
  }
  if (debug) {
    const domains = extractMessageLinks(message).map((link) => link.hostname);
    const content = message.data?.content;
    const keys = content && typeof content === "object" ? Object.keys(content).slice(0, 12).join(",") : "-";
    console.log(`[DEBUG] nguồn=${source} nhóm=${message.threadId} người_gửi=${message.data?.uidFrom ?? "?"} loại=${message.data?.msgType ?? "?"} nội_dung=${typeof content} trường=${keys} link=${domains.join(",") || "không_thấy"} trong_cấu_hình=${config.groupIds.includes(String(message.threadId))} tin_cậy=${config.trustedUserIds.includes(String(message.data?.uidFrom))} dryRun=${config.dryRun}`);
  }
  const result = checkMessage(message, config);
  if (!result) {
    if (debug) console.log("[DEBUG] quyết_định=bỏ_qua (không có link bị cấm hoặc người gửi được miễn)");
    return;
  }
  if (debug) console.log(`[DEBUG] quyết_định=vi_phạm tên_miền=${result.links.map((link) => link.hostname).join(",")}`);

  const { msgId, cliMsgId, uidFrom } = message.data;
  if (!msgId || !cliMsgId || !uidFrom) {
    console.warn("Thiếu ID tin nhắn, bỏ qua để tránh xóa nhầm.");
    return;
  }
  const details = `nguồn=${source} nhóm=${message.threadId} người_gửi=${uidFrom} tin=${msgId} tên_miền=${result.links.map((item) => item.hostname).join(", ")}`;
  if (config.dryRun) {
    console.log(`[XEM TRƯỚC] Sẽ xóa ${details}`);
    await moderation.onViolation(message, result);
    return;
  }
  try {
    const response = await api.deleteMessage({
      type: ThreadType.Group,
      threadId: message.threadId,
      data: { msgId, cliMsgId, uidFrom },
    }, false);
    console.log(`[API XÓA TRẢ VỀ] ${details} trạng_thái=${response?.status ?? "không_rõ"}; kiểm tra tin trên Zalo nếu vẫn còn.`);
  } catch (error) {
    console.error(`[LỖI XÓA] ${details}`, error);
  }
  await moderation.onViolation(message, result);
}

api.listener.on("message", (message) => {
  void processMessage(message).catch((error) => console.error("Lỗi xử lý tin nhắn:", error));
});
api.listener.on("error", (error) => console.error("Lỗi kết nối Zalo:", error));
api.listener.start();
if (config.historySweepSeconds !== 0) {
  const seconds = config.historySweepSeconds ?? 60;
  const sweepHistory = createHistorySweep({
    api, groupIds: config.groupIds, startedAt, processMessage,
  });
  setInterval(() => void sweepHistory(), seconds * 1000).unref();
  console.log(`Đang kiểm tra bổ sung 50 tin gần nhất mỗi ${seconds} giây để bắt tin mới bị lỡ.`);
}
