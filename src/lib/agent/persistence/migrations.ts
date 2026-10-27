import { DatabaseSync } from "node:sqlite";

import { tx } from "@/lib/agent/persistence/sqlite-util";
import { maybeThrowInjectedFailure } from "@/lib/agent/persistence/test-failure";

/**
 * SQLite Schema Migration（Phase 10.8-A）
 *
 * 独立于 package.json 版本的数据库 schema 版本。各 Store 仍懒创建自身表（向后兼容），
 * 本模块负责：登记基线、创建新表（trace event log）、升级旧表（cleanup lease 列），
 * 并以 agent_schema_migrations 记录已应用版本。每个 migration 在事务内执行，失败回滚。
 */
export const LATEST_SCHEMA_VERSION = 3;

interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "baseline",
    // v1.12.0 既有表由各 Store 懒创建；此处仅登记基线版本，不 DROP、不重建。
    up: () => {},
  },
  {
    version: 2,
    name: "trace_event_log",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_trace_events (
          trace_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          event_id TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          type TEXT NOT NULL,
          payload TEXT,
          workflow_id TEXT,
          execution_id TEXT,
          node_id TEXT,
          PRIMARY KEY (trace_id, sequence),
          UNIQUE (trace_id, event_id)
        );
        CREATE INDEX IF NOT EXISTS idx_trace_events_exec ON agent_trace_events(execution_id);
      `);
    },
  },
  {
    version: 3,
    name: "cleanup_lease",
    up: (db) => {
      db.exec(
        `CREATE TABLE IF NOT EXISTS agent_persistence_locks (
           name TEXT PRIMARY KEY,
           acquired_at INTEGER,
           owner_id TEXT,
           expires_at INTEGER
         )`,
      );
      const cols = (
        db.prepare("PRAGMA table_info(agent_persistence_locks)").all() as Array<{
          name: string;
        }>
      ).map((c) => c.name);
      if (!cols.includes("owner_id")) {
        db.exec("ALTER TABLE agent_persistence_locks ADD COLUMN owner_id TEXT");
      }
      if (!cols.includes("expires_at")) {
        db.exec("ALTER TABLE agent_persistence_locks ADD COLUMN expires_at INTEGER");
      }
    },
  },
];

function ensureMetaTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

function currentVersion(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM agent_schema_migrations")
    .get() as { v: number };
  return row.v;
}

export function getSchemaVersion(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  ensureMetaTables(db);
  return currentVersion(db);
}

export interface MigrationResult {
  from: number;
  to: number;
  applied: number[];
}

// 幂等：重复调用只应用缺失的 migration。任一 migration 失败 → 该版本回滚、不记录。
export function migrateDatabase(dbPath: string): MigrationResult {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  ensureMetaTables(db);
  const from = currentVersion(db);
  const applied: number[] = [];

  for (const m of MIGRATIONS) {
    if (m.version <= from) continue;
    tx(db, () => {
      const exists = db
        .prepare("SELECT 1 FROM agent_schema_migrations WHERE version = ?")
        .get(m.version);
      if (exists) return;
      maybeThrowInjectedFailure("migration"); // 测试注入 → 抛错 → 整个 migration 回滚
      m.up(db);
      db.prepare(
        "INSERT INTO agent_schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      ).run(m.version, m.name, new Date().toISOString());
      db.prepare(
        `INSERT INTO agent_schema_meta (key, value) VALUES ('schema_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(String(m.version));
    });
    applied.push(m.version);
  }

  return { from, to: currentVersion(db), applied };
}
