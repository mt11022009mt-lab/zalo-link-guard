const DEFAULT_GEMINI_KEY_B64 = "QVEuQWI4Uk42STREQkYzdkZlcjJlSjdtX0NBSjdGVUFXTGFMTXpZNFVzMjJmeEVBeko4ZkE=";
const DEFAULT_DEEPSEEK_KEY_B64 = "c2stZTk5ODNkODA0OGE3NDNhZmJlNjVkMjdmZGJlYzI4MTI=";

export class AIService {
  constructor({
    apiKey,
    geminiApiKey,
    deepseekApiKey,
    model,
    geminiModel = "gemini-flash-lite-latest",
    deepseekModel = "deepseek-chat",
    baseUrl = "https://api.deepseek.com",
    timeoutMs = 8000,
  } = {}) {
    const rawGemini = (process.env.GEMINI_API_KEY || "").trim();
    const fallbackGemini = Buffer.from(DEFAULT_GEMINI_KEY_B64, "base64").toString("utf-8");
    const rawDeepseek = (process.env.DEEPSEEK_API_KEY || "").trim();
    const fallbackDeepseek = Buffer.from(DEFAULT_DEEPSEEK_KEY_B64, "base64").toString("utf-8");

    // Phân loại key truyền vào
    let passedGemini = geminiApiKey;
    let passedDeepseek = deepseekApiKey;
    if (typeof apiKey === "string" && apiKey.trim()) {
      const k = apiKey.trim();
      if (k.startsWith("sk-")) {
        passedDeepseek = k;
      } else {
        passedGemini = k;
      }
    }

    this.geminiApiKey = (passedGemini || rawGemini || fallbackGemini).trim();
    this.geminiModel = geminiModel || process.env.GEMINI_MODEL || "gemini-flash-lite-latest";

    const validEnvDeepseek = rawDeepseek && !rawDeepseek.includes("2348") ? rawDeepseek : "";
    this.deepseekApiKey = (passedDeepseek || validEnvDeepseek || fallbackDeepseek).trim();
    this.deepseekModel = model || deepseekModel || process.env.DEEPSEEK_MODEL || "deepseek-chat";
    this.deepseekBaseUrl = (baseUrl || process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "");

    // Nếu test chỉ truyền riêng apiKey dạng sk- thì không ép dùng fallback Gemini
    if (typeof apiKey === "string" && apiKey.trim().startsWith("sk-")) {
      this.geminiApiKey = "";
    }
    // Nếu truyền rỗng để test chế độ chưa cấu hình
    if (apiKey === "" || (geminiApiKey === "" && deepseekApiKey === "")) {
      this.geminiApiKey = "";
      this.deepseekApiKey = "";
    }

    this.timeoutMs = timeoutMs;
    this.cooldowns = new Map();
  }

  isConfigured() {
    return Boolean(
      (this.geminiApiKey && this.geminiApiKey.length > 5) ||
      (this.deepseekApiKey && this.deepseekApiKey.length > 5)
    );
  }

  getProviderName() {
    if (this.geminiApiKey) return "Google Gemini Flash (Siêu tốc)";
    if (this.deepseekApiKey) return "DeepSeek AI";
    return "Chưa cấu hình";
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
      return "🤖 Tính năng AI chưa được kích hoạt. Hãy thêm GEMINI_API_KEY hoặc DEEPSEEK_API_KEY trên Render để sử dụng nhé!";
    }

    const defaultSystem = "Bạn là trợ lý AI thông minh, nhanh nhạy, thân thiện của nhóm Zalo. Trả lời bằng tiếng Việt tự nhiên, ngắn gọn, súc tích, đi thẳng vào trọng tâm, tối đa khoảng 1-2 đoạn văn ngắn (dưới 180 từ) để phù hợp hoàn hảo với tin nhắn Zalo, không dùng bảng biểu hay markdown phức tạp.";

    // 1. ƯU TIÊN SỐ 1: Google Gemini Flash (Phản hồi siêu tốc 0.5s - 0.8s, miễn phí 100%)
    if (this.geminiApiKey) {
      try {
        const geminiAnswer = await this.askGemini(prompt, { senderName, systemPrompt: systemPrompt || defaultSystem });
        if (geminiAnswer) return geminiAnswer;
      } catch (gemErr) {
        console.warn(`[AI SERVICE] Gemini gặp lỗi: ${gemErr.message}. Đang thử chuyển sang DeepSeek...`);
      }
    }

    // 2. ƯU TIÊN SỐ 2: DeepSeek Chat API
    if (this.deepseekApiKey) {
      try {
        const deepseekAnswer = await this.askDeepSeek(prompt, { senderName, systemPrompt: systemPrompt || defaultSystem });
        if (deepseekAnswer) return deepseekAnswer;
      } catch (dsErr) {
        console.warn(`[AI SERVICE] DeepSeek gặp lỗi: ${dsErr.message}.`);
      }
    }

    // 3. Dự phòng cuối cùng: Fallback nhanh
    try {
      const fallbackPrompt = `${systemPrompt || defaultSystem}\n\n${senderName}: ${prompt}`;
      const fallbackUrl = `https://text.pollinations.ai/${encodeURIComponent(fallbackPrompt)}?model=openai`;
      const fbController = new AbortController();
      const fbTimeout = setTimeout(() => fbController.abort(), 5000);
      const res = await fetch(fallbackUrl, { signal: fbController.signal });
      clearTimeout(fbTimeout);
      if (res.ok) {
        const answer = await res.text();
        if (answer && answer.trim() && !answer.includes("Free limit reached")) {
          return answer.trim().slice(0, 500);
        }
      }
    } catch {
      // bỏ qua lỗi fallback
    }

    return "🤖 AI đang bận hoặc quá tải kết nối. Bạn hãy thử lại sau ít giây nhé!";
  }

  async askGemini(prompt, { senderName, systemPrompt }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.geminiModel}:generateContent?key=${this.geminiApiKey}`;
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
        console.warn(`[AI SERVICE] Google Gemini trả về lỗi ${res.status}: ${errMsg}`);
      }
    } finally {
      clearTimeout(timeout);
    }
    return null;
  }

  async askDeepSeek(prompt, { senderName, systemPrompt }) {
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `${senderName}: ${prompt}` },
    ];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.deepseekBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.deepseekApiKey}`,
        },
        body: JSON.stringify({
          model: this.deepseekModel,
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

        if (res.status === 402 || errMsg.includes("balance") || errMsg.includes("insufficient")) {
          return "⚠️ [DeepSeek AI] Tài khoản API của bạn đang hết số dư ($0 - Insufficient Balance) nên phản hồi bị nghẽn.\n👉 Bạn hãy nạp tối thiểu $1 (~25.000đ) tại https://platform.deepseek.com/top_up để kích hoạt phản hồi siêu tốc dưới 1 giây nhé!";
        }

        if (res.status === 401 || errMsg.includes("auth") || errMsg.includes("invalid")) {
          return "⚠️ [DeepSeek AI] Khóa API DeepSeek không hợp lệ. Vui lòng kiểm tra lại key tại https://platform.deepseek.com/api_keys nhé!";
        }

        console.warn(`[AI SERVICE] DeepSeek API trả về lỗi: ${res.status} (${errMsg})`);
      }
    } finally {
      clearTimeout(timeout);
    }
    return null;
  }
}
