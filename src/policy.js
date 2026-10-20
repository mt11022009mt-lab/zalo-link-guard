const LINK_RE = /(?:https?:\/\/|www\.)[^\s<>"'`]+|\b(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z]{2,63}(?:\/[^\s<>"'`]*)?/giu;

export function extractLinks(content) {
  const fields = typeof content === "string"
    ? [content]
    : content && typeof content === "object"
      ? [content.href, content.url, content.title, content.description, content.text]
      : [];
  const text = fields.filter((part) => typeof part === "string").join(" ")
    .replace(/\[\s*\.\s*\]|\(\s*\.\s*\)/g, ".")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/[\u3002\uFF0E\uFF61]/g, ".")
    .replace(/hxxps?:\/\//gi, "https://")
    .replace(/(\b(?:www\.)?zalo\.me\/g\/)\r?\n[ \t]*([a-z\d_-]+)/gi, "$1$2");

  return [...text.matchAll(LINK_RE)].flatMap(([match]) => {
    try {
      const cleaned = match.replace(/[.,!?;:)}\]]+$/u, "");
      const url = new URL(/^(?:https?:\/\/)/i.test(cleaned) ? cleaned : `https://${cleaned}`);
      return url.hostname ? [{ url: url.href, hostname: url.hostname.toLowerCase() }] : [];
    } catch {
      return [];
    }
  });
}

export function extractMessageLinks(message) {
  const content = message?.data?.content;
  const msgType = String(message.data?.msgType ?? "").toLowerCase();
  const isLinkPreview = msgType === "chat.link" || msgType === "chat.recommended";
  const textKeys = new Set(["caption", "text", "message", "msg", "body", "description", "desc", "content"]);
  const nestedKeys = new Set(["data", "params", "parameters", "attachment", "attachments", "payload", "metadata", "extra", "items"]);
  const fields = [];
  const seen = new WeakSet();
  let visited = 0;
  function collect(value, depth = 0, key = "content") {
    if (depth > 6 || ++visited > 150) return;
    if (typeof value === "string") {
      if (/^\s*[\[{]/.test(value) && value.length <= 100_000) {
        try {
          const parsed = JSON.parse(value);
          if (parsed && typeof parsed === "object") return collect(parsed, depth + 1, key);
        } catch { /* The string is ordinary text. */ }
      }
      if (textKeys.has(key)) fields.push(value.slice(0, 20_000));
      return;
    }
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 20)) collect(item, depth + 1, key);
      return;
    }
    for (const [field, item] of Object.entries(value)) {
      const lower = field.toLowerCase();
      if (textKeys.has(lower) || nestedKeys.has(lower)) collect(item, depth + 1, lower);
      else if (isLinkPreview && depth === 0 && ["href", "url", "title"].includes(lower)) {
        if (typeof item === "string") fields.push(item.slice(0, 20_000));
      }
    }
  }
  collect(content);
  for (const key of ["caption", "description", "desc", "params", "attachment"]) {
    if (message.data?.[key] !== undefined) collect(message.data[key], 0, key);
  }
  return extractLinks(fields.join(" "));
}

export function isAllowedDomain(hostname, allowedDomains) {
  return allowedDomains.some((domain) => {
    const allowed = domain.toLowerCase().replace(/^\./, "");
    return hostname === allowed || hostname.endsWith(`.${allowed}`);
  });
}

export function isZaloGroupInvite(link) {
  if (link.hostname !== "zalo.me" && link.hostname !== "www.zalo.me") return false;
  try {
    const pathname = new URL(link.url).pathname.toLowerCase();
    return pathname === "/g" || pathname.startsWith("/g/");
  } catch {
    return false;
  }
}

export function isZaloDomain(hostname) {
  return hostname === "zalo.me" || hostname.endsWith(".zalo.me");
}

export function isImageMessage(message) {
  const type = String(message?.data?.msgType ?? "").toLowerCase();
  if (["chat.gif", "chat.sticker", "chat.video.msg", "chat.link", "chat.recommended"].includes(type)) return false;
  if (/^(?:chat|share)\.(?:photo|album|image)(?:\.|$)/.test(type)) return true;

  // Some Zalo image events use a generic msgType but still carry a photoId
  // in the attachment payload. Keep the check limited to media metadata so a
  // link preview's thumbnail URL does not become an "image message".
  const seen = new WeakSet();
  function hasPhotoMarker(value, depth = 0) {
    if (depth > 5 || value == null) return false;
    if (typeof value === "string") {
      if (!/^\s*[\[{]/.test(value) || value.length > 100_000) return false;
      try { return hasPhotoMarker(JSON.parse(value), depth + 1); } catch { return false; }
    }
    if (typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 20).some((item) => hasPhotoMarker(item, depth + 1));
    if (value.photoId != null && String(value.photoId).trim() && String(value.photoId) !== "-1") return true;
    if (String(value.fileType ?? "").toLowerCase() === "image") return true;
    if (["photo", "image"].includes(String(value.type ?? "").toLowerCase())) return true;
    if (value.rawUrl && value.thumbUrl && (value.width || value.height)) return true;
    return ["params", "data", "payload", "attachment", "attachments", "items"].some((key) =>
      hasPhotoMarker(value[key], depth + 1));
  }
  return hasPhotoMarker(message?.data?.content) || hasPhotoMarker(message?.data?.params);
}

export function checkMessage(message, config) {
  if (!message || message.type !== 1 || message.isSelf) return null;
  if (!config.groupIds.includes(String(message.threadId))) return null;
  if (config.trustedUserIds.includes(String(message.data?.uidFrom))) return null;
  const links = extractMessageLinks(message);
  const blocked = links.filter((link) =>
    (config.blockZaloLinks !== false && isZaloDomain(link.hostname)) ||
    (config.blockZaloGroupInvites !== false && isZaloGroupInvite(link)) ||
    !isAllowedDomain(link.hostname, config.allowedDomains));
  const image = config.blockImages !== false && isImageMessage(message);
  return blocked.length || image ? { links: blocked, image } : null;
}
