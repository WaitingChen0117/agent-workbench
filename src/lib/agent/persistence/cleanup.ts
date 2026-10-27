import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

import { getTaskStore } from "@/lib/agent/task/task-store";
import { getApprovalStore } from "@/lib/agent/approval/approval-store";
import { getSessionStore } from "@/lib/agent/session/session-store";
import { getWorkflowExecutionStore } from "@/lib/agent/workflow/execution-store";
import { getTraceStore } from "@/lib/agent/trace/trace-store";
import { tx } from "@/lib/agent/persistence/sqlite-util";
import { incrementPersistenceMetric } from "@/lib/agent/persistence/metrics";

/**
 * Persistence Cleanup / TTL（Phase 10.6-D）
 *
 * 只清理「终态」且「超过 TTL」的数据：completed / failed / cancelled。
 * 绝不删除 running / waiting / pending approval / active workflow / waiting session。
 * 不引入 cron / 外部 scheduler —— 暴露一个可被调用/评测的幂等函数。
 */
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const DAY_MS = 86_400_000;

export function getTtlDays(): number {
  const raw = process.env.AGENT_PERSISTENCE_TTL_DAYS;
  if (!raw) return 7;
  const n = Number(raw);
  // 接受任意正整数（常见档位 1/7/30/90）；非法回落默认 7
  if (!Number.isInteger(n) || n <= 0) return 7;
  return n;
}

export interface PersistenceCleanupConfig {
  enabled: boolean;
  ttlDays: number;
}

// 清理默认关闭（避免升级后启动即删数据），仅当 AGENT_PERSISTENCE_CLEANUP_ENABLED=true 开启
export function getPersistenceCleanupConfig(): PersistenceCleanupConfig {
  return {
    enabled: process.env.AGENT_PERSISTENCE_CLEANUP_ENABLED === "true",
    ttlDays: getTtlDays(),
  };
}

const LEASE_MS = 30_000;

export interface CleanupLease {
  db: DatabaseSync;
  ownerId: string;
  ok: boolean;
}

function ensureLockTable(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS agent_persistence_locks (
       name TEXT PRIMARY KEY, acquired_at INTEGER, owner_id TEXT, expires_at INTEGER
     )`,
  );
  const cols = (
    db.prepare("PRAGMA table_info(agent_persistence_locks)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (!cols.includes("owner_id")) db.exec("ALTER TABLE agent_persistence_locks ADD COLUMN owner_id TEXT");
  if (!cols.includes("expires_at")) db.exec("ALTER TABLE agent_persistence_locks ADD COLUMN expires_at INTEGER");
}

// 可续约租约锁：新建 / 过期接管 / 他人持有未过期 → locked。
export function acquireCleanupLock(nowMs: number): CleanupLease | null {
  const dbPath = process.env.AGENT_TASK_DB_PATH;
  if (!dbPath || process.env.AGENT_TASK_STORE !== "sqlite") return null;
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  ensureLockTable(db);
  const ownerId = randomUUID();
  const ok = tx(db, () => {
    const row = db
      .prepare("SELECT owner_id, expires_at FROM agent_persistence_locks WHERE name = 'cleanup'")
      .get() as { owner_id?: string; expires_at?: number } | undefined;
    if (!row) {
      db.prepare(
        "INSERT INTO agent_persistence_locks (name, acquired_at, owner_id, expires_at) VALUES ('cleanup', ?, ?, ?)",
      ).run(nowMs, ownerId, nowMs + LEASE_MS);
      return true;
    }
    if ((row.expires_at ?? 0) < nowMs) {
      db.prepare(
        "UPDATE agent_persistence_locks SET acquired_at = ?, owner_id = ?, expires_at = ? WHERE name = 'cleanup'",
      ).run(nowMs, ownerId, nowMs + LEASE_MS);
      return true; // 接管已过期租约
    }
    return false; // 他人持有且未过期
  });
  return { db, ownerId, ok };
}

function renewCleanupLock(lease: CleanupLease, nowMs: number): void {
  lease.db
    .prepare(
      "UPDATE agent_persistence_locks SET expires_at = ? WHERE name = 'cleanup' AND owner_id = ?",
    )
    .run(nowMs + LEASE_MS, lease.ownerId);
}

export function renewCleanupLockForTest(lease: CleanupLease, nowMs: number): void {
  renewCleanupLock(lease, nowMs);
}

export function releaseCleanupLock(lease: CleanupLease): void {
  try {
    // 仅 owner 匹配才释放，避免误删他人接管后的租约
    lease.db
      .prepare("DELETE FROM agent_persistence_locks WHERE name = 'cleanup' AND owner_id = ?")
      .run(lease.ownerId);
  } catch {
    /* best-effort */
  }
}

export interface CleanupResult {
  scannedTasks: number;
  deletedTasks: number;
  keptTasks: number;
  tracesDeleted: number;
  locked?: boolean; // true 表示未获得清理锁而跳过
}

export interface CleanupOptions {
  ttlDays?: number;
  nowMs?: number; // 便于确定性测试注入
  lock?: boolean; // 是否使用跨进程清理锁（启动触发时用）
}

export async function cleanupExpiredData(
  options: CleanupOptions = {},
): Promise<CleanupResult> {
  const ttlDays = options.ttlDays ?? getTtlDays();
  const nowMs = options.nowMs ?? new Date().getTime();

  let lease: CleanupLease | null = null;
  if (options.lock) {
    lease = acquireCleanupLock(nowMs);
    if (lease && !lease.ok) {
      incrementPersistenceMetric("cleanupSkipped");
      return { scannedTasks: 0, deletedTasks: 0, keptTasks: 0, tracesDeleted: 0, locked: true };
    }
  }

  try {
    return await runCleanup(ttlDays, nowMs, lease);
  } finally {
    if (lease) releaseCleanupLock(lease);
  }
}

async function runCleanup(
  ttlDays: number,
  nowMs: number,
  lease: CleanupLease | null,
): Promise<CleanupResult> {
  const cutoffMs = nowMs - ttlDays * DAY_MS;
  const cutoffIso = new Date(cutoffMs).toISOString();

  const taskStore = getTaskStore();
  const approvalStore = getApprovalStore();
  const sessionStore = getSessionStore();
  const execStore = getWorkflowExecutionStore();
  const traceStore = getTraceStore();

  const tasks = await taskStore.list();
  let deleted = 0;
  let kept = 0;

  for (const task of tasks) {
    const terminal = TERMINAL.has(task.status);
    const expired = Date.parse(task.updatedAt) < cutoffMs;
    if (!terminal || !expired) {
      kept += 1;
      continue;
    }

    // 安全护栏：即便 task 看似终态，也绝不误删仍在等待/活跃的关联数据
    const pending = (await approvalStore.getByTaskId(task.id)).filter(
      (a) => a.status === "pending",
    );
    const wf = await execStore.getByTaskId(task.id);
    const session = await sessionStore.getByTaskId(task.id);
    if (
      pending.length > 0 ||
      (wf && !TERMINAL.has(wf.status)) ||
      (session && (session.status === "waiting" || session.status === "active"))
    ) {
      kept += 1;
      incrementPersistenceMetric("cleanupSkipped");
      continue;
    }

    // 关联删除（顺序：Trace → Session → Approval → WorkflowExecution → Task(+events)）
    traceStore.delete(task.id);
    if (session) await sessionStore.delete(session.sessionId);
    for (const a of await approvalStore.getByTaskId(task.id)) {
      await approvalStore.delete(a.id);
    }
    if (wf) await execStore.delete(wf.executionId);
    await taskStore.delete(task.id);
    deleted += 1;
    incrementPersistenceMetric("cleanupDeleted");
    // 长时间 cleanup 期间续约，避免被第二个进程接管
    if (lease && deleted % 50 === 0) renewCleanupLock(lease, new Date().getTime());
  }

  if (lease) renewCleanupLock(lease, new Date().getTime());

  // 清理没有对应 Task 的历史 Trace（按 TTL）
  const tracesDeleted = traceStore.cleanupTerminalBefore(cutoffIso);

  return {
    scannedTasks: tasks.length,
    deletedTasks: deleted,
    keptTasks: kept,
    tracesDeleted,
  };
}
