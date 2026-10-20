import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loginWithSession, parseSessionJson } from "../src/session.js";

const credentials = {
  cookie: [{ key: "zpsid", value: "private-cookie", domain: "chat.zalo.me" }],
  imei: "private-imei", userAgent: "test-agent",
};
const quietLog = { info() {}, warn() {} };

test("SESSION_JSON validates credentials without exposing secrets", () => {
  assert.deepEqual(parseSessionJson(JSON.stringify(credentials)), { ...credentials, language: "vi" });
  for (const raw of ["not-json", "{}", JSON.stringify({ ...credentials, cookie: [] })]) {
    assert.throws(() => parseSessionJson(raw), (error) =>
      !error.message.includes("private-cookie") && !error.message.includes("private-imei"));
  }
});

test("valid SESSION_JSON logs in without invoking QR", async () => {
  let used;
  const api = { getOwnId: () => "123" };
  const result = await loginWithSession({
    zalo: {
      login: async (value) => { used = value; return api; },
      loginQR: () => { throw new Error("QR must not run"); },
    },
    sessionJson: JSON.stringify(credentials), log: quietLog,
  });
  assert.equal(result, api);
  assert.deepEqual(used, { ...credentials, language: "vi" });
});

test("rejected saved session stops without falling back to QR", async () => {
  await assert.rejects(loginWithSession({
    zalo: {
      login: () => { throw new Error("private-cookie expired"); },
      loginQR: () => { throw new Error("QR must not run"); },
    },
    sessionJson: JSON.stringify(credentials), log: quietLog,
  }), (error) => !error.message.includes("private-cookie") && /hết hạn/.test(error.message));
});

test("QR login writes a reusable session to a local file without logging it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zalo-session-test-"));
  const logs = [];
  try {
    const sessionPath = join(directory, "zalo-session.json");
    const api = { getCookie: () => ({ serializeSync: () => ({ cookies: credentials.cookie }) }) };
    const result = await loginWithSession({
      zalo: {
        loginQR: async (_options, callback) => {
          callback({ type: 4, data: credentials, actions: null });
          return api;
        },
      },
      qrPath: join(directory, "qr.png"), sessionPath,
      log: { info: (line) => logs.push(line), warn: (line) => logs.push(line) },
    });
    assert.equal(result, api);
    assert.deepEqual(parseSessionJson(await readFile(sessionPath, "utf8")),
      { ...credentials, language: "vi" });
    assert.ok(logs.some((line) => line.includes("zalo-session.json")));
    assert.ok(!logs.join(" ").includes("private-cookie"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Render requires SESSION_JSON instead of hanging on a QR prompt", async () => {
  await assert.rejects(loginWithSession({
    zalo: { loginQR: () => { throw new Error("QR must not run"); } },
    isRender: true, log: quietLog,
  }), /Thiếu SESSION_JSON/);
});
