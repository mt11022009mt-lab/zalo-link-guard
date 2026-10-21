const DEFAULT_KEY_B64 = "c2stZTk5ODNkODA0OGE3NDNhZmJlNjVkMjdmZGJlYzI4MTI=";

export class AIService {
  constructor({
    apiKey,
    model = "deepseek-chat",
    baseUrl = "https://api.deepseek.com",
    timeoutMs = 10000,
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

  checkCooldown(userId, cooldownMs = 4000) {
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

    const defaultSystem = "Bạn là trợ lý AI thông minh, nhanh nhạy, gần gũi của nhóm Zalo. Trả lời bằng tiếng Việt tự nhiên, ngắn gọn, đi thẳng vào trọng tâm, tối đa khoảng 1-2 đoạn văn ngắn (dưới 200 từ) để phù hợp với tin nhắn Zalo, không dùng định dạng markdown phức tạp hay bảng biểu.";

    // 1. Gọi trực tiếp API DeepSeek chính thức
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
          max_tokens: 300,
          temperature: 0.6,
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
        const errMsg = (errData.error?.message || "").toLowerCase();

        // Xử lý trực tiếp trường hợp tài khoản hết số dư (HTTP 402) - Không để người dùng chờ 15s ở cổng dự phòng
        if (res.status === 402 || errMsg.includes("balance") || errMsg.includes("insufficient")) {
          return "⚠️ [DeepSeek AI] Tài khoản API của bạn đang hết số dư ($0 - Insufficient Balance) nên phản hồi bị nghẽn.\n👉 Bạn hãy nạp tối thiểu $1 (~25.000đ) tại https://platform.deepseek.com/top_up để kích hoạt phản hồi siêu tốc dưới 1 giây nhé!";
        }

        if (res.status === 401 || errMsg.includes("auth") || errMsg.includes("invalid")) {
          return "⚠️ [DeepSeek AI] Khóa API DeepSeek không hợp lệ. Vui lòng kiểm tra lại key tại https://platform.deepseek.com/api_keys nhé!";
        }

        console.warn(`[AI SERVICE] DeepSeek API trả về lỗi: ${res.status} (${errMsg}). Đang thử chế độ dự phòng...`);
      }
    } catch (err) {
      clearTimeout(timeout);
      console.warn(`[AI SERVICE] Kết nối DeepSeek bị gián đoạn: ${err.message}. Đang thử chế độ dự phòng...`);
    }

    // 2. Dự phòng nhanh nếu DeepSeek gặp sự cố đường truyền tạm thời (giới hạn timeout 6s)
    try {
      const fallbackPrompt = `${systemPrompt || defaultSystem}\n\n${senderName}: ${prompt}`;
      const fallbackUrl = `https://text.pollinations.ai/${encodeURIComponent(fallbackPrompt)}?model=openai`;
      const fbController = new AbortController();
      const fbTimeout = setTimeout(() => fbController.abort(), 6000);
      const res = await fetch(fallbackUrl, { signal: fbController.signal });
      clearTimeout(fbTimeout);
      if (res.ok) {
        const answer = await res.text();
        if (answer && answer.trim() && !answer.includes("Free limit reached")) {
          return answer.trim().slice(0, 500);
        }
      }
    } catch (fbErr) {
      console.error("[AI SERVICE] Fallback thất bại:", fbErr.message);
    }

    return "🤖 AI đang bận hoặc quá tải. Để phản hồi siêu tốc dưới 1 giây, hãy nạp số dư cho key DeepSeek tại platform.deepseek.com nhé!";
  }
}
