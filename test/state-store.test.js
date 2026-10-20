import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModerationState } from "../src/state-store.js";

const violation = (messageId) => ({
  groupId: "group-1", userId: "member-1", messageId,
  links: [{ url: "https://zalo.me/g/test" }], displayName: "Member",
});

test("STATE_DIR keeps counts after process restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zalo-state-"));
  try {
    const first = await createModerationState({ cwd: dir, env: { STATE_DIR: dir } });
    assert.equal(first.state.recordViolation(violation("1")).count, 1);
    await first.state.flush();
    const second = await createModerationState({ cwd: dir, env: { STATE_DIR: dir } });
    assert.equal(second.state.listViolations()[0].count, 1);
    assert.equal(second.state.recordViolation(violation("2")).count, 2);
    assert.equal(JSON.parse(readFileSync(join(dir, "moderation-state.json"))).incidents.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DATABASE_URL restores counts and rejects stale writers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zalo-db-"));
  let row;
  class FakePool {
    async query(sql, params = []) {
      if (sql.startsWith("CREATE TABLE")) return { rows: [] };
      if (sql.startsWith("INSERT INTO")) {
        row ??= { revision: 0, state: JSON.parse(params[0]) };
        return { rows: [] };
      }
      if (sql.startsWith("SELECT")) return { rows: [structuredClone(row)] };
      if (sql.startsWith("UPDATE")) {
        if (row.revision !== params[1]) return { rows: [] };
        row = { revision: row.revision + 1, state: JSON.parse(params[0]) };
        return { rows: [{ revision: row.revision }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    }
    async end() {}
  }
  try {
    const options = { cwd: dir, env: { DATABASE_URL: "postgres://unused" }, PoolClass: FakePool };
    const first = await createModerationState(options);
    const stale = await createModerationState(options);
    first.state.recordViolation(violation("1"));
    await first.state.flush();
    const restarted = await createModerationState(options);
    assert.equal(restarted.state.listViolations()[0].count, 1);
    stale.state.recordViolation(violation("2"));
    await assert.rejects(stale.state.flush(), /tiến trình khác/);
    assert.equal(row.state.incidents.length, 1);
    await first.close();
    await stale.close();
    await restarted.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
