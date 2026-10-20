import test from "node:test";
import assert from "node:assert/strict";
import { checkMessage, extractLinks } from "../src/policy.js";

const config = { groupIds: ["group-1"], trustedUserIds: ["admin"], allowedDomains: ["zalo.me"] };
const message = (content, user = "member", group = "group-1", msgType = "webchat") => ({
  type: 1, isSelf: false, threadId: group, data: { uidFrom: user, content, msgType },
});

test("detects plain, obfuscated and attachment links", () => {
  assert.equal(extractLinks("Xem https://spam.example.com/a").length, 1);
  assert.equal(extractLinks("hxxps://spam[.]com").length, 1);
  assert.equal(extractLinks({ href: "https://spam.com", description: "quảng cáo" }).length, 1);
  assert.equal(extractLinks("Xem ngay https://spam.site/abc").length, 1);
  assert.equal(extractLinks("za\u200blo。me").length, 1);
});

test("only blocks external links in configured groups from untrusted senders", () => {
  assert.ok(checkMessage(message("spam.com"), config));
  assert.ok(checkMessage(message("https://zalo.me/oa/abc"), config));
  assert.equal(checkMessage(message("https://evilzalo.me"), config)?.links.length, 1);
  assert.equal(checkMessage(message("spam.com", "admin"), config), null);
  assert.equal(checkMessage(message("spam.com", "member", "other"), config), null);
  assert.equal(checkMessage({ ...message("spam.com"), isSelf: true }, config), null);
  assert.equal(checkMessage(message({ href: "https://cdn.example.com/photo.jpg" }, "member", "group-1", "chat.photo"), config), null);
  assert.ok(checkMessage(message({ href: "https://cdn.example.com/photo.jpg", caption: "zalo.me/abc" }, "member", "group-1", "chat.photo"), config));
  assert.ok(checkMessage(message({ href: "https://spam.com" }, "member", "group-1", "chat.link"), config));
  assert.ok(checkMessage(message({ href: "https://zalo.me/abc", title: "Mời tham gia" }, "member", "group-1", "chat.recommended"), config));
});

test("blocks all zalo.me links with old allowlists, unless explicitly disabled", () => {
  assert.ok(checkMessage(message("https://zalo.me/g/abc123"), config));
  assert.ok(checkMessage(message("https://zalo.me/g\nabc123"), config));
  assert.ok(checkMessage(message("zalo.me"), config));
  assert.ok(checkMessage(message("www.zalo.me/oa/example"), config));
  assert.ok(checkMessage(message("m.zalo.me/abc"), config));
  assert.equal(checkMessage(message("evilzalo.me"), { ...config, allowedDomains: ["evilzalo.me"] }), null);
  assert.ok(checkMessage(message("https://zalo.me/g/abc123"), { ...config, blockZaloLinks: false }));
  assert.equal(checkMessage(message("https://zalo.me/oa/example"), { ...config, blockZaloLinks: false }), null);
  assert.equal(checkMessage(message("https://zalo.me/g/abc123"), { ...config, blockZaloLinks: false, blockZaloGroupInvites: false }), null);
});
