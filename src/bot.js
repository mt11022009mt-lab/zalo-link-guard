import { readFile, writeFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { Zalo, ThreadType, LoginQRCallbackEventType } from "zca-js";
import { checkMessage, extractLinks } from "./policy.js";

const configPath = resolve(process.cwd(), "config.json");
const sessionPath = resolve(process.cwd(), "session.json");
const qrPath = resolve(process.cwd(), "zalo-login-qr.png");

const listingGroups = process.argv.includes("--list-groups");
const debug = process.argv.includes("--debug") || process.env.DEBUG === "true";

// Hỗ trợ đọc config từ Environment Variables (tiện cho Render / Railway)
let config;
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

const zalo = new Zalo();
let api;

// Thử login lại bằng session đã lưu nếu có
let sessionLoaded = false;
let sessionData = null;

if (process.env.SESSION_JSON) {
  try {
    sessionData = JSON.parse(process.env.SESSION_JSON);
  } catch {}
} else {
  try {
    sessionData = JSON.parse(await readFile(sessionPath, "utf8"));
  } catch {}
}

if (!listingGroups && sessionData && sessionData.cookie && sessionData.imei && sessionData.userAgent) {
  try {
    console.log("Đang đăng nhập bằng phiên đã lưu...");
    api = await zalo.login(sessionData);
    sessionLoaded = true;
    botStatus = "Đã kết nối qua Session lưu sẵn";
    console.log("Đăng nhập bằng phiên cũ thành công!");
  } catch (err) {
    console.log("Phiên cũ hết hạn hoặc không hợp lệ, chuyển sang tạo mã QR...");
  }
}

if (!sessionLoaded) {
  console.log("Đang tạo mã QR đăng nhập...");
  botStatus = "Chờ quét mã QR";
  api = await zalo.loginQR({ qrPath }, async (event) => {
    if (event.type === LoginQRCallbackEventType.QRCodeGenerated) {
      await event.actions.saveToFile(qrPath);
      try {
        const qrBuffer = await readFile(qrPath);
        currentQRCodeBase64 = qrBuffer.toString("base64");
      } catch {}
      console.log(`Mở http://localhost:${PORT}/ hoặc file ${qrPath} để quét QR.`);
    } else if (event.type === LoginQRCallbackEventType.QRCodeExpired) {
      console.log("Mã QR hết hạn, đang tạo lại...");
      event.actions.retry();
    } else if (event.type === LoginQRCallbackEventType.GotLoginInfo) {
      try {
        await writeFile(sessionPath, JSON.stringify(event.data, null, 2), "utf8");
        console.log("Đã lưu phiên đăng nhập vào session.json.");
      } catch {}
    }
  });
  currentQRCodeBase64 = null; // Đăng nhập xong thì xóa QR trên web
  await unlink(qrPath).catch(() => {});
}

botStatus = "Đang trực và lọc link";

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

async function deleteMessageWithRetry(dest, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await api.deleteMessage(dest, false);
      return response;
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
}

api.listener.on("message", async (message) => {
  if (message.type !== ThreadType.Group) return;
  if (debug) {
    const domains = extractLinks(message.data?.content).map((link) => link.hostname);
    console.log(`[DEBUG] nhóm=${message.threadId} người_gửi=${message.data?.uidFrom ?? "?"} loại=${message.data?.msgType ?? "?"} link=${domains.join(",") || "không_thấy"} trong_cấu_hình=${config.groupIds.includes(String(message.threadId))}`);
  }
  const result = checkMessage(message, config);
  if (!result) return;

  const { msgId, cliMsgId, uidFrom } = message.data;
  if (!msgId || !cliMsgId || !uidFrom) {
    console.warn("Thiếu ID tin nhắn, bỏ qua để tránh xóa nhầm.");
    return;
  }
  const details = `nhóm=${message.threadId} người_gửi=${uidFrom} tin=${msgId} tên_miền=${result.links.map((item) => item.hostname).join(", ")}`;
  if (config.dryRun) {
    console.log(`[XEM TRƯỚC] Sẽ xóa ${details}`);
    return;
  }
  try {
    const response = await deleteMessageWithRetry({
      type: ThreadType.Group,
      threadId: message.threadId,
      data: { msgId, cliMsgId, uidFrom },
    }, 3);
    console.log(`[ĐÃ GỬI LỆNH XÓA] ${details} trạng_thái=${response?.status ?? 0}`);
  } catch (error) {
    console.error(`[LỖI XÓA] ${details}`, error.message);
  }
});

api.listener.on("error", (error) => console.error("Lỗi kết nối Zalo:", error));
api.listener.start();
