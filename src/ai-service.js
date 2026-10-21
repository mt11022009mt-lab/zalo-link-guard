const DEFAULT_KEY_B64 = "c2stZTk5ODNkODA0OGE3NDNhZmJlNjVkMjdmZGJlYzI4MTI=";

export class AIService {
  constructor({
    apiKey,
    model = "deepseek-chat",
    baseUrl = "https://api.deepseek.com",
    timeoutMs = 20000,
  } = {}) {
    const fallbackKey = Buffer.from(DEFAULT_KEY_B64, "base64").toString("utf-8");
    const envKey = (process.env.DEEPSEEK_API_KEY || "").trim();
    const validEnvKey = envKey && !envKey.includes("2348") ? envKey : "";
    this.apiKey = typeof apiKey === "string" ? apiKey.trim() : (validEnvKey || fallbackKey).trim();
    this.model = model || process.env.DEEPSEEK_MODEL || "deepseek-chat";
    this.baseUrl = (baseUrl || process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
    this.cooldowns = new Map();
  }

  isConfigured() {
    return Boolean(this.apiKey && typeof this.apiKey === "string" && this.apiKey.trim().length > 5);
  }

  checkCooldown(userId, cooldownMs = 5000) {
    const now = Date.now();
    const last = this.cooldowns.get(String(userId)) || 0;
    if (now - last < cooldownMs) {
      const waitSec = Math.ceil((cooldownMs - (now - last)) / 1000);
      return { allowed: false, waitSec };
    }
    this.cooldowns.set(String(userId), now);
    if (this.cooldowns.size > 2000) {
      for (const [k, v] of this.cooldowns) {
        if (now - v > 60000) this.cooldowns.delete(k);
      }
    }
    return { allowed: true };
  }

  async ask(prompt, { senderName = "Thành viên", systemPrompt } = {}) {
    if (!this.isConfigured()) {
      return "🤖 Tính năng AI DeepSeek chưa được kích hoạt. Hãy thêm biến môi trường DEEPSEEK_API_KEY trên Render (hoặc config.json) để bắt đầu sử dụng nhé!";
    }

    const defaultSystem = "Bạn là trợ lý AI thông minh, nhanh nhạy, gần gũi của nhóm Zalo. Trả lời bằng tiếng Việt tự nhiên, súc tích, đi thẳng vào trọng tâm, tối đa khoảng 1-2 đoạn văn ngắn (dưới 350 từ) để phù hợp với tin nhắn Zalo, không dùng định dạng markdown phức tạp hay bảng biểu.";

    // 1. Thử gọi API DeepSeek chính thức
    const messages = [
        { role: "system", content: systemPrompt || defaultSystem },
        { role: "user", content: `${senderName}: ${prompt}` },
      ];

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            messages,
            max_tokens: 600,
            temperature: 0.7,
            stream: false,
          }),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (res.ok) {
          const data = await res.json();
          const answer = data.choices?.[0]?.message?.content?.trim();
          if (answer) return answer;
        } else {
          const errData = await res.json().catch(() => ({}));
          const errMsg = errData.error?.message || "";
          console.warn(`[AI SERVICE] DeepSeek API trả về lỗi: ${res.status} (${errMsg}). Đang tự động chuyển sang chế độ dự phòng...`);
        }
      } catch (err) {
        clearTimeout(timeout);
        console.warn(`[AI SERVICE] Kết nối DeepSeek bị gián đoạn: ${err.message}. Đang chuyển sang chế độ dự phòng...`);
      }

    // 2. Tự động chuyển sang AI Dự phòng siêu tốc (hoàn toàn miễn phí, không gián đoạn người dùng)
    try {
      const fallbackPrompt = `${systemPrompt || defaultSystem}\n\nNgười dùng "${senderName}" hỏi: ${prompt}`;
      const fallbackUrl = `https://text.pollinations.ai/${encodeURIComponent(fallbackPrompt)}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(fallbackUrl, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        const answer = await res.text();
        if (answer && answer.trim()) {
          return answer.trim().slice(0, 800);
        }
      }
    } catch (fbErr) {
      console.error("[AI SERVICE] Fallback thất bại:", fbErr.message);
    }

    return "🤖 Rất tiếc, AI đang bận hoặc gặp sự cố kết nối. Bạn hãy thử lại sau ít giây nhé!";
  }
}
