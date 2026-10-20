import { accessSync, constants, copyFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { ModerationState } from "./moderation-state.js";

const { Pool } = pg;

export async function createModerationState({ cwd = process.cwd(), env = process.env, windowHours = 24, PoolClass = Pool } = {}) {
  const localPath = resolve(cwd, "moderation-state.json");
  if (env.RENDER === "true" && !env.DATABASE_URL && !env.STATE_DIR) {
    throw new Error("Render cần DATABASE_URL hoặc Persistent Disk với STATE_DIR để giữ số lần vi phạm qua lần khởi động lại. SESSION_JSON chỉ giữ đăng nhập.");
  }
  if (env.DATABASE_URL) {
    const pool = new PoolClass({ connectionString: env.DATABASE_URL, max: 2 });
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS zalo_link_guard_state (
        id integer PRIMARY KEY CHECK (id = 1),
        revision bigint NOT NULL,
        state jsonb NOT NULL
      )`);
      const previous = existsSync(localPath) ? JSON.parse(readFileSync(localPath, "utf8")) :
        { version: 1, incidents: [], cases: [], manualKicks: [] };
      await pool.query("INSERT INTO zalo_link_guard_state (id, revision, state) VALUES (1, 0, $1::jsonb) ON CONFLICT (id) DO NOTHING", [JSON.stringify(previous)]);
      const loaded = await pool.query("SELECT revision, state FROM zalo_link_guard_state WHERE id = 1");
      if (loaded.rows.length !== 1) throw new Error("Không đọc được trạng thái vi phạm từ PostgreSQL.");
      let revision = Number(loaded.rows[0].revision);
      const state = new ModerationState(localPath, {
        windowHours,
        initialData: loaded.rows[0].state,
        saveHook: async (snapshot) => {
          const updated = await pool.query(
            "UPDATE zalo_link_guard_state SET state = $1::jsonb, revision = revision + 1 WHERE id = 1 AND revision = $2 RETURNING revision",
            [JSON.stringify(snapshot), revision],
          );
          if (updated.rows.length !== 1) throw new Error("Trạng thái PostgreSQL đã thay đổi ở tiến trình khác; dừng bot để tránh ghi đè số vi phạm.");
          revision = Number(updated.rows[0].revision);
        },
      });
      return { state, storage: "PostgreSQL (DATABASE_URL)", close: () => pool.end() };
    } catch (error) {
      await pool.end();
      throw error;
    }
  }

  const filePath = env.STATE_DIR ? resolve(env.STATE_DIR, "moderation-state.json") : localPath;
  if (env.STATE_DIR) {
    if (!existsSync(env.STATE_DIR)) throw new Error(`STATE_DIR chưa tồn tại: ${env.STATE_DIR}`);
    accessSync(env.STATE_DIR, constants.W_OK);
    if (!existsSync(filePath) && existsSync(localPath)) copyFileSync(localPath, filePath);
  }
  return {
    state: new ModerationState(filePath, { windowHours }),
    storage: env.STATE_DIR ? `file trong STATE_DIR (${env.STATE_DIR})` : "file cục bộ (sẽ mất khi Render khởi động lại)",
    close: async () => {},
  };
}
