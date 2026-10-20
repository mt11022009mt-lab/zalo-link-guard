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
  if (typeof content === "string") {
    // Some message variants serialize their attachment data as JSON text.
    // Scanning that text directly would mistake image CDN URLs for shared links.
    if (/^\s*[\[{]/.test(content)) {
      try {
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed === "object") {
          return extractMessageLinks({ data: { ...message.data, content: parsed } });
        }
      } catch { /* ordinary text */ }
    }
    return extractLinks(content);
  }
  if (!content || typeof content !== "object") return extractLinks([
    message?.data?.caption, message?.data?.description,
  ].filter((value) => typeof value === "string").join(" "));

  const msgType = String(message.data?.msgType ?? "").toLowerCase();
  const isLinkPreview = msgType === "chat.link" || msgType === "chat.recommended";
  // Photos/files can carry CDN URLs in href/url. Only their user-written
  // text is checked; link previews expose the shared target in href/url.
  // The same visible caption can arrive under different msgType values.
  const fields = isLinkPreview
    ? [content.href, content.url, content.title, content.description, content.text, content.caption, content.msg]
    : [content.caption, content.text, content.message, content.msg, content.body,
        content.description, content.desc,
        typeof content.content === "string" ? content.content : undefined,
        content.data?.text, content.data?.caption, content.data?.msg,
        content.data?.description, content.data?.desc,
        message.data?.caption, message.data?.description];
  return extractLinks(fields.filter((value) => typeof value === "string").join(" "));
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

export function checkMessage(message, config) {
  if (!message || message.type !== 1 || message.isSelf) return null;
  if (!config.groupIds.includes(String(message.threadId))) return null;
  if (config.trustedUserIds.includes(String(message.data?.uidFrom))) return null;
  const links = extractMessageLinks(message);
  const blocked = links.filter((link) =>
    (config.blockZaloLinks !== false && isZaloDomain(link.hostname)) ||
    (config.blockZaloGroupInvites !== false && isZaloGroupInvite(link)) ||
    !isAllowedDomain(link.hostname, config.allowedDomains));
  return blocked.length ? { links: blocked } : null;
}
