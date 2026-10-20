import { chmod, unlink, writeFile } from "node:fs/promises";
import { LoginQRCallbackEventType } from "zca-js";

export function parseSessionJson(raw) {
  let session;
  try {
    session = JSON.parse(raw);
  } catch {
    throw new Error("SESSION_JSON không phải JSON hợp lệ.");
  }
  const cookies = Array.isArray(session?.cookie) ? session.cookie : session?.cookie?.cookies;
  if (typeof session?.imei !== "string" || !session.imei.trim() ||
      typeof session?.userAgent !== "string" || !session.userAgent.trim() ||
      !Array.isArray(cookies) || !cookies.length ||
      !cookies.some((item) => item && typeof item.value === "string" &&
        typeof (item.key ?? item.name) === "string")) {
    throw new Error("SESSION_JSON cần cookie, imei và userAgent hợp lệ.");
  }
  return {
    cookie: session.cookie,
    imei: session.imei,
    userAgent: session.userAgent,
    language: session.language || "vi",
  };
}

export async function loginWithSession({ zalo, sessionJson, qrPath, sessionPath,
  isRender = false, log = console }) {
  if (sessionJson !== undefined) {
    const credentials = parseSessionJson(sessionJson);
    try {
      const api = await zalo.login(credentials);
      log.info("Đã đăng nhập bằng SESSION_JSON.");
      return api;
    } catch {
      throw new Error("SESSION_JSON đã hết hạn hoặc Zalo từ chối. Tạo phiên mới bằng QR trên máy cá nhân rồi cập nhật biến trên Render.");
    }
  }

  if (isRender) {
    throw new Error("Thiếu SESSION_JSON trên Render. Quét QR trên máy cá nhân để tạo zalo-session.json, rồi thêm nội dung file vào biến môi trường SESSION_JSON.");
  }

  let qrCredentials;
  log.info("Đang tạo mã QR đăng nhập...");
  let api;
  try {
    api = await zalo.loginQR({ qrPath }, async (event) => {
      if (event.type === LoginQRCallbackEventType.QRCodeGenerated) {
        await event.actions.saveToFile(qrPath);
        log.info(`Mở ${qrPath} và quét bằng tài khoản Zalo quản trị nhóm.`);
      } else if (event.type === LoginQRCallbackEventType.QRCodeExpired) {
        log.info("Mã QR hết hạn, đang tạo lại...");
        event.actions.retry();
      } else if (event.type === LoginQRCallbackEventType.GotLoginInfo) {
        qrCredentials = event.data;
      }
    });
  } finally {
    await unlink(qrPath).catch(() => {});
  }

  if (!qrCredentials) {
    log.warn("Đăng nhập QR thành công nhưng thư viện không trả thông tin để xuất phiên.");
    return api;
  }
  let refreshedCookies;
  try {
    refreshedCookies = api.getCookie?.()?.serializeSync?.()?.cookies;
  } catch {
    // QR callback cookies remain usable if this library version cannot export the jar.
  }
  const credentials = {
    cookie: Array.isArray(refreshedCookies) && refreshedCookies.length
      ? refreshedCookies : qrCredentials.cookie,
    imei: qrCredentials.imei,
    userAgent: qrCredentials.userAgent,
  };
  parseSessionJson(JSON.stringify(credentials));
  try {
    await writeFile(sessionPath, `${JSON.stringify(credentials)}\n`, { mode: 0o600 });
    await chmod(sessionPath, 0o600);
    log.info(`Đã lưu phiên vào ${sessionPath}. Sao chép nội dung file vào SESSION_JSON trên Render; không gửi file này cho người khác.`);
  } catch {
    log.warn("Đăng nhập thành công nhưng không lưu được zalo-session.json. Kiểm tra quyền ghi trong thư mục bot.");
  }
  return api;
}
