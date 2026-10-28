import { existsSync, statSync, createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { Zalo, ThreadType } from "zca-js";
import { checkMessage, extractMessageLinks, isImageMessage } from "./policy.js";
import { createModerationState } from "./state-store.js";
import { createModeration } from "./moderation.js";
import { createHistorySweep } from "./history-sweep.js";
import { loginWithSession } from "./session.js";
import { getVerifiedGroupInfo, isGroupAdmin } from "./group-roles.js";
import { AIService } from "./ai-service.js";
import { createBroadcaster } from "./broadcaster.js";

// Chống crash đột tử do lỗi mạng hoặc unhandled rejection từ WebSocket / Zalo API
process.on("unhandledRejection", (reason) => {
  console.error("[CHỐNG CRASH] unhandledRejection:", reason);
});
process.on("uncaughtException", (error) => {
  console.error("[CHỐNG CRASH] uncaughtException:", error);
});

// Bộ đệm lưu trữ log gần nhất để kiểm tra trực tiếp qua web /debug
const logBuffer = [];
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
function pushLog(level, ...args) {
  const text = args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
  logBuffer.push({ time: new Date().toISOString(), level, text });
  if (logBuffer.length > 100) logBuffer.shift();
}
console.log = (...args) => { pushLog("INFO", ...args); originalLog(...args); };
console.warn = (...args) => { pushLog("WARN", ...args); originalWarn(...args); };
console.error = (...args) => { pushLog("ERROR", ...args); originalError(...args); };

const configPath = resolve(process.cwd(), "config.json");
const { version } = createRequire(import.meta.url)("../package.json");
console.log(`[BOT] phiên_bản=${version}`);
const listingGroups = process.argv.includes("--list-groups");
const debug = process.argv.includes("--debug");
let config;
let botStatus = "đang_khởi_động";
let botError = null;
let lastMessageTime = null;

// Khởi chạy HTTP Server để Render không bị timeout port scan và UptimeRobot ping 24/7
const PORT = Number(process.env.PORT) || 3000;
const server = createServer(async (req, res) => {
  if (req.url === "/ping" || req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({
      status: "ok",
      botStatus,
      error: botError,
      version,
      uptime: Math.floor(process.uptime()),
      groups: config?.groupIds?.length ?? 0,
      timestamp: new Date().toISOString(),
    }));
  }

  if (req.url?.startsWith("/group")) {
    const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const gid = urlObj.searchParams.get("id") || config?.groupIds?.[0];
    try {
      if (!api || typeof api.getGroupInfo !== "function") {
        res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ error: "Bot chưa hoàn tất kết nối Zalo." }));
      }
      const ginfo = await api.getGroupInfo([gid]);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({
        groupId: gid,
        ownId: String(typeof api.getOwnId === "function" ? api.getOwnId() : api.ctx?.uid ?? ""),
        data: ginfo?.gridInfoMap?.[gid] ?? null,
      }, null, 2));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (req.url === "/download/model" || req.url === "/model") {
    const modelPath = (state && typeof state.getModelPath === "function")
      ? state.getModelPath()
      : resolve(process.cwd(), "assets", "locket-model.mobileconfig");
    if (existsSync(modelPath)) {
      const stat = statSync(modelPath);
      res.writeHead(200, {
        "Content-Type": "application/x-apple-aspen-config",
        "Content-Disposition": 'attachment; filename="locketgold.mobileconfig"',
        "Content-Length": stat.size,
      });
      return createReadStream(modelPath).pipe(res);
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("File model chưa được tải lên máy chủ.");
  }

  if (req.url === "/download/video" || req.url === "/video") {
    const videoPath = (state && typeof state.getVideoPath === "function")
      ? state.getVideoPath()
      : resolve(process.cwd(), "assets", "locket-video.mp4");
    if (existsSync(videoPath)) {
      const stat = statSync(videoPath);
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": stat.size,
      });
      return createReadStream(videoPath).pipe(res);
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("File video chưa được tải lên máy chủ.");
  }

  if (req.url === "/api/info") {
    const videoPath = (state && typeof state.getVideoPath === "function")
      ? state.getVideoPath()
      : resolve(process.cwd(), "assets", "locket-video.mp4");
    const modelPath = (state && typeof state.getModelPath === "function")
      ? state.getModelPath()
      : resolve(process.cwd(), "assets", "locket-model.mobileconfig");
    const videoExists = existsSync(videoPath);
    const modelExists = existsSync(modelPath);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({
      videoUrl: state?.getVideoUrl?.() ?? "https://zalo-link-guard-1.onrender.com/download/video",
      videoExists,
      videoSize: videoExists ? statSync(videoPath).size : 0,
      modelUrl: state?.getModelUrl?.() ?? "https://zalo-link-guard-1.onrender.com/download/model",
      modelExists,
      modelSize: modelExists ? statSync(modelPath).size : 0,
    }));
  }

  if (req.method === "POST" && req.url.startsWith("/api/upload")) {
    const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const type = urlObj.searchParams.get("type") || "video";
    const customName = urlObj.searchParams.get("filename") || (type === "video" ? "locket-video.mp4" : "locket-model.mobileconfig");
    const targetFilename = type === "video"
      ? "locket-video.mp4"
      : (customName.endsWith(".conf") ? "locket-model.conf" : "locket-model.mobileconfig");
    const assetsDir = resolve(process.cwd(), "assets");
    mkdirSync(assetsDir, { recursive: true });
    const targetPath = resolve(assetsDir, targetFilename);

    const fileStream = createWriteStream(targetPath);
    let totalBytes = 0;
    req.on("data", (chunk) => {
      totalBytes += chunk.length;
    });
    req.pipe(fileStream);
    fileStream.on("finish", async () => {
      if (type === "video") {
        state?.setVideoPath?.(targetPath);
        state?.setVideoUrl?.("https://zalo-link-guard-1.onrender.com/download/video");
      } else {
        state?.setModelPath?.(targetPath);
        state?.setModelUrl?.("https://zalo-link-guard-1.onrender.com/download/model");
      }
      await state?.flush?.();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ success: true, size: totalBytes, file: targetFilename }));
    });
    fileStream.on("error", (err) => {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }

  if (req.method === "POST" && (req.url === "/api/set-urls" || req.url === "/api/set-video-url" || req.url === "/api/set-model-url")) {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const data = JSON.parse(body || "{}");
        if (data.videoUrl) state?.setVideoUrl?.(String(data.videoUrl).trim());
        if (data.modelUrl) state?.setModelUrl?.(String(data.modelUrl).trim());
        await state?.flush?.();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          success: true,
          videoUrl: state?.getVideoUrl?.(),
          modelUrl: state?.getModelUrl?.(),
        }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.url === "/upload" || req.url === "/webup" || req.url === "/trangup") {
    const videoPath = (state && typeof state.getVideoPath === "function")
      ? state.getVideoPath()
      : resolve(process.cwd(), "assets", "locket-video.mp4");
    const modelPath = (state && typeof state.getModelPath === "function")
      ? state.getModelPath()
      : resolve(process.cwd(), "assets", "locket-model.mobileconfig");
    const videoExists = existsSync(videoPath);
    const videoSize = videoExists ? (statSync(videoPath).size / (1024 * 1024)).toFixed(2) + " MB" : "Chưa có";
    const modelExists = existsSync(modelPath);
    const modelSize = modelExists ? (statSync(modelPath).size / 1024).toFixed(2) + " KB" : "Chưa có";
    const currentVideoUrl = state?.getVideoUrl?.() ?? "https://zalo-link-guard-1.onrender.com/download/video";
    const currentModelUrl = state?.getModelUrl?.() ?? "https://zalo-link-guard-1.onrender.com/download/model";

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(`<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <title>Locket Gold - Tải Lên Video & Model Cấu Hình</title>
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #0b0f19; color: #f1f5f9; margin: 0; padding: 16px; display: flex; justify-content: center; }
    .container { max-width: 580px; width: 100%; margin-top: 10px; }
    .header { text-align: center; margin-bottom: 24px; }
    .header h1 { font-size: 22px; margin: 0 0 8px; color: #fff; display: flex; align-items: center; justify-content: center; gap: 8px; }
    .header p { color: #94a3b8; font-size: 14px; margin: 0; }
    .card { background: #1e293b; border-radius: 16px; padding: 20px; margin-bottom: 20px; border: 1px solid #334155; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.3); }
    .card h2 { font-size: 16px; margin: 0 0 12px; color: #38bdf8; display: flex; align-items: center; gap: 8px; }
    .info-badge { display: flex; justify-content: space-between; align-items: center; background: #0f172a; padding: 10px 14px; border-radius: 10px; margin-bottom: 14px; font-size: 13px; border: 1px solid #1e293b; }
    .badge-label { color: #94a3b8; }
    .badge-val { color: #34d399; font-weight: 600; font-family: monospace; }
    .file-input-wrapper { position: relative; margin-bottom: 14px; }
    input[type="file"] { display: none; }
    .file-btn { display: block; width: 100%; background: #2563eb; color: #fff; text-align: center; padding: 12px; border-radius: 10px; font-weight: 600; font-size: 14px; cursor: pointer; transition: background 0.2s; border: none; }
    .file-btn:active { background: #1d4ed8; }
    .selected-name { font-size: 12px; color: #cbd5e1; margin-top: 6px; text-align: center; word-break: break-all; min-height: 18px; }
    .progress-bar-container { width: 100%; height: 8px; background: #334155; border-radius: 9999px; overflow: hidden; margin-top: 10px; display: none; }
    .progress-bar { height: 100%; width: 0%; background: linear-gradient(90deg, #38bdf8, #10b981); transition: width 0.15s ease; }
    .btn-upload { width: 100%; background: #10b981; color: #fff; border: none; padding: 12px; border-radius: 10px; font-weight: 600; font-size: 15px; cursor: pointer; margin-top: 10px; }
    .btn-upload:disabled { background: #475569; cursor: not-allowed; }
    .status-msg { margin-top: 10px; font-size: 13px; text-align: center; font-weight: 500; }
    .form-group { margin-bottom: 12px; }
    .form-group label { display: block; font-size: 13px; color: #cbd5e1; margin-bottom: 6px; }
    .form-control { width: 100%; background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 10px 12px; color: #fff; font-size: 13px; outline: none; }
    .form-control:focus { border-color: #38bdf8; }
    .btn-save { width: 100%; background: #6366f1; color: #fff; border: none; padding: 10px; border-radius: 8px; font-weight: 600; font-size: 14px; cursor: pointer; }
    .guide-box { background: #0f172a; border-radius: 12px; padding: 14px; font-size: 13px; color: #94a3b8; border: 1px solid #1e293b; line-height: 1.6; }
    .guide-box code { background: #1e293b; color: #f43f5e; padding: 2px 6px; border-radius: 4px; font-family: monospace; }
    video { width: 100%; border-radius: 10px; max-height: 240px; background: #000; margin-top: 10px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🛡️ Locket Gold Manager</h1>
      <p>Tải lên video hướng dẫn & file model cấu hình cho bot Zalo</p>
    </div>

    <!-- VIDEO UPLOAD CARD -->
    <div class="card">
      <h2>🎥 Video Hướng Dẫn</h2>
      <div class="info-badge">
        <span class="badge-label">File trên máy chủ:</span>
        <span class="badge-val" id="videoStat">\${videoExists ? "Đã sẵn sàng (" + videoSize + ")" : "Chưa có"}</span>
      </div>

      <label class="file-btn" for="videoFileInput">📁 Chọn Video (.mp4 / Album)</label>
      <input type="file" id="videoFileInput" accept="video/mp4,video/*">
      <div class="selected-name" id="videoFileName">Chưa chọn video nào</div>

      <div class="progress-bar-container" id="videoProgressWrap">
        <div class="progress-bar" id="videoProgress"></div>
      </div>

      <button class="btn-upload" id="videoUploadBtn" disabled onclick="uploadFile('video')">🚀 Bắt Đầu Tải Video Lên</button>
      <div class="status-msg" id="videoMsg"></div>

      \${videoExists ? '<video controls preload="metadata" src="/download/video"></video>' : ''}
    </div>

    <!-- MODEL UPLOAD CARD -->
    <div class="card">
      <h2>⚙️ File Model Cấu Hình</h2>
      <div class="info-badge">
        <span class="badge-label">File trên máy chủ:</span>
        <span class="badge-val" id="modelStat">\${modelExists ? "Đã sẵn sàng (" + modelSize + ")" : "Chưa có"}</span>
      </div>

      <label class="file-btn" for="modelFileInput" style="background:#0284c7;">📁 Chọn File (.conf / .mobileconfig)</label>
      <input type="file" id="modelFileInput" accept=".conf,.mobileconfig,text/plain">
      <div class="selected-name" id="modelFileName">Chưa chọn file cấu hình nào</div>

      <div class="progress-bar-container" id="modelProgressWrap">
        <div class="progress-bar" id="modelProgress"></div>
      </div>

      <button class="btn-upload" id="modelUploadBtn" style="background:#0284c7;" disabled onclick="uploadFile('model')">🚀 Bắt Đầu Tải Model Lên</button>
      <div class="status-msg" id="modelMsg"></div>
    </div>

    <!-- DIRECT URL CARD -->
    <div class="card">
      <h2>🔗 Hoặc Dán Đường Link Trực Tiếp</h2>
      <div class="form-group">
        <label>Link Video Online (YouTube, TikTok, Drive...):</label>
        <input class="form-control" type="url" id="inputVideoUrl" value="\${currentVideoUrl}">
      </div>
      <div class="form-group">
        <label>Link Model Cấu Hình (Để khách sao chép):</label>
        <input class="form-control" type="url" id="inputModelUrl" value="\${currentModelUrl}">
      </div>
      <button class="btn-save" onclick="saveUrls()">💾 Lưu Đường Link</button>
      <div class="status-msg" id="urlMsg"></div>
    </div>

    <div class="guide-box">
      💡 <b>Mẹo nhanh:</b> Sau khi tải lên thành công, bot sẽ tự động dùng video và link cấu hình này mỗi khi bạn gõ <code>/duyetlocket &lt;UID&gt;</code>.<br>
      Bạn cũng có thể gửi video trực tiếp trong Zalo với caption <code>/upvideo</code> hoặc gõ <code>/upvideo &lt;link&gt;</code>.
    </div>
  </div>

  <script>
    const vInput = document.getElementById('videoFileInput');
    const vName = document.getElementById('videoFileName');
    const vBtn = document.getElementById('videoUploadBtn');
    vInput.addEventListener('change', () => {
      if (vInput.files.length) {
        vName.textContent = vInput.files[0].name + " (" + (vInput.files[0].size / (1024*1024)).toFixed(2) + " MB)";
        vBtn.disabled = false;
      }
    });

    const mInput = document.getElementById('modelFileInput');
    const mName = document.getElementById('modelFileName');
    const mBtn = document.getElementById('modelUploadBtn');
    mInput.addEventListener('change', () => {
      if (mInput.files.length) {
        mName.textContent = mInput.files[0].name + " (" + (mInput.files[0].size / 1024).toFixed(2) + " KB)";
        mBtn.disabled = false;
      }
    });

    function uploadFile(type) {
      const input = type === 'video' ? vInput : mInput;
      const file = input.files[0];
      if (!file) return;

      const progressWrap = document.getElementById(type + 'ProgressWrap');
      const progressBar = document.getElementById(type + 'Progress');
      const msg = document.getElementById(type + 'Msg');
      const btn = document.getElementById(type + 'UploadBtn');

      btn.disabled = true;
      progressWrap.style.display = 'block';
      progressBar.style.width = '0%';
      msg.textContent = '⏳ Đang tải lên máy chủ...';
      msg.style.color = '#38bdf8';

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload?type=' + type + '&filename=' + encodeURIComponent(file.name));

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const percent = Math.round((e.loaded / e.total) * 100);
          progressBar.style.width = percent + '%';
          msg.textContent = '⏳ Đang tải: ' + percent + '% (' + (e.loaded/(1024*1024)).toFixed(1) + 'MB / ' + (e.total/(1024*1024)).toFixed(1) + 'MB)';
        }
      };

      xhr.onload = () => {
        if (xhr.status === 200) {
          progressBar.style.width = '100%';
          msg.textContent = '🎉 Tải lên thành công! Bot đã cập nhật ' + (type === 'video' ? 'video' : 'model') + ' mới.';
          msg.style.color = '#34d399';
          setTimeout(() => window.location.reload(), 1500);
        } else {
          msg.textContent = '❌ Lỗi tải lên: ' + xhr.responseText;
          msg.style.color = '#f87171';
          btn.disabled = false;
        }
      };

      xhr.onerror = () => {
        msg.textContent = '❌ Mất kết nối tới máy chủ khi đang tải lên!';
        msg.style.color = '#f87171';
        btn.disabled = false;
      };

      xhr.send(file);
    }

    async function saveUrls() {
      const vUrl = document.getElementById('inputVideoUrl').value.trim();
      const mUrl = document.getElementById('inputModelUrl').value.trim();
      const msg = document.getElementById('urlMsg');
      msg.textContent = '⏳ Đang lưu...';
      msg.style.color = '#38bdf8';
      try {
        const res = await fetch('/api/set-urls', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoUrl: vUrl, modelUrl: mUrl })
        });
        const data = await res.json();
        if (data.success) {
          msg.textContent = '✅ Đã lưu cấu hình đường link thành công!';
          msg.style.color = '#34d399';
        } else {
          msg.textContent = '❌ Lỗi: ' + data.error;
          msg.style.color = '#f87171';
        }
      } catch (err) {
        msg.textContent = '❌ Lỗi kết nối: ' + err.message;
        msg.style.color = '#f87171';
      }
    }
  </script>
</body>
</html>`);
  }

  if (req.url === "/debug" || req.url === "/status") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({
      version,
      uptime: Math.floor(process.uptime()),
      botStatus,
      botError,
      lastMessageAt: lastMessageTime,
      config: {
        groupIds: config?.groupIds,
        trustedUserIds: config?.trustedUserIds,
        allowedDomains: config?.allowedDomains,
        blockImages: config?.blockImages,
        blockZaloLinks: config?.blockZaloLinks,
        blockZaloGroupInvites: config?.blockZaloGroupInvites,
        silentModeration: config?.silentModeration,
        dryRun: config?.dryRun,
        autoKick: config?.autoKick,
        maxViolations: config?.maxViolations,
      },
      stats: {
        seenCount: seenMessages.size,
        messagesInFlight: messagesInFlight.size,
        monitoredGroupsCount: config?.groupIds?.length ?? 0,
        violationsCount: state?.listViolations?.()?.length ?? 0,
        broadcastTargetsCount: broadcaster?.store?.data?.targetGroups?.length ?? 0,
        broadcastCampaignStatus: broadcaster?.store?.data?.campaign?.status ?? "none",
        broadcastDailyCount: broadcaster?.store?.data?.dailyCounter?.count ?? 0,
        joinQueueCount: broadcaster?.joinQueue?.length ?? 0,
      },
      recentLogs: logBuffer.slice(-50),
    }, null, 2));
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <title>Zalo Link Guard Bot</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; }
    .card { background: #1e293b; border-radius: 16px; padding: 32px; max-width: 480px; width: 100%; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.5); border: 1px solid #334155; }
    .status { display: inline-flex; align-items: center; gap: 8px; background: ${botStatus === "đang_hoạt_động" ? "#064e3b" : "#7f1d1d"}; color: ${botStatus === "đang_hoạt_động" ? "#34d399" : "#fca5a5"}; padding: 6px 14px; border-radius: 9999px; font-weight: 600; font-size: 14px; margin-bottom: 20px; }
    .status-dot { width: 10px; height: 10px; border-radius: 50%; background: ${botStatus === "đang_hoạt_động" ? "#10b981" : "#ef4444"}; box-shadow: 0 0 10px ${botStatus === "đang_hoạt_động" ? "#10b981" : "#ef4444"}; }
    h1 { font-size: 22px; margin: 0 0 8px; color: #fff; }
    p { color: #94a3b8; font-size: 14px; margin: 0 0 20px; }
    .info-row { display: flex; justify-content: space-between; padding: 10px 0; border-top: 1px solid #334155; font-size: 14px; }
    .info-label { color: #64748b; }
    .info-value { color: #cbd5e1; font-weight: 500; font-family: monospace; }
  </style>
</head>
<body>
  <div class="card">
    <div class="status"><span class="status-dot"></span> ${botStatus.toUpperCase()}</div>
    <h1>🛡️ Zalo Link Guard Bot</h1>
    <p>Hệ thống tự động lọc link quảng cáo & chặn spam ảnh Zalo.</p>
    <div class="info-row"><span class="info-label">Phiên bản:</span><span class="info-value">v${version}</span></div>
    <div class="info-row"><span class="info-label">Nhóm theo dõi:</span><span class="info-value">${config?.groupIds?.length ?? 0} nhóm</span></div>
    <div class="info-row"><span class="info-label">Uptime:</span><span class="info-value">${Math.floor(process.uptime())}s</span></div>
    <div class="info-row"><span class="info-label">Chế độ chặn ảnh:</span><span class="info-value">${config?.blockImages !== false ? "BẬT" : "TẮT"}</span></div>
    ${botError ? `<div class="info-row" style="color:#f87171;"><span class="info-label" style="color:#f87171;">Lỗi:</span><span class="info-value">${botError}</span></div>` : ""}
  </div>
</body>
</html>`);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[HTTP SERVER] Đang lắng nghe trên cổng ${PORT} (phục vụ Render web service & UptimeRobot /ping).`);
});
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
      (config.silentModeration !== undefined && typeof config.silentModeration !== "boolean") ||
      (config.autoKick !== undefined && typeof config.autoKick !== "boolean") ||
      (config.maxViolations !== undefined && (!Number.isInteger(config.maxViolations) || config.maxViolations < 1 || config.maxViolations > 10)) ||
      (config.blockZaloLinks !== undefined && typeof config.blockZaloLinks !== "boolean") ||
      (config.blockZaloGroupInvites !== undefined && typeof config.blockZaloGroupInvites !== "boolean") ||
      (config.reviewGroupId !== undefined && (typeof config.reviewGroupId !== "string" || !config.reviewGroupId.trim() ||
        config.groupIds.includes(config.reviewGroupId))) ||
      (config.violationWindowHours !== undefined && (!Number.isInteger(config.violationWindowHours) ||
        config.violationWindowHours < 1 || config.violationWindowHours > 168)) ||
      (config.aiDmUserIds !== undefined && !validIds(config.aiDmUserIds)) ||
      (config.adminOnly !== undefined && typeof config.adminOnly !== "boolean") ||
      (config.historySweepSeconds !== undefined && (config.historySweepSeconds !== 0 &&
        (!Number.isInteger(config.historySweepSeconds) || config.historySweepSeconds < 30 || config.historySweepSeconds > 300)))) {
    console.error("Cấu hình không hợp lệ. Kiểm tra groupIds, trustedUserIds, allowedDomains, blockImages, reviewGroupId, violationWindowHours và dryRun trong config.json.");
    process.exit(1);
  }
  if (config.silentModeration === undefined) {
    config.silentModeration = true;
  }
}

let state = null;
if (!listingGroups) {
  try {
    const opened = await createModerationState({ windowHours: config.violationWindowHours ?? 24 });
    state = opened.state;
    console.log(`[LƯU VI PHẠM] ${opened.storage}`);
    if (process.env.RENDER === "true" && !process.env.DATABASE_URL && !process.env.STATE_DIR) {
      console.warn("[LƯU VI PHẠM] Gợi ý: SESSION_JSON giữ đăng nhập. Có thể gắn thêm DATABASE_URL (PostgreSQL) hoặc Render Persistent Disk + STATE_DIR nếu muốn số lần vi phạm không mất khi khởi động lại.");
    }
    const restoredCount = state.listViolations().reduce((sum, item) => sum + item.count, 0);
    console.log(`[LƯU VI PHẠM] đã_khôi_phục=${restoredCount} lượt còn hiệu lực trong ${config.violationWindowHours ?? 24} giờ`);
  } catch (error) {
    console.error(`[LƯU VI PHẠM] Không mở được nơi lưu trạng thái: ${error.message}`);
    process.exit(1);
  }
}

const qrPath = resolve(process.cwd(), "zalo-login-qr.png");
const zalo = new Zalo({ selfListen: true });
let api;
try {
  api = await loginWithSession({
    zalo,
    sessionJson: process.env.SESSION_JSON,
    qrPath,
    sessionPath: resolve(process.cwd(), "zalo-session.json"),
    isRender: process.env.RENDER === "true" || Boolean(process.env.RENDER),
  });
  botStatus = "đang_hoạt_động";
} catch (error) {
  botStatus = "lỗi_đăng_nhập";
  botError = error.message;
  console.error(`[ĐĂNG NHẬP] ${error.message}`);
  if (process.env.RENDER === "true") {
    console.error("[ĐĂNG NHẬP] Đang giữ HTTP server để Render không bị crash loop. Hãy cập nhật SESSION_JSON mới trên Render dashboard!");
    await new Promise(() => {});
  } else {
    process.exit(1);
  }
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
console.log(`[VI PHẠM & KICK] maxViolations=${config.maxViolations ?? 3}; autoKick=${config.autoKick !== false} (vi phạm 3 lần kick).`);
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
const aiService = new AIService({
  geminiApiKey: process.env.GEMINI_API_KEY || config.geminiApiKey,
  geminiModel: process.env.GEMINI_MODEL || config.geminiModel || "gemini-3.5-flash",
});
console.log(`[TRỢ LÝ AI] Động cơ AI: ${aiService.getProviderName()} (Sẵn sàng phục vụ nhóm)`);
const dmAllowed = Array.isArray(config.aiDmUserIds) && config.aiDmUserIds.length > 0 ? config.aiDmUserIds : (config.trustedUserIds || []);
console.log(`[TRỢ LÝ AI] Nhắn tin riêng (DM): Chỉ mở quyền cho ${dmAllowed.length} tài khoản điều hành.`);

const moderation = createModeration({ api, config, state, aiService });

const broadcastStatePath = process.env.STATE_DIR
  ? resolve(process.env.STATE_DIR, "broadcast-state.json")
  : resolve(process.cwd(), "broadcast-state.json");
const broadcaster = createBroadcaster({
  api,
  config,
  filePath: broadcastStatePath,
  log: console,
});
console.log(`[RẢI LINK] Module Rải Link sẵn sàng (Mục tiêu: ${broadcaster.store.data.targetGroups.length} nhóm).`);

// Đồng bộ các nhóm đã được Chủ sở hữu bật bot (từ config.json và state.activeGroups)
async function syncProtectedGroups() {
  try {
    const activeFromState = state?.data?.activeGroups || [];
    for (const gid of activeFromState) {
      if (!config.groupIds.includes(String(gid))) {
        config.groupIds.push(String(gid));
      }
    }
    console.log(`[QUẢN LÝ NHÓM] Đang bảo vệ ${config.groupIds.length} nhóm được kích hoạt chính thức.`);
  } catch (err) {
    console.warn("[QUẢN LÝ NHÓM] Lỗi đồng bộ nhóm được kích hoạt:", err.message);
  }
}
void syncProtectedGroups();

const seenMessages = new Map();
const messagesInFlight = new Set();
function markSeen(messageKey) {
  if (!messageKey) return;
  seenMessages.set(messageKey, Date.now());
  if (seenMessages.size > 5000) seenMessages.delete(seenMessages.keys().next().value);
}

async function processMessage(message, { source = "live" } = {}) {
  lastMessageTime = new Date().toISOString();
  if (source === "live" && await broadcaster.handleCommand(message)) return;
  if (source === "live" && await moderation.handleCommand(message)) return;
  if (message.type !== ThreadType.Group) return;
  if (state?.isGroupDisabled?.(String(message.threadId))) return;
  if (source === "history" && typeof message.data?.content === "string" &&
      /^\s*\/(?:kick|duyetkick|tuchoikick|vipham|tha|xoavipham|tatbot|offbot|pause|batbot|onbot|resume|status|botinfo|help|myid|ai|ask|chat|gemini|chiqtv|qtvonly|adminonly|khoachat|lockchat|mochat|unlockchat|khoaqtv|lockqtv|strictqtv|themuser|adduser|thembotuser|xoauser|deluser|xoabotuser|removeuser|dsuser|listuser|userlist|mute|camchat|unmute|mopchat|bomute|dsmute|listmute|dsbicam|railink|stoprai|trangthairai|dsnhom|danhsachnhom|themtarget|xoatarget|joinnhom|quetnhom|quetlink|locnhom|donnhom|gioihanrai|limitrai|setlimit|locketgold|locket|duyetlocket|tuchoilocket|dslocket|locketlist|sethuongdan|xemhuongdan|resethuongdan|setmodel|capnhatmodel|xemmodel|setvideo|capnhatvideo|xemvideo|upvideo|uploadvideo|taivideo|upmodel|taimodel|upload|webup|trangup)(?:\s|$)/i.test(message.data.content)) return;
  const messageKey = message.data?.msgId && `${message.threadId}:${message.data.msgId}`;
  if (messageKey && (seenMessages.has(messageKey) || messagesInFlight.has(messageKey))) return;

  const isTargetGroup = config.groupIds.includes(String(message.threadId)) || Boolean(state?.isGroupActive?.(message.threadId, config.groupIds));
  if (!isTargetGroup) return; // Chống bật bot bừa bãi: Chỉ xử lý nhóm đã được kích hoạt

  // Kiểm tra thành viên có đang bị cấm chat (Mute) trong nhóm này không
  const isMuted = state?.isMemberMuted?.(String(message.threadId), String(message.data?.uidFrom));
  if (isMuted) {
    const { msgId, cliMsgId, uidFrom } = message.data || {};
    const details = `thành_viên_bị_mute=${uidFrom} nhóm=${message.threadId} tin=${msgId}`;
    console.log(`[CẤM CHAT - MUTE] Phát hiện tin nhắn từ ${details} -> Đang tiến hành xóa tức thì...`);
    try {
      await api.deleteMessage({
        type: ThreadType.Group,
        threadId: message.threadId,
        data: { msgId, cliMsgId, uidFrom },
      }, false);
      console.log(`[ĐÃ XÓA TIN MUTE] Thành công: ${details}`);
    } catch (err) {
      if (typeof api.undo === "function") {
        try {
          await api.undo({ msgId, cliMsgId }, message.threadId, ThreadType.Group);
          console.log(`[ĐÃ THU HỒI TIN MUTE] Thành công: ${details}`);
        } catch (uErr) {
          console.error(`[LỖI XÓA TIN MUTE] ${details}:`, uErr.message);
        }
      }
    }
    markSeen(messageKey);
    return;
  }

  const isImage = isImageMessage(message);
  const links = extractMessageLinks(message);
  if (isImage || links.length > 0) {
    const isTrusted = config.trustedUserIds.includes(String(message.data?.uidFrom));
    if (isTrusted) {
      console.log(`[LỌC TIN] Nhóm ${message.threadId}: Người gửi ${message.data?.uidFrom} thuộc danh sách tin cậy (trustedUserIds) -> BỎ QUA.`);
    }
  }

  const result = checkMessage(message, config);
  if (!result) return;

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
      console.log(`[LỌC TIN] Nhóm ${message.threadId}: Người gửi ${uidFrom} là Trưởng/Phó nhóm -> BỎ QUA.`);
      markSeen(messageKey);
      return;
    }
    if (config.dryRun) {
      console.log(`[XEM TRƯỚC] Sẽ xóa ${details}`);
    } else {
      console.log(`[ĐANG TIẾN HÀNH XÓA] ${details}`);
      let response;
      let deleteSuccess = false;
      try {
        response = await api.deleteMessage({
          type: ThreadType.Group,
          threadId: message.threadId,
          data: { msgId, cliMsgId, uidFrom },
        }, false);
        deleteSuccess = true;
        console.log(`[ĐÃ XÓA XONG] ${details} trạng thái API: ${JSON.stringify(response)}`);
      } catch (error) {
        console.error(`[LỖI XÓA] ${details}:`, error.message);
        if (error.message?.includes("Không thể nhận tin nhắn") || String(error.code) === "123") {
          console.warn(`[RATE LIMIT ZALO] ${details}: Nick bot đang bị Zalo tạm khóa tương tác nhóm ("Đạt giới hạn rồi"). Lượt vi phạm vẫn được ghi nhận.`);
        }
        // Phương án 2: Thử gọi api.undo (thu hồi) nếu deleteMessage bị Zalo từ chối
        if (typeof api.undo === "function") {
          try {
            console.log(`[THỬ THU HỒI - UNDO] ${details}`);
            response = await api.undo({ msgId, cliMsgId }, message.threadId, ThreadType.Group);
            deleteSuccess = true;
            console.log(`[ĐÃ THU HỒI XONG] ${details} trạng thái API: ${JSON.stringify(response)}`);
          } catch (undoErr) {
            console.error(`[LỖI THU HỒI - UNDO] ${details}:`, undoErr.message);
          }
        }
        if (!deleteSuccess) {
          if (result.links.length) await moderation.onViolation(message, result);
          return;
        }
      }
    }
    markSeen(messageKey);
    if (result.links.length) await moderation.onViolation(message, result);
  } finally {
    if (messageKey) messagesInFlight.delete(messageKey);
  }
}

let isReconnecting = false;
let reconnectTimer = null;

function safeReconnect(delay = 5000) {
  if (isReconnecting) return;
  isReconnecting = true;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    try {
      console.log(`[KẾT NỐI] Đang kích hoạt lại listener sau ${delay / 1000}s...`);
      api.listener.start({ retryOnClose: true });
    } catch (err) {
      console.error("[KẾT NỐI] Không thể restart listener:", err.message);
    } finally {
      isReconnecting = false;
    }
  }, delay);
}

api.listener.on("message", (message) => {
  void processMessage(message).catch((error) => console.error("Lỗi xử lý tin nhắn:", error));
});
api.listener.on("error", (error) => console.error("Lỗi kết nối Zalo:", error));
api.listener.on("connected", () => {
  botStatus = "đang_hoạt_động";
  isReconnecting = false;
  clearTimeout(reconnectTimer);
  console.log("[KẾT NỐI] Đã nhận tin mới từ Zalo.");
});
api.listener.on("disconnected", (code) => console.warn(`[KẾT NỐI] Bị ngắt; mã=${code}.`));
api.listener.on("closed", (code) => {
  console.warn(`[KẾT NỐI] Đã đóng; mã=${code}. Đang lên lịch kết nối lại an toàn...`);
  safeReconnect(5000);
});
api.listener.start({ retryOnClose: true });
if (config.historySweepSeconds !== 0) {
  const seconds = config.historySweepSeconds ?? 60;
  const sweepHistory = createHistorySweep({
    api, groupIds: config.groupIds, startedAt, processMessage,
  });
  setInterval(() => void sweepHistory(), seconds * 1000).unref();
  console.log(`Đang kiểm tra bổ sung 50 tin gần nhất mỗi ${seconds} giây để bắt tin mới bị lỡ.`);
}
