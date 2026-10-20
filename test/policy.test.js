import test from "node:test";
import assert from "node:assert/strict";
import { checkMessage, extractLinks, isImageMessage } from "../src/policy.js";

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
  assert.equal(extractLinks("https://zalo.me/g/\nabc123")[0].url, "https://zalo.me/g/abc123");
});

test("only blocks external links in configured groups from untrusted senders", () => {
  assert.ok(checkMessage(message("spam.com"), config));
  assert.ok(checkMessage(message("https://zalo.me/oa/abc"), config));
  assert.equal(checkMessage(message("https://evilzalo.me"), config)?.links.length, 1);
  assert.equal(checkMessage(message("spam.com", "admin"), config), null);
  assert.equal(checkMessage(message("spam.com", "member", "other"), config), null);
  assert.equal(checkMessage({ ...message("spam.com"), isSelf: true }, config), null);
  assert.deepEqual(checkMessage(message({ href: "https://cdn.example.com/photo.jpg" }, "member", "group-1", "chat.photo"), config), { links: [], image: true });
  assert.ok(checkMessage(message({ href: "https://cdn.example.com/photo.jpg", caption: "zalo.me/abc" }, "member", "group-1", "chat.photo"), config));
  assert.ok(checkMessage(message({ href: "https://cdn.example.com/photo.jpg", description: "Vào https://zalo.me/g/abc123" }, "member", "group-1", "chat.photo"), config));
  assert.ok(checkMessage(message({ href: "https://cdn.example.com/photo.jpg", description: "Ảnh kèm chữ https://zalo.me/g/abc123" }, "member", "group-1", "chat.album"), config));
  assert.ok(checkMessage(message(JSON.stringify({ href: "https://cdn.example.com/photo.jpg", description: "Ảnh kèm chữ https://zalo.me/g/abc123" }), "member", "group-1", "chat.photo"), config));
  assert.deepEqual(checkMessage(message(JSON.stringify({ href: "https://cdn.example.com/photo.jpg", description: "Ảnh kỷ niệm" }), "member", "group-1", "chat.photo"), config), { links: [], image: true });
  assert.ok(checkMessage({ ...message(null, "member", "group-1", "chat.album"), data: { uidFrom: "member", caption: "https://zalo.me/g/abc123" } }, config));
  assert.ok(checkMessage(message({ href: "https://cdn.example.com/photo.jpg", desc: "spam.example.com" }, "member", "group-1", "chat.photo"), config));
  assert.ok(checkMessage(message({ href: "https://cdn.example.com/photo.jpg", params: JSON.stringify({ desc: "Hot hot https://zalo.me/g/abc123" }) }, "member", "group-1", "chat.photo"), config));
  assert.ok(checkMessage(message({ data: { params: JSON.stringify({ description: "https://zalo.me/g/abc123" }) } }, "member", "group-1", "chat.photo"), config));
  assert.deepEqual(checkMessage(message({ href: "https://cdn.example.com/photo.jpg", params: JSON.stringify({ url: "https://cdn.example.com/photo.jpg" }) }, "member", "group-1", "chat.photo"), config), { links: [], image: true });
  assert.deepEqual(checkMessage(message({ href: "https://cdn.example.com/photo.jpg", title: "album.example.com.jpg", description: "Ảnh kỷ niệm" }, "member", "group-1", "chat.photo"), config), { links: [], image: true });
  assert.ok(checkMessage(message({ href: "https://cdn.example.com/video.mp4", description: "https://zalo.me/g/abc123" }, "member", "group-1", "chat.video.msg"), config));
  assert.ok(checkMessage(message({ href: "https://spam.com" }, "member", "group-1", "chat.link"), config));
  assert.ok(checkMessage(message({ href: "https://zalo.me/abc", title: "Mời tham gia" }, "member", "group-1", "chat.recommended"), config));
  assert.ok(checkMessage(message({ msg: "BOX SHARE FILE https://zalo.me/g/\nabc123" }, "member", "group-1", "webchat"), config));
  assert.ok(checkMessage(message({ data: { text: "https://zalo.me/g/abc123" } }, "member", "group-1", "webchat"), config));
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

test("long promotional text with two wrapped Zalo invites is still blocked", () => {
  const content = "THAM GIA BOX TẠI ĐÂY 🔗\nBOX SHARE FILE VÀ VIDEO\nhttps://zalo.me/g/\nunyfs9xhtiqliir1zi6.   BOX CHAT VÀ SHARE FILE VÀ VIDEO\nhttps://zalo.me/g/\ntm80va7tprad9vmkerjr";
  const result = checkMessage(message(content), config);
  assert.deepEqual(result?.links.map((link) => link.url), [
    "https://zalo.me/g/unyfs9xhtiqliir1zi6",
    "https://zalo.me/g/tm80va7tprad9vmkerjr",
  ]);
});

test("blocks photos and albums without a link, while allowing GIFs without forbidden links", () => {
  const photo = message({ href: "https://cdn.example.com/p.jpg", description: "Ảnh thường" }, "member", "group-1", "chat.photo");
  const album = message({ href: "https://cdn.example.com/a.jpg" }, "member", "group-1", "chat.album");
  const gif = message({ href: "https://cdn.example.com/a.gif" }, "member", "group-1", "chat.gif");
  const photoLink = message({ description: "https://zalo.me/g/abc" }, "member", "group-1", "chat.photo");
  assert.deepEqual(checkMessage(photo, config), { links: [], image: true });
  assert.deepEqual(checkMessage(album, config), { links: [], image: true });
  assert.equal(checkMessage(gif, config), null);
  assert.equal(checkMessage(message({ description: "https://zalo.me/g/abc" }, "member", "group-1", "chat.gif"), config)?.links.length, 1);
  assert.deepEqual(checkMessage(message({ params: JSON.stringify({ photoId: "12345", desc: "Ảnh thường" }) }, "member", "group-1", "webchat"), config), { links: [], image: true });
  assert.deepEqual(checkMessage(message({ params: JSON.stringify({ photoId: "12345", desc: "https://zalo.me/g/abc" }) }, "member", "group-1", "webchat"), config)?.image, true);
  assert.equal(checkMessage(message({ params: JSON.stringify({ photoId: "12345", desc: "https://zalo.me/g/abc" }) }, "member", "group-1", "webchat"), config)?.links.length, 1);
  assert.equal(checkMessage(message({ params: JSON.stringify({ photoId: "12345" }) }, "member", "group-1", "chat.gif"), config), null);
  assert.deepEqual(checkMessage(message({ type: "image", href: "https://cdn.example.com/p.jpg" }, "member", "group-1", "webchat"), config), { links: [], image: true });
  assert.equal(checkMessage(message({ thumb: "https://cdn.example.com/p.jpg", title: "Trang web" }, "member", "group-1", "chat.link"), config), null);
  assert.equal(checkMessage(photoLink, config)?.links.length, 1);
  assert.equal(isImageMessage(message("text", "member", "group-1", "chat.sticker")), false);
  assert.equal(checkMessage(photo, { ...config, blockImages: false }), null);
  assert.equal(checkMessage(photo, { ...config, trustedUserIds: ["member"] }), null);
  assert.equal(checkMessage(message({ href: "https://cdn.example.com/v.mp4" }, "member", "group-1", "chat.video.msg"), config), null);
});
