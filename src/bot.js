import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { Zalo, ThreadType } from "zca-js";
import { checkMessage, extractMessageLinks, isImageMessage } from "./policy.js";
import { createModerationState } from "./state-store.js";
import { createModeration } from "./moderation.js";
import { createHistorySweep } from "./history-sweep.js";
import { loginWithSession } from "./session.js";
import { getVerifiedGroupInfo, isGroupAdmin } from "./group-roles.js";

const configPath = resolve(process.cwd(), "config.json");
const { version } = createRequire(import.meta.url)("../package.json");
console.log(`[BOT] phiên_bản=${version}`);
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
      (config.blockImages !== undefined && typeof config.blockImages !== "boolean") ||
      (config.blockZaloLinks !== undefined && typeof config.blockZaloLinks !== "boolean") ||
      (config.blockZaloGroupInvites !== undefined && typeof config.blockZaloGroupInvites !== "boolean") ||
      (config.reviewGroupId !== undefined && (typeof config.reviewGroupId !== "string" || !config.reviewGroupId.trim() ||
        config.groupIds.includes(config.reviewGroupId))) ||
      (config.violationWindowHours !== undefined && (!Number.isInteger(config.violationWindowHours) ||
        config.violationWindowHours < 1 || config.violationWindowHours > 168)) ||
      (config.historySweepSeconds !== undefined && (config.historySweepSeconds !== 0 &&
        (!Number.isInteger(config.historySweepSeconds) || config.historySweepSeconds < 30 || config.historySweepSeconds > 300)))) {
    console.error("Cấu hình không hợp lệ. Kiểm tra groupIds, trustedUserIds, allowedDomains, blockImages, reviewGroupId, violationWindowHours và dryRun trong config.json.");
    process.exit(1);
  }
}

let state = null;
if (!listingGroups) {
  try {
    const opened = await createModerationState({ windowHours: config.violationWindowHours ?? 24 });
    state = opened.state;
    console.log(`[LƯU VI PHẠM] ${opened.storage}`);
    if (process.env.RENDER === "true" && !process.env.DATABASE_URL && !process.env.STATE_DIR) {
      console.warn("[LƯU VI PHẠM] SESSION_JSON chỉ giữ đăng nhập. Hãy gắn DATABASE_URL hoặc Render Persistent Disk + STATE_DIR để số lần vi phạm không mất khi dịch vụ khởi động lại.");
    }
  } catch (error) {
    console.error(`[LƯU VI PHẠM] Không mở được nơi lưu trạng thái: ${error.message}`);
    process.exit(1);
  }
}

const qrPath = resolve(process.cwd(), "zalo-login-qr.png");
const zalo = new Zalo();
let api;
try {
  api = await loginWithSession({
    zalo,
    sessionJson: process.env.SESSION_JSON,
    qrPath,
    sessionPath: resolve(process.cwd(), "zalo-session.json"),
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

console.log(`Đang theo dõi ${config.groupIds.length} nhóm; dryRun=${config.dryRun}.`);
console.log(`[CHẶN ẢNH] blockImages=${config.blockImages !== false}; QTV và trustedUserIds được miễn.`);
if (config.dryRun) console.warn("[CHỈ XEM TRƯỚC] dryRun=true: bot sẽ KHÔNG xóa tin, không ghi vi phạm và không kick.");
if (config.blockZaloLinks === false) console.warn("[CẤU HÌNH] blockZaloLinks=false: link zalo.me ngoài /g/ có thể được phép.");
try {
  const ownId = String(typeof api.getOwnId === "function" ? api.getOwnId() : api.ctx?.uid ?? "");
  const info = await api.getGroupInfo(config.groupIds);
  for (const groupId of config.groupIds) {
    const group = info.gridInfoMap?.[groupId];
    if (!group) {
      console.warn(`[KIỂM TRA NHÓM] ${groupId}: tài khoản bot không lấy được thông tin nhóm. Kiểm tra groupIds và tài khoản đăng nhập.`);
      continue;
    }
    const isAdmin = Array.isArray(group.adminIds) && isGroupAdmin(group, ownId);
    console.log(`[KIỂM TRA NHÓM] ${groupId} | ${group.name ?? "?"} | bot_là_QTV=${isAdmin}`);
    if (!isAdmin) console.warn(`[KIỂM TRA NHÓM] ${groupId}: bot chưa là QTV; có thể không xóa được tin của người khác.`);
  }
} catch (error) {
  console.warn("[KIỂM TRA NHÓM] Không xác minh được nhóm/quyền QTV lúc khởi động:", error.message);
}
const moderation = createModeration({ api, config, state });
const seenMessages = new Map();
const messagesInFlight = new Set();
function markSeen(messageKey) {
  if (!messageKey) return;
  seenMessages.set(messageKey, Date.now());
  if (seenMessages.size > 5000) seenMessages.delete(seenMessages.keys().next().value);
}

async function processMessage(message, { source = "live" } = {}) {
  if (source === "live" && await moderation.handleCommand(message)) return;
  if (message.type !== ThreadType.Group) return;
  if (source === "history" && typeof message.data?.content === "string" &&
      /^\s*\/(?:kick|duyetkick|tuchoikick|vipham)(?:\s|$)/i.test(message.data.content)) return;
  const messageKey = message.data?.msgId && `${message.threadId}:${message.data.msgId}`;
  if (messageKey && (seenMessages.has(messageKey) || messagesInFlight.has(messageKey))) return;
  if (debug) {
    const domains = extractMessageLinks(message).map((link) => link.hostname);
    const content = message.data?.content;
    const keys = content && typeof content === "object" ? Object.keys(content).slice(0, 12).join(",") : "-";
    console.log(`[DEBUG] nguồn=${source} nhóm=${message.threadId} người_gửi=${message.data?.uidFrom ?? "?"} tin=${message.data?.msgId ?? "?"} cliMsgId=${message.data?.cliMsgId ? "có" : "thiếu"} loại=${message.data?.msgType ?? "?"} ảnh=${isImageMessage(message)} nội_dung=${typeof content} trường=${keys} link=${domains.join(",") || "không_thấy"} trong_cấu_hình=${config.groupIds.includes(String(message.threadId))} tin_cậy=${config.trustedUserIds.includes(String(message.data?.uidFrom))} dryRun=${config.dryRun}`);
  }
  const result = checkMessage(message, config);
  if (!result) {
    if (debug) console.log("[DEBUG] quyết_định=bỏ_qua (không có ảnh/link bị cấm hoặc người gửi được miễn)");
    return;
  }
  const { msgId, cliMsgId, uidFrom } = message.data;
  if (!msgId || !cliMsgId || !uidFrom) {
    console.warn(`[THIẾU ID] nguồn=${source} nhóm=${message.threadId} loại=${message.data?.msgType ?? "?"} msgId=${msgId ? "có" : "thiếu"} cliMsgId=${cliMsgId ? "có" : "thiếu"} uidFrom=${uidFrom ? "có" : "thiếu"}; bỏ qua để tránh xóa nhầm.`);
    return;
  }
  const reason = [result.image ? "ảnh" : null, result.links.length ? `link:${result.links.map((item) => item.hostname).join(",")}` : null]
    .filter(Boolean).join("+");
  const details = `nguồn=${source} nhóm=${message.threadId} người_gửi=${uidFrom} tin=${msgId} lý_do=${reason}`;
  if (messageKey) messagesInFlight.add(messageKey);
  try {
    let group;
    try {
      group = await getVerifiedGroupInfo(api, message.threadId);
    } catch (error) {
      console.warn(`[KIỂM TRA QTV] Không xác minh được người gửi của ${details}; bỏ qua tin để tránh xử lý QTV nhầm: ${error.message}`);
      return;
    }
    if (isGroupAdmin(group, uidFrom)) {
      if (debug) console.log(`[DEBUG] quyết_định=bỏ_qua_QTV nhóm=${message.threadId} người_gửi=${uidFrom}`);
      markSeen(messageKey);
      return;
    }
    if (debug) console.log(`[DEBUG] quyết_định=xóa lý_do=${reason}`);
    if (config.dryRun) {
      console.log(`[XEM TRƯỚC] Sẽ xóa ${details}`);
    } else {
      let response;
      try {
        response = await api.deleteMessage({
          type: ThreadType.Group,
          threadId: message.threadId,
          data: { msgId, cliMsgId, uidFrom },
        }, false);
      } catch (error) {
        console.error(`[LỖI XÓA] ${details}`, error);
        if (result.links.length) await moderation.onViolation(message, result);
        return;
      }
      console.log(`[API XÓA TRẢ VỀ] ${details} trạng_thái=${response?.status ?? "không_rõ"}; kiểm tra tin trên Zalo nếu vẫn còn.`);
    }
    markSeen(messageKey);
    if (result.links.length) await moderation.onViolation(message, result);
  } finally {
    if (messageKey) messagesInFlight.delete(messageKey);
  }
}

api.listener.on("message", (message) => {
  void processMessage(message).catch((error) => console.error("Lỗi xử lý tin nhắn:", error));
});
api.listener.on("error", (error) => console.error("Lỗi kết nối Zalo:", error));
api.listener.on("connected", () => console.log("[KẾT NỐI] Đã nhận tin mới từ Zalo."));
api.listener.on("disconnected", (code) => console.warn(`[KẾT NỐI] Bị ngắt; mã=${code}.`));
api.listener.on("closed", (code) => console.warn(`[KẾT NỐI] Đã đóng; mã=${code}. Kiểm tra phiên Zalo nếu bot không nhận tin mới.`));
api.listener.start({ retryOnClose: true });
if (config.historySweepSeconds !== 0) {
  const seconds = config.historySweepSeconds ?? 60;
  const sweepHistory = createHistorySweep({
    api, groupIds: config.groupIds, startedAt, processMessage,
  });
  setInterval(() => void sweepHistory(), seconds * 1000).unref();
  console.log(`Đang kiểm tra bổ sung 50 tin gần nhất mỗi ${seconds} giây để bắt tin mới bị lỡ.`);
}
