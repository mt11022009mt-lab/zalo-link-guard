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
});

test("only blocks external links in configured groups from untrusted senders", () => {
  assert.ok(checkMessage(message("spam.com"), config));
  assert.equal(checkMessage(message("https://zalo.me/oa/abc"), config), null);
  assert.equal(checkMessage(message("https://evilzalo.me"), config)?.links.length, 1);
  assert.equal(checkMessage(message("spam.com", "admin"), config), null);
  assert.equal(checkMessage(message("spam.com", "member", "other"), config), null);
  assert.equal(checkMessage({ ...message("spam.com"), isSelf: true }, config), null);
  assert.equal(checkMessage(message({ href: "https://cdn.example.com/photo.jpg" }, "member", "group-1", "chat.photo"), config), null);
  assert.ok(checkMessage(message({ href: "https://spam.com" }, "member", "group-1", "chat.link"), config));
});

test("blocks Zalo group invite links even if an older config allows zalo.me", () => {
  assert.ok(checkMessage(message("https://zalo.me/g/abc123"), config));
  assert.ok(checkMessage(message("https://zalo.me/g\nabc123"), config));
  assert.equal(checkMessage(message("https://zalo.me/oa/example"), config), null);
  assert.equal(checkMessage(message("https://zalo.me/g/abc123"), { ...config, blockZaloGroupInvites: false }), null);
});
