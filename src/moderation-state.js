import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_LOCKET_INSTRUCTION = `💛 HƯỚNG DẪN KÍCH HOẠT LOCKET GOLD (VIP) TRỌN ĐỜI 💛
(Hỗ trợ thiết bị iPhone / iPad)

📌 Bạn chỉ cần thực hiện 5 bước đơn giản dưới đây (chỉ làm 1 lần duy nhất):

Bước 1: Cài đặt ứng dụng
- Tải ứng dụng Shadowrocket trên App Store (Nếu máy bạn chưa có, vui lòng nhắn lại cho Shop để lấy ID Apple tải miễn phí).

Bước 2: Cài đặt Cấu hình & Tải Chứng chỉ
- Mở app Shadowrocket ➡️ Vào tab "Cấu hình" (Config).
- Chọn cấu hình Locket Gold (ví dụ: 10in1.conf).
- Bấm vào tên cấu hình ➡️ Chọn "Giải mã HTTPS" (HTTPS Decryption).
- Bật công tắc "Giải mã HTTPS" sang màu xanh.
- Bấm vào mục "Chứng chỉ" (Certificate) ➡️ Chọn "Cài đặt Chứng chỉ CA vào Hệ thống" (Install CA to System) ➡️ Bấm "Cho phép" (Allow) để tải hồ sơ về máy.

Bước 3: Cài đặt Hồ sơ trên iPhone
- Mở ứng dụng "Cài đặt" (Settings) của iPhone.
- Bấm vào mục "Đã tải về hồ sơ" (nằm ngay dưới tên Apple ID của bạn).
- Bấm "Cài đặt" ở góc trên bên phải ➡️ Nhập mật mã màn hình iPhone (nếu có) ➡️ Xác nhận Cài đặt hoàn tất.

Bước 4: Kích hoạt Tin Cậy Chứng Chỉ (BƯỚC QUAN TRỌNG NHẤT!)
- Trong "Cài đặt" iPhone ➡️ Vào "Cài đặt chung" (General).
- Chọn "Giới thiệu" (About) ➡️ Cuộn xuống dưới cùng chọn "Cài đặt tin cậy chứng nhận" (Certificate Trust Settings).
- Tại mục "Tin cậy hoàn toàn các chứng chỉ gốc", tìm chứng chỉ Shadowrocket ➡️ GẠT CÔNG TẮC SANG MÀU XANH (BẬT) ➡️ Chọn "Tiếp tục".

Bước 5: Kích hoạt VPN & Tận hưởng
- Mở lại app Shadowrocket ➡️ Ở tab Trang chủ, gạt công tắc "Kết nối" (Connect VPN) sang màu xanh.
- Mở ứng dụng Locket ➡️ Bạn sẽ thấy biểu tượng Locket Gold xuất hiện với đầy đủ đặc quyền cao cấp (huy hiệu Gold, xem ai xem hồ sơ, phóng to ảnh, đăng ảnh không giới hạn,...).

✨ Chúc bạn có trải nghiệm tuyệt vời với Locket Gold! Nếu gặp khó khăn ở bước nào, hãy nhắn tin trực tiếp cho Shop để được hỗ trợ 1-1 nhé!`;

export class ModerationState {
  constructor(filePath, { now = Date.now, windowHours = 24, initialData, saveHook } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.windowMs = windowHours * 60 * 60 * 1000;
    this.saveHook = saveHook;
    this.pendingSave = Promise.resolve();
    this.data = initialData ?? (existsSync(filePath)
      ? JSON.parse(readFileSync(filePath, "utf8"))
      : { version: 1, incidents: [], cases: [], manualKicks: [], disabledGroups: [] });
    if (this.data.version !== 1 || !Array.isArray(this.data.incidents) ||
        !Array.isArray(this.data.cases) || !Array.isArray(this.data.manualKicks)) {
      throw new Error("File moderation-state.json không hợp lệ; bot dừng để tránh xử lý sai.");
    }
    if (!Array.isArray(this.data.disabledGroups)) {
      this.data.disabledGroups = [];
    }
    if (!Array.isArray(this.data.adminOnlyGroups)) {
      this.data.adminOnlyGroups = [];
    }
    if (!Array.isArray(this.data.allowedUserIds)) {
      this.data.allowedUserIds = [];
    }
    if (!Array.isArray(this.data.strictAdminOnlyGroups)) {
      this.data.strictAdminOnlyGroups = [];
    }
    if (!Array.isArray(this.data.activeGroups)) {
      this.data.activeGroups = [];
    }
    if (!Array.isArray(this.data.mutedMembers)) {
      this.data.mutedMembers = [];
    }
    if (!Array.isArray(this.data.locketOrders)) {
      this.data.locketOrders = [];
    }
    if (typeof this.data.locketInstruction !== "string") {
      this.data.locketInstruction = "";
    }
  }

  isGroupDisabled(groupId) {
    return this.data.disabledGroups.includes(String(groupId));
  }

  disableGroup(groupId) {
    const gid = String(groupId);
    if (!this.data.disabledGroups.includes(gid)) {
      this.data.disabledGroups.push(gid);
      this.save();
    }
    return true;
  }

  enableGroup(groupId) {
    const gid = String(groupId);
    this.data.disabledGroups = this.data.disabledGroups.filter((id) => id !== gid);
    this.save();
    return true;
  }

  isAdminOnly(groupId) {
    return Array.isArray(this.data.adminOnlyGroups) && this.data.adminOnlyGroups.includes(String(groupId));
  }

  setAdminOnly(groupId, enabled = true) {
    const gid = String(groupId);
    if (!Array.isArray(this.data.adminOnlyGroups)) {
      this.data.adminOnlyGroups = [];
    }
    if (enabled) {
      if (!this.data.adminOnlyGroups.includes(gid)) {
        this.data.adminOnlyGroups.push(gid);
        this.save();
      }
    } else {
      this.data.adminOnlyGroups = this.data.adminOnlyGroups.filter((id) => id !== gid);
      this.save();
    }
    return true;
  }

  getAllowedUsers() {
    return Array.isArray(this.data.allowedUserIds) ? [...this.data.allowedUserIds] : [];
  }

  isUserAllowed(userId) {
    return Array.isArray(this.data.allowedUserIds) && this.data.allowedUserIds.includes(String(userId));
  }

  addAllowedUser(userId) {
    const uid = String(userId).trim();
    if (!uid) return false;
    if (!Array.isArray(this.data.allowedUserIds)) {
      this.data.allowedUserIds = [];
    }
    if (!this.data.allowedUserIds.includes(uid)) {
      this.data.allowedUserIds.push(uid);
      this.save();
      return true;
    }
    return false;
  }

  removeAllowedUser(userId) {
    const uid = String(userId).trim();
    if (!Array.isArray(this.data.allowedUserIds)) return false;
    if (this.data.allowedUserIds.includes(uid)) {
      this.data.allowedUserIds = this.data.allowedUserIds.filter((id) => id !== uid);
      this.save();
      return true;
    }
    return false;
  }

  isStrictAdminOnly(groupId) {
    return Array.isArray(this.data.strictAdminOnlyGroups) && this.data.strictAdminOnlyGroups.includes(String(groupId));
  }

  setStrictAdminOnly(groupId, enabled = true) {
    const gid = String(groupId);
    if (!Array.isArray(this.data.strictAdminOnlyGroups)) {
      this.data.strictAdminOnlyGroups = [];
    }
    if (enabled) {
      if (!this.data.strictAdminOnlyGroups.includes(gid)) {
        this.data.strictAdminOnlyGroups.push(gid);
        this.save();
      }
    } else {
      this.data.strictAdminOnlyGroups = this.data.strictAdminOnlyGroups.filter((id) => id !== gid);
      this.save();
    }
    return true;
  }

  isGroupActive(groupId, configuredGroupIds = []) {
    const gid = String(groupId);
    if (this.isGroupDisabled(gid)) return false;
    if (Array.isArray(configuredGroupIds) && configuredGroupIds.includes(gid)) return true;
    return Array.isArray(this.data.activeGroups) && this.data.activeGroups.includes(gid);
  }

  activateGroup(groupId) {
    const gid = String(groupId);
    if (!Array.isArray(this.data.activeGroups)) {
      this.data.activeGroups = [];
    }
    if (!this.data.activeGroups.includes(gid)) {
      this.data.activeGroups.push(gid);
    }
    if (Array.isArray(this.data.disabledGroups)) {
      this.data.disabledGroups = this.data.disabledGroups.filter((id) => id !== gid);
    }
    this.save();
    return true;
  }

  deactivateGroup(groupId) {
    const gid = String(groupId);
    if (Array.isArray(this.data.activeGroups)) {
      this.data.activeGroups = this.data.activeGroups.filter((id) => id !== gid);
    }
    this.disableGroup(gid);
    this.save();
    return true;
  }

  muteMember({ groupId, userId, mutedBy, durationMs, reason = "" }) {
    const gid = String(groupId);
    const uid = String(userId);
    const now = this.now();
    const expiresAt = now + durationMs;
    if (!Array.isArray(this.data.mutedMembers)) {
      this.data.mutedMembers = [];
    }
    this.data.mutedMembers = this.data.mutedMembers.filter((m) => !(m.groupId === gid && m.userId === uid));
    const entry = {
      groupId: gid,
      userId: uid,
      mutedBy: String(mutedBy),
      mutedAt: now,
      expiresAt,
      reason: String(reason || ""),
    };
    this.data.mutedMembers.push(entry);
    this.save();
    return entry;
  }

  unmuteMember(groupId, userId) {
    const gid = String(groupId);
    const uid = String(userId);
    if (!Array.isArray(this.data.mutedMembers)) return false;
    const beforeCount = this.data.mutedMembers.length;
    this.data.mutedMembers = this.data.mutedMembers.filter((m) => !(m.groupId === gid && m.userId === uid));
    const removed = this.data.mutedMembers.length < beforeCount;
    if (removed) {
      this.save();
    }
    return removed;
  }

  isMemberMuted(groupId, userId) {
    const gid = String(groupId);
    const uid = String(userId);
    if (!Array.isArray(this.data.mutedMembers)) return false;
    const now = this.now();
    const entry = this.data.mutedMembers.find((m) => m.groupId === gid && m.userId === uid);
    if (!entry) return false;
    if (entry.expiresAt <= now) {
      this.data.mutedMembers = this.data.mutedMembers.filter((m) => m !== entry);
      this.save();
      return false;
    }
    return true;
  }

  getMutedMembers(groupId) {
    const gid = String(groupId);
    if (!Array.isArray(this.data.mutedMembers)) return [];
    const now = this.now();
    this.data.mutedMembers = this.data.mutedMembers.filter((m) => m.expiresAt > now);
    return this.data.mutedMembers.filter((m) => m.groupId === gid);
  }

  save() {
    if (this.saveHook) {
      const snapshot = structuredClone(this.data);
      // A failed write is reported to its caller. A later snapshot still gets
      // a chance to persist the complete in-memory state after recovery.
      this.pendingSave = this.pendingSave.catch(() => {}).then(() => this.saveHook(snapshot));
      this.pendingSave.catch(() => {}); // Callers observe failures via flush().
      return this.pendingSave;
    }
    const temporary = `${this.filePath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.filePath);
  }

  async flush() {
    await this.pendingSave;
  }

  prune() {
    const now = this.now();
    if (Array.isArray(this.data.mutedMembers)) {
      this.data.mutedMembers = this.data.mutedMembers.filter((item) => item.expiresAt > now);
    }
    this.data.incidents = this.data.incidents.filter((item) => item.at > now - this.windowMs);
    for (const item of this.data.cases) {
      if (item.status === "pending" && item.expiresAt <= now) item.status = "expired";
    }
    this.data.cases = this.data.cases.filter((item) => item.status === "pending" || item.createdAt > now - 30 * DAY_MS);
    this.data.manualKicks = this.data.manualKicks.filter((item) => item.at > now - 30 * DAY_MS).slice(-200);
    if (Array.isArray(this.data.locketOrders)) {
      this.data.locketOrders = this.data.locketOrders.filter(
        (item) => item.status === "pending" || (item.updatedAt || item.createdAt) > now - 60 * DAY_MS
      );
    }
  }

  recordViolation({ groupId, userId, messageId, links, displayName }) {
    this.prune();
    if (this.data.incidents.some((item) => item.groupId === groupId && item.messageId === messageId)) {
      return { duplicate: true };
    }
    const incident = {
      groupId, userId, messageId, displayName, at: this.now(),
      links: links.slice(0, 2).map((item) => item.url.slice(0, 120)),
    };
    this.data.incidents.push(incident);
    const recent = this.data.incidents.filter((item) => item.groupId === groupId && item.userId === userId);
    let pendingCase = this.data.cases.find((item) => item.groupId === groupId && item.userId === userId && item.status === "pending");
    let newCase = false;
    if (recent.length >= 3 && !pendingCase) {
      pendingCase = {
        id: randomBytes(4).toString("hex").toUpperCase(),
        groupId, userId, displayName, status: "pending", createdAt: this.now(),
        expiresAt: this.now() + this.windowMs,
        evidence: recent.slice(-3), notifiedIds: [],
      };
      this.data.cases.push(pendingCase);
      newCase = true;
    }
    this.save();
    return { duplicate: false, count: recent.length, pendingCase, newCase };
  }

  getCase(id) {
    this.prune();
    return this.data.cases.find((item) => item.id === String(id).toUpperCase());
  }

  listPending() {
    this.prune();
    return this.data.cases.filter((item) => item.status === "pending");
  }

  listViolations() {
    this.prune();
    const byMember = new Map();
    const entryFor = (groupId, userId) => {
      const key = JSON.stringify([groupId, userId]);
      if (!byMember.has(key)) byMember.set(key, {
        groupId, userId, count: 0, displayName: undefined, lastAt: 0, pendingCase: null,
      });
      return byMember.get(key);
    };
    for (const incident of this.data.incidents) {
      const entry = entryFor(incident.groupId, incident.userId);
      entry.count++;
      if (incident.at >= entry.lastAt) {
        entry.lastAt = incident.at;
        if (incident.displayName) entry.displayName = incident.displayName;
      }
    }
    for (const item of this.data.cases) {
      if (item.status !== "pending") continue;
      const entry = entryFor(item.groupId, item.userId);
      entry.pendingCase = item;
      if (!entry.displayName) entry.displayName = item.displayName;
      entry.lastAt = Math.max(entry.lastAt, item.createdAt);
    }
    return [...byMember.values()].sort((a, b) => b.lastAt - a.lastAt);
  }

  markNotified(id, adminId) {
    const item = this.getCase(id);
    if (!item || item.status !== "pending") return;
    if (!item.notifiedIds.includes(adminId)) item.notifiedIds.push(adminId);
    this.save();
  }

  setCaseStatus(id, status, extra = {}) {
    const item = this.getCase(id);
    if (!item) return null;
    item.status = status;
    Object.assign(item, extra);
    if (status === "rejected" || status === "kicked") {
      this.data.incidents = this.data.incidents.filter((entry) =>
        entry.groupId !== item.groupId || entry.userId !== item.userId);
    }
    this.save();
    return item;
  }

  clearViolations(groupId, userId) {
    this.prune();
    const removedCount = this.data.incidents.filter((entry) =>
      entry.groupId === groupId && entry.userId === userId).length;
    this.data.incidents = this.data.incidents.filter((entry) =>
      entry.groupId !== groupId || entry.userId !== userId);
    for (const item of this.data.cases) {
      if (item.groupId === groupId && item.userId === userId && item.status === "pending") {
        item.status = "cleared";
        item.clearedAt = this.now();
      }
    }
    this.save();
    return removedCount;
  }

  startManualKick({ groupId, userId, adminId }) {
    this.prune();
    const item = {
      id: randomBytes(6).toString("hex").toUpperCase(),
      groupId, userId, adminId, at: this.now(), status: "executing",
    };
    this.data.manualKicks.push(item);
    this.save();
    return item.id;
  }

  finishManualKick(id, { success, error } = {}) {
    const action = this.data.manualKicks.find((item) => item.id === id);
    if (!action || action.status !== "executing") throw new Error("Không tìm thấy lệnh kick đang chạy.");
    action.status = success ? "kicked" : "failed";
    if (error) action.error = error;
    if (success) {
      for (const item of this.data.cases) {
        if (item.groupId === action.groupId && item.userId === action.userId && item.status === "pending") {
          item.status = "kicked_manually";
          item.reviewedBy = action.adminId;
          item.reviewedAt = this.now();
        }
      }
      this.data.incidents = this.data.incidents.filter((entry) =>
        entry.groupId !== action.groupId || entry.userId !== action.userId);
    }
    this.save();
  }

  createLocketOrder({ uid, name, threadId, type }) {
    this.prune();
    if (!Array.isArray(this.data.locketOrders)) {
      this.data.locketOrders = [];
    }
    const cleanUid = String(uid).trim();
    const now = this.now();
    const existing = this.data.locketOrders.find((o) => String(o.uid) === cleanUid);
    if (existing) {
      if (name && name !== "Khách hàng") existing.name = name;
      existing.updatedAt = now;
      if (threadId) existing.threadId = String(threadId);
      if (type !== undefined) existing.type = type;
      this.save();
      return { order: existing, isNew: false };
    }
    const order = {
      uid: cleanUid,
      name: name || "Khách hàng",
      status: "pending",
      createdAt: now,
      updatedAt: now,
      threadId: threadId ? String(threadId) : null,
      type: type ?? null,
    };
    this.data.locketOrders.push(order);
    this.save();
    return { order, isNew: true };
  }

  getLocketOrder(uid) {
    this.prune();
    if (!Array.isArray(this.data.locketOrders)) return null;
    return this.data.locketOrders.find((o) => String(o.uid) === String(uid).trim()) || null;
  }

  approveLocketOrder(uid, adminId) {
    this.prune();
    if (!Array.isArray(this.data.locketOrders)) {
      this.data.locketOrders = [];
    }
    const cleanUid = String(uid).trim();
    const now = this.now();
    let order = this.data.locketOrders.find((o) => String(o.uid) === cleanUid);
    if (!order) {
      order = {
        uid: cleanUid,
        name: "Khách hàng",
        status: "approved",
        createdAt: now,
        updatedAt: now,
        approvedBy: String(adminId),
        approvedAt: now,
      };
      this.data.locketOrders.push(order);
    } else {
      order.status = "approved";
      order.approvedBy = String(adminId);
      order.approvedAt = now;
      order.updatedAt = now;
    }
    this.save();
    return order;
  }

  rejectLocketOrder(uid, adminId) {
    this.prune();
    if (!Array.isArray(this.data.locketOrders)) {
      this.data.locketOrders = [];
    }
    const cleanUid = String(uid).trim();
    const now = this.now();
    let order = this.data.locketOrders.find((o) => String(o.uid) === cleanUid);
    if (!order) {
      order = {
        uid: cleanUid,
        name: "Khách hàng",
        status: "rejected",
        createdAt: now,
        updatedAt: now,
        rejectedBy: String(adminId),
        rejectedAt: now,
      };
      this.data.locketOrders.push(order);
    } else {
      order.status = "rejected";
      order.rejectedBy = String(adminId);
      order.rejectedAt = now;
      order.updatedAt = now;
    }
    this.save();
    return order;
  }

  listPendingLocketOrders() {
    this.prune();
    if (!Array.isArray(this.data.locketOrders)) return [];
    return this.data.locketOrders
      .filter((o) => o.status === "pending")
      .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  }

  setLocketInstruction(text) {
    this.data.locketInstruction = String(text || "");
    this.save();
    return true;
  }

  getLocketInstruction() {
    return (this.data.locketInstruction && this.data.locketInstruction.trim())
      ? this.data.locketInstruction
      : DEFAULT_LOCKET_INSTRUCTION;
  }

  resetLocketInstruction() {
    this.data.locketInstruction = "";
    this.save();
    return true;
  }
}
