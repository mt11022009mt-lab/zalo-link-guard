const LINK_RE = /(?:https?:\/\/|www\.)[^\s<>"'`]+|\b(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z]{2,63}(?:\/[^\s<>"'`]*)?/giu;

export function extractLinks(content) {
  const fields = typeof content === "string"
    ? [content]
    : content && typeof content === "object"
      ? [content.href, content.url, content.title, content.description, content.text]
      : [];
  const text = fields.filter((part) => typeof part === "string").join(" ")
    .replace(/\[\s*\.\s*\]|\(\s*\.\s*\)/g, ".")
    .replace(/\uFF0E/g, ".")
    .replace(/hxxps?:\/\//gi, "https://");

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

export function checkMessage(message, config) {
  if (!message || message.type !== 1 || message.isSelf) return null;
  if (!config.groupIds.includes(String(message.threadId))) return null;
  if (config.trustedUserIds.includes(String(message.data?.uidFrom))) return null;
  const content = message.data?.content;
  // Object attachments can carry internal CDN URLs (photos, files). Treat only
  // Zalo's link message types as shared links; ordinary text is always checked.
  if (typeof content !== "string" && !/link/i.test(String(message.data?.msgType ?? ""))) return null;
  const links = extractLinks(content);
  const blocked = links.filter((link) =>
    (config.blockZaloGroupInvites !== false && isZaloGroupInvite(link)) ||
    !isAllowedDomain(link.hostname, config.allowedDomains));
  return blocked.length ? { links: blocked } : null;
}
