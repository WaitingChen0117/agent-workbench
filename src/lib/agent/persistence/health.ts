import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { getTaskStore } from "@/lib/agent/task/task-store";
import { getApprovalStore } from "@/lib/agent/approval/approval-store";
import { getSessionStore } from "@/lib/agent/session/session-store";
import { getWorkflowExecutionStore } from "@/lib/agent/workflow/execution-store";
import { getTraceStore } from "@/lib/agent/trace/trace-store";
import { getPersistenceCleanupConfig } from "@/lib/agent/persistence/cleanup";
import { getPersistenceMetrics, type PersistenceMetrics } from "@/lib/agent/persistence/metrics";
import { isCursorSigningConfigured } from "@/lib/agent/persistence/pagination";
import { getSchemaVersion, LATEST_SCHEMA_VERSION } from "@/lib/agent/persistence/migrations";

/**
 * Persistence Health / Diagnostics（Phase 10.7-E）
 *
 * 只读诊断，不修改任何数据；绝不暴露 token/secret/authorization/password/API key，
 * 也不暴露完整敏感路径（只给 basename）。
 */
export interface StoreHealth {
  backend: "memory" | "sqlite";
  available: boolean;
  databaseFile?: string;
  schemaReady: boolean;
}

export interface PersistenceHealth {
  task: StoreHealth;
  approval: StoreHealth;
  session: StoreHealth;
  workflow: StoreHealth;
  trace: StoreHealth;
  schema: { version: number; latest: number; migrationPending: boolean };
  cursorSigningConfigured: boolean;
  cleanup: { enabled: boolean; ttlDays: number };
  cleanupLock: { held: boolean; expiresAt?: number };
  metrics: PersistenceMetrics;
}

function backendOf(envVar: string): "memory" | "sqlite" {
  return process.env[envVar] === "sqlite" ? "sqlite" : "memory";
}

function dbFile(backend: "memory" | "sqlite"): string | undefined {
  if (backend !== "sqlite") return undefined;
  const p = process.env.AGENT_TASK_DB_PATH;
  return p ? path.basename(p) : "agent.sqlite";
}

async function probe(
  envVar: string,
  read: () => Promise<unknown>,
): Promise<StoreHealth> {
  const backend = backendOf(envVar);
  try {
    await read();
    return { backend, available: true, databaseFile: dbFile(backend), schemaReady: true };
  } catch {
    return { backend, available: false, databaseFile: dbFile(backend), schemaReady: false };
  }
}

export async function getPersistenceHealth(): Promise<PersistenceHealth> {
  const [task, approval, session, workflow, trace] = await Promise.all([
    probe("AGENT_TASK_STORE", () => getTaskStore().listPage({ limit: 1 })),
    probe("AGENT_APPROVAL_STORE", () => getApprovalStore().list()),
    probe("AGENT_SESSION_STORE", () => getSessionStore().list()),
    probe("AGENT_WORKFLOW_EXECUTION_STORE", () =>
      getWorkflowExecutionStore().listPage({ limit: 1 }),
    ),
    probe("AGENT_TRACE_STORE", async () => getTraceStore().listPage({ limit: 1 })),
  ]);
  const cfg = getPersistenceCleanupConfig();
  const sqlite =
    process.env.AGENT_TASK_STORE === "sqlite" && !!process.env.AGENT_TASK_DB_PATH;
  let schemaVersion = 0;
  let lockStatus: { held: boolean; expiresAt?: number } = { held: false };
  if (sqlite) {
    const dbPath = process.env.AGENT_TASK_DB_PATH as string;
    try {
      schemaVersion = getSchemaVersion(dbPath);
    } catch {
      schemaVersion = 0;
    }
    lockStatus = readCleanupLock(dbPath);
  }
  return {
    task,
    approval,
    session,
    workflow,
    trace,
    schema: {
      version: schemaVersion,
      latest: LATEST_SCHEMA_VERSION,
      migrationPending: sqlite && schemaVersion < LATEST_SCHEMA_VERSION,
    },
    cursorSigningConfigured: isCursorSigningConfigured(),
    cleanup: { enabled: cfg.enabled, ttlDays: cfg.ttlDays },
    cleanupLock: lockStatus,
    metrics: getPersistenceMetrics(),
  };
}

// 只读 cleanup 锁状态；不返回 owner_id（内部标识）。
function readCleanupLock(dbPath: string): { held: boolean; expiresAt?: number } {
  try {
    const db = new DatabaseSync(dbPath);
    const row = db
      .prepare("SELECT expires_at FROM agent_persistence_locks WHERE name = 'cleanup'")
      .get() as { expires_at?: number } | undefined;
    if (!row) return { held: false };
    return { held: (row.expires_at ?? 0) > new Date().getTime(), expiresAt: row.expires_at };
  } catch {
    return { held: false };
  }
}
