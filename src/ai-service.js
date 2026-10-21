export class AIService {
  constructor({
    apiKey,
    model = "deepseek-chat",
    baseUrl = "https://api.deepseek.com",
    timeoutMs = 20000,
  } = {}) {
    this.apiKey = apiKey || "";
    this.model = model || "deepseek-chat";
    this.baseUrl = (baseUrl || "https://api.deepseek.com").replace(/\/+$/, "");
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
          Authorization: `Bearer ${this.apiKey.trim()}`,
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

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`DeepSeek API báo lỗi HTTP ${res.status}: ${errText.slice(0, 100)}`);
      }

      const data = await res.json();
      const answer = data.choices?.[0]?.message?.content?.trim();
      if (!answer) {
        return "🤖 DeepSeek không trả về nội dung. Bạn hãy thử lại nhé!";
      }

      return answer;
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === "AbortError") {
        return "⏱️ DeepSeek phản hồi quá lâu (hết thời gian chờ). Bạn thử hỏi câu ngắn hơn nhé!";
      }
      return `⚠️ Lỗi AI: ${err.message}`;
    }
  }
}
