const DEFAULT_GEMINI_KEY_B64 = "QVEuQWI4Uk42STREQkYzdkZlcjJlSjdtX0NBSjdGVUFXTGFMTXpZNFVzMjJmeEVBeko4ZkE=";

export class AIService {
  constructor({
    apiKey,
    geminiApiKey,
    model,
    geminiModel = "gemini-3.5-flash",
    timeoutMs = 15000,
  } = {}) {
    const rawGemini = (process.env.GEMINI_API_KEY || "").trim();
    const fallbackGemini = Buffer.from(DEFAULT_GEMINI_KEY_B64, "base64").toString("utf-8");

    let passedGemini = geminiApiKey || apiKey;
    this.geminiApiKey = (passedGemini || rawGemini || fallbackGemini).trim();
    this.geminiModel = model || geminiModel || process.env.GEMINI_MODEL || "gemini-3.5-flash";

    // Nếu test hoặc cấu hình truyền rỗng để test chế độ chưa kích hoạt
    if (apiKey === "" || geminiApiKey === "") {
      this.geminiApiKey = "";
    }

    this.timeoutMs = timeoutMs;
    this.cooldowns = new Map();
  }

  isConfigured() {
    return Boolean(this.geminiApiKey && this.geminiApiKey.length > 5);
  }

  getProviderName() {
    return this.isConfigured() ? "Google Gemini Flash (Miễn phí 100%)" : "Chưa cấu hình";
  }

  checkCooldown(userId, cooldownMs = 3000) {
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
      return "🤖 Tính năng AI Gemini chưa được kích hoạt. Hãy thêm GEMINI_API_KEY trên Render để sử dụng nhé!";
    }

    const defaultSystem = "Bạn là trợ lý AI thông minh, nhanh nhạy, thân thiện của nhóm Zalo. Trả lời bằng tiếng Việt tự nhiên, ngắn gọn, súc tích, đi thẳng vào trọng tâm, tối đa khoảng 1-2 đoạn văn ngắn (dưới 180 từ) để phù hợp hoàn hảo với tin nhắn Zalo, không dùng bảng biểu hay markdown phức tạp.";

    // 1. Gọi trực tiếp Google Gemini Flash (mặc định gemini-3.5-flash với thinkingBudget = 1)
    try {
      const geminiAnswer = await this.askGemini(prompt, {
        senderName,
        systemPrompt: systemPrompt || defaultSystem,
        modelName: this.geminiModel,
      });
      if (geminiAnswer) return geminiAnswer;
    } catch (gemErr) {
      console.warn(`[AI SERVICE] Gemini (${this.geminiModel}) gặp lỗi: ${gemErr.message}. Đang thử model dự phòng...`);
    }

    // 2. Thử model dự phòng nếu model chính bị quá tải
    const fallbackModels = ["gemini-3.8-flash", "gemini-3.1-flash-lite"].filter((m) => m !== this.geminiModel);
    for (const altModel of fallbackModels) {
      try {
        const altAnswer = await this.askGemini(prompt, {
          senderName,
          systemPrompt: systemPrompt || defaultSystem,
          modelName: altModel,
        });
        if (altAnswer) return altAnswer;
      } catch {
        // thử model tiếp theo
      }
    }

    return "🤖 AI đang bận một chút, bạn hãy thử lại sau ít giây nhé!";
  }

  async askGemini(prompt, { senderName, systemPrompt, modelName = this.geminiModel }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${this.geminiApiKey}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemPrompt }]
          },
          contents: [
            { parts: [{ text: `${senderName}: ${prompt}` }] }
          ],
          generationConfig: {
            maxOutputTokens: 250,
            temperature: 0.7,
            thinkingConfig: { thinkingBudget: 1 }
          }
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (res.ok) {
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (text) return text;
      } else {
        const errData = await res.json().catch(() => ({}));
        const errMsg = errData.error?.message || "";
        console.warn(`[AI SERVICE] Google Gemini (${modelName}) trả về lỗi ${res.status}: ${errMsg}`);
      }
    } finally {
      clearTimeout(timeout);
    }
    return null;
  }
}
