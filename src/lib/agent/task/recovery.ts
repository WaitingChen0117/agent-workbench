import { randomUUID } from "node:crypto";

import * as eventBus from "@/lib/agent/task/event-bus";
import { getTaskStore, type TaskStore } from "@/lib/agent/task/task-store";
import {
  getApprovalStore,
  type ApprovalStore,
} from "@/lib/agent/approval/approval-store";
import { getSessionStore } from "@/lib/agent/session/session-store";
import {
  getWorkflowExecutionStore,
  type WorkflowExecutionStore,
} from "@/lib/agent/workflow/execution-store";
import type { SessionStatus } from "@/lib/agent/session/types";
import type { AgentTaskEvent } from "@/lib/agent/task/types";

/**
 * Task Resume / Crash Recovery（Phase 10.3）
 *
 *  - running  → failed（原进程 LLM/tool 已失，避免重复副作用，不重跑）
 *  - waiting + pending approval → 保持 waiting（真正可恢复：等用户 approve 后 resume 执行一次）
 *  - waiting 但无 pending approval → failed（异常态，安全收尾）
 *
 * recovery 幂等：running/waiting-missing 变为终态后不再处理；waiting-kept 不重复发事件。
 */
export interface RecoveryResult {
  scanned: number;
  running: number;
  waiting: number;
  recovered: number; // 本次发生状态变更（→failed）的任务数
  keptWaiting: number; // 保持 waiting 等待审批的任务数
  skipped: number; // 终态任务
}

function nowIso(): string {
  return new Date().toISOString();
}

async function recordRecovery(
  store: TaskStore,
  taskId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const event: AgentTaskEvent = {
    id: randomUUID(),
    taskId,
    type: "task.recovered",
    timestamp: nowIso(),
    data,
  };
  await store.appendEvent(taskId, event);
  eventBus.publish(event);
}

// Session 状态随 Task 一起恢复（Phase 10.4）；Session 不存在则 no-op。
async function syncSessionOnRecovery(
  taskId: string,
  status: SessionStatus,
): Promise<void> {
  const sessionStore = getSessionStore();
  const session = await sessionStore.getByTaskId(taskId);
  if (session && session.status !== status) {
    await sessionStore.update(session.sessionId, { status });
  }
}

export async function recoverTasks(
  store: TaskStore = getTaskStore(),
  approvalStore: ApprovalStore = getApprovalStore(),
  execStore: WorkflowExecutionStore = getWorkflowExecutionStore(),
): Promise<RecoveryResult> {
  const all = await store.list();

  // 先处理 Workflow executions；对应的 Task 交给 Workflow pass，避免普通 Task pass 重复处理。
  const workflowExecutions = await execStore.list();
  const workflowTaskIds = new Set(workflowExecutions.map((e) => e.taskId));

  const running = all.filter(
    (t) => t.status === "running" && !workflowTaskIds.has(t.id),
  );
  const waiting = all.filter(
    (t) => t.status === "waiting" && !workflowTaskIds.has(t.id),
  );

  let recovered = 0;
  let keptWaiting = 0;

  // running → failed（不重跑、不重调 LLM）
  for (const task of running) {
    const reason = "Task interrupted by process restart";
    await store.update(task.id, { error: { code: "RECOVERED", message: reason } });
    await store.transition(task.id, "failed");
    await syncSessionOnRecovery(task.id, "failed");
    await recordRecovery(store, task.id, {
      taskId: task.id,
      previousStatus: "running",
      status: "failed",
      reason,
    });
    recovered += 1;
  }

  // waiting：区分「有 pending approval（保持等待）」与「无（安全失败）」
  for (const task of waiting) {
    const pending = (await approvalStore.getByTaskId(task.id)).filter(
      (a) => a.status === "pending",
    );

    if (pending.length > 0) {
      // 幂等：已经 recover 过就不重复发事件，保持 waiting、不注册 waiter、不执行任何工具
      await syncSessionOnRecovery(task.id, "waiting");
      const events = await store.getEvents(task.id);
      const already = events.some((e) => e.type === "task.recovered");
      if (!already) {
        await recordRecovery(store, task.id, {
          taskId: task.id,
          previousStatus: "waiting",
          status: "waiting",
          reason: "approval_waiting",
          approvalId: pending[0].id,
        });
      }
      keptWaiting += 1;
    } else {
      const reason = "Waiting task has no pending approval";
      await store.update(task.id, { error: { code: "RECOVERED", message: reason } });
      await store.transition(task.id, "failed");
      await syncSessionOnRecovery(task.id, "failed");
      await recordRecovery(store, task.id, {
        taskId: task.id,
        previousStatus: "waiting",
        status: "failed",
        reason: "missing_approval",
      });
      recovered += 1;
    }
  }

  // Workflow executions 恢复（Phase 10.5）
  for (const execution of workflowExecutions) {
    const taskId = execution.taskId;
    if (
      execution.status === "completed" ||
      execution.status === "failed" ||
      execution.status === "cancelled"
    ) {
      continue; // 终态跳过
    }

    if (execution.status === "running") {
      const reason = "Workflow interrupted by process restart";
      await execStore.update(execution.executionId, {
        status: "failed",
        error: { code: "RECOVERED", message: reason },
        endedAt: nowIso(),
      });
      await store.update(taskId, { error: { code: "RECOVERED", message: reason } });
      if ((await store.get(taskId))?.status === "running") {
        await store.transition(taskId, "failed");
      }
      await recordRecovery(store, taskId, {
        taskId,
        executionId: execution.executionId,
        previousStatus: "running",
        status: "failed",
        reason: "workflow_running_recovery",
      });
      recovered += 1;
      continue;
    }

    // waiting：区分有/无 pending approval
    const pending = (await approvalStore.getByTaskId(taskId)).filter(
      (a) => a.status === "pending",
    );
    if (pending.length > 0) {
      const events = await store.getEvents(taskId);
      const already = events.some((e) => e.type === "task.recovered");
      if (!already) {
        await recordRecovery(store, taskId, {
          taskId,
          executionId: execution.executionId,
          nodeId: execution.currentNodeId,
          previousStatus: "waiting",
          status: "waiting",
          reason: "workflow_approval_waiting",
          approvalId: pending[0].id,
        });
      }
      keptWaiting += 1;
    } else {
      const reason = "Workflow waiting state has no pending approval";
      await execStore.update(execution.executionId, {
        status: "failed",
        error: { code: "RECOVERED", message: reason },
        endedAt: nowIso(),
      });
      await store.update(taskId, { error: { code: "RECOVERED", message: reason } });
      if ((await store.get(taskId))?.status === "waiting") {
        await store.transition(taskId, "failed");
      }
      await recordRecovery(store, taskId, {
        taskId,
        executionId: execution.executionId,
        previousStatus: "waiting",
        status: "failed",
        reason: "workflow_missing_approval",
      });
      recovered += 1;
    }
  }

  return {
    scanned: all.length,
    running: running.length,
    waiting: waiting.length,
    recovered,
    keptWaiting,
    skipped: all.length - running.length - waiting.length,
  };
}

const globalRef = globalThis as typeof globalThis & {
  __agentRuntimeInitialized?: boolean;
};

export async function initializeAgentRuntime(): Promise<RecoveryResult | null> {
  if (globalRef.__agentRuntimeInitialized) {
    return null;
  }
  globalRef.__agentRuntimeInitialized = true;

  try {
    const result = await recoverTasks();
    console.log(
      `[agent-recovery] scanned=${result.scanned} running=${result.running} waiting=${result.waiting} recovered=${result.recovered} keptWaiting=${result.keptWaiting} skipped=${result.skipped}`,
    );
    return result;
  } catch (error) {
    console.error(
      "[agent-recovery] failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    return null;
  }
}
