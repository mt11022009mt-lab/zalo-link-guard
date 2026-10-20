import { readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { Zalo, ThreadType, LoginQRCallbackEventType } from "zca-js";
import { checkMessage, extractMessageLinks } from "./policy.js";
import { ModerationState } from "./moderation-state.js";
import { createModeration } from "./moderation.js";
import { createHistorySweep } from "./history-sweep.js";

const configPath = resolve(process.cwd(), "config.json");
const qrPath = resolve(process.cwd(), "zalo-login-qr.png");
const listingGroups = process.argv.includes("--list-groups");
const debug = process.argv.includes("--debug") || process.env.DEBUG === "true";

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
      console.error("Thiếu hoặc không đọc được config.json. Hãy sao chép config.example.json thành config.json hoặc đặt CONFIG_JSON.");
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

// Khởi tạo HTTP Web Server nhẹ để xem QR trực tiếp trên web và giữ bot luôn thức (Render Free tier ping)
let currentQRCodeBase64 = null;
let botStatus = "Khởi tạo...";

const PORT = process.env.PORT || 3000;
const server = createServer(async (req, res) => {
  if (req.url === "/health" || req.url === "/ping") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", botStatus, uptime: process.uptime() }));
  }

  if (req.url === "/qr" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (currentQRCodeBase64) {
      return res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Zalo Bot Login QR</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
        <body style="font-family:sans-serif;text-align:center;padding:30px;background:#f5f7fb;">
          <h2>Quét mã QR để đăng nhập Zalo Bot</h2>
          <p>Mở app Zalo trên điện thoại quét mã dưới đây để kích hoạt bot:</p>
          <img src="data:image/png;base64,${currentQRCodeBase64}" style="max-width:320px;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.15);" />
          <p style="color:#666;margin-top:20px;">Trang sẽ tự làm mới sau 5 giây để kiểm tra trạng thái...</p>
          <script>setTimeout(() => location.reload(), 5000);</script>
        </body>
        </html>
      `);
    } else {
      return res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Zalo Bot Status</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
        <body style="font-family:sans-serif;text-align:center;padding:40px;background:#f5f7fb;">
          <h2 style="color:#2b8a3e;">Bot Zalo Đang Hoạt Động!</h2>
          <p>Trạng thái: <b>${botStatus}</b></p>
          <p>Uptime: ${Math.floor(process.uptime())} giây</p>
        </body>
        </html>
      `);
    }
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`Web Server lắng nghe tại cổng ${PORT} (URL: http://localhost:${PORT}/)`);
});

const state = listingGroups ? null : new ModerationState(resolve(process.cwd(), "moderation-state.json"), {
  windowHours: config.violationWindowHours ?? 24,
});

const zalo = new Zalo();
console.log("Đang tạo mã QR đăng nhập...");
botStatus = "Chờ quét mã QR";
const api = await zalo.loginQR({ qrPath }, async (event) => {
  if (event.type === LoginQRCallbackEventType.QRCodeGenerated) {
    await event.actions.saveToFile(qrPath);
    try {
      const qrBuffer = await readFile(qrPath);
      currentQRCodeBase64 = qrBuffer.toString("base64");
    } catch {}
    console.log(`Mở http://localhost:${PORT}/ hoặc file ${qrPath} để quét bằng tài khoản Zalo quản trị nhóm.`);
  } else if (event.type === LoginQRCallbackEventType.QRCodeExpired) {
    console.log("Mã QR hết hạn, đang tạo lại...");
    event.actions.retry();
  }
});
currentQRCodeBase64 = null;
await unlink(qrPath).catch(() => {});

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

botStatus = "Đang trực và lọc link";
if (config.dryRun) {
  console.warn("[CHỈ XEM TRƯỚC] dryRun đang bật trong config.json: bot ghi nhận vi phạm nhưng KHÔNG xóa tin hay kick thành viên.");
}
console.log(`Đang theo dõi ${config.groupIds.length} nhóm; dryRun=${config.dryRun}.`);
const moderation = createModeration({ api, config, state });

for (const groupId of config.groupIds) {
  try {
    const info = await api.getGroupInfo(groupId);
    const group = info?.gridInfoMap?.[groupId];
    const role = group ? (group.creatorId === api.ctx.uid ? "Trưởng nhóm" : group.adminIds?.includes(api.ctx.uid) ? "Phó nhóm" : "Thành viên thường (THIẾU QUYỀN QTV)") : "Không rõ";
    console.log(`[KIỂM TRA NHÓM] ID=${groupId} Tên="${group?.name ?? "N/A"}" Quyền=${role}`);
  } catch (error) {
    console.warn(`[KIỂM TRA NHÓM] ID=${groupId} Không lấy được thông tin:`, error.message);
  }
}

async function processMessage(message, options = {}) {
  const source = options.source ?? "live";
  if (await moderation.handleCommand(message)) return;
  if (message.type !== ThreadType.Group) return;
  if (debug) {
    const domains = extractMessageLinks(message).map((link) => link.hostname);
    const content = message.data?.content;
    const keys = content && typeof content === "object" ? Object.keys(content).slice(0, 12).join(",") : "-";
    console.log(`[DEBUG] nguồn=${source} nhóm=${message.threadId} người_gửi=${message.data?.uidFrom ?? "?"} loại=${message.data?.msgType ?? "?"} nội_dung=${typeof content} trường=${keys} link=${domains.join(",") || "không_thấy"} trong_cấu_hình=${config.groupIds.includes(String(message.threadId))} tin_cậy=${config.trustedUserIds.includes(String(message.data?.uidFrom))} dryRun=${config.dryRun}`);
  }
  const result = checkMessage(message, config);
  if (!result) {
    if (debug) console.log(`[DEBUG] nguồn=${source} quyết_định=bỏ_qua (không có link bị cấm hoặc người gửi được miễn)`);
    return;
  }
  if (debug) console.log(`[DEBUG] nguồn=${source} quyết_định=vi_phạm tên_miền=${result.links.map((link) => link.hostname).join(",")}`);

  const { msgId, cliMsgId, uidFrom } = message.data;
  if (!msgId || !cliMsgId || !uidFrom) {
    console.warn(`[${source}] Thiếu ID tin nhắn, bỏ qua để tránh xóa nhầm.`);
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
    console.log(`[ĐÃ GỬI LỆNH XÓA] ${details} trạng_thái=${response.status}`);
  } catch (error) {
    console.error(`[LỖI XÓA] ${details}`, error);
  }
  await moderation.onViolation(message, result);
}

api.listener.on("message", (message) => {
  void processMessage(message, { source: "live" }).catch((error) => console.error("Lỗi xử lý tin nhắn:", error));
});
api.listener.on("error", (error) => console.error("Lỗi kết nối Zalo:", error));
api.listener.start();

const sweepIntervalSeconds = config.historySweepSeconds ?? 60;
if (sweepIntervalSeconds > 0) {
  const startedAt = Date.now();
  const sweepHistory = createHistorySweep({
    api,
    groupIds: config.groupIds,
    startedAt,
    processMessage,
  });
  const sweepTimer = setInterval(() => {
    void sweepHistory().catch((error) => console.error("[QUÉT LỊCH SỬ] Lỗi định kỳ:", error));
  }, sweepIntervalSeconds * 1000);
  if (typeof sweepTimer.unref === "function") sweepTimer.unref();
  console.log(`Đã bật quét vét lịch sử định kỳ mỗi ${sweepIntervalSeconds}s cho tin mới từ lúc khởi động.`);
}
