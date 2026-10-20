import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const DAY_MS = 24 * 60 * 60 * 1000;

export class ModerationState {
  constructor(filePath, { now = Date.now, windowHours = 24 } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.windowMs = windowHours * 60 * 60 * 1000;
    this.data = existsSync(filePath)
      ? JSON.parse(readFileSync(filePath, "utf8"))
      : { version: 1, incidents: [], cases: [], manualKicks: [] };
    if (this.data.version !== 1 || !Array.isArray(this.data.incidents) ||
        !Array.isArray(this.data.cases) || !Array.isArray(this.data.manualKicks)) {
      throw new Error("File moderation-state.json không hợp lệ; bot dừng để tránh xử lý sai.");
    }
  }

  save() {
    const temporary = `${this.filePath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.filePath);
  }

  prune() {
    const now = this.now();
    this.data.incidents = this.data.incidents.filter((item) => item.at > now - this.windowMs);
    for (const item of this.data.cases) {
      if (item.status === "pending" && item.expiresAt <= now) item.status = "expired";
    }
    this.data.cases = this.data.cases.filter((item) => item.status === "pending" || item.createdAt > now - 30 * DAY_MS);
    this.data.manualKicks = this.data.manualKicks.filter((item) => item.at > now - 30 * DAY_MS).slice(-200);
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
    if (recent.length > 3 && !pendingCase) {
      pendingCase = {
        id: randomBytes(4).toString("hex").toUpperCase(),
        groupId, userId, displayName, status: "pending", createdAt: this.now(),
        expiresAt: this.now() + this.windowMs,
        evidence: recent.slice(-4), notifiedIds: [],
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
}
