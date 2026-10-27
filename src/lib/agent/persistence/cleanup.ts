import { getTaskStore } from "@/lib/agent/task/task-store";
import { getApprovalStore } from "@/lib/agent/approval/approval-store";
import { getSessionStore } from "@/lib/agent/session/session-store";
import { getWorkflowExecutionStore } from "@/lib/agent/workflow/execution-store";
import { getTraceStore } from "@/lib/agent/trace/trace-store";

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

export interface CleanupResult {
  scannedTasks: number;
  deletedTasks: number;
  keptTasks: number;
  tracesDeleted: number;
}

export interface CleanupOptions {
  ttlDays?: number;
  nowMs?: number; // 便于确定性测试注入
}

export async function cleanupExpiredData(
  options: CleanupOptions = {},
): Promise<CleanupResult> {
  const ttlDays = options.ttlDays ?? getTtlDays();
  const nowMs = options.nowMs ?? new Date().getTime();
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
  }

  // 清理没有对应 Task 的历史 Trace（按 TTL）
  const tracesDeleted = traceStore.cleanupTerminalBefore(cutoffIso);

  return {
    scannedTasks: tasks.length,
    deletedTasks: deleted,
    keptTasks: kept,
    tracesDeleted,
  };
}
