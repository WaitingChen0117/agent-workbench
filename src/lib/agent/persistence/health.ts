import path from "node:path";

import { getTaskStore } from "@/lib/agent/task/task-store";
import { getApprovalStore } from "@/lib/agent/approval/approval-store";
import { getSessionStore } from "@/lib/agent/session/session-store";
import { getWorkflowExecutionStore } from "@/lib/agent/workflow/execution-store";
import { getTraceStore } from "@/lib/agent/trace/trace-store";
import { getPersistenceCleanupConfig } from "@/lib/agent/persistence/cleanup";

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
  cleanup: { enabled: boolean; ttlDays: number };
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
  return {
    task,
    approval,
    session,
    workflow,
    trace,
    cleanup: { enabled: cfg.enabled, ttlDays: cfg.ttlDays },
  };
}
