import { randomUUID } from "node:crypto";

import * as eventBus from "@/lib/agent/task/event-bus";
import { getTaskStore, type TaskStore } from "@/lib/agent/task/task-store";
import {
  getApprovalStore,
  type ApprovalStore,
} from "@/lib/agent/approval/approval-store";
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

export async function recoverTasks(
  store: TaskStore = getTaskStore(),
  approvalStore: ApprovalStore = getApprovalStore(),
): Promise<RecoveryResult> {
  const all = await store.list();
  const running = all.filter((t) => t.status === "running");
  const waiting = all.filter((t) => t.status === "waiting");

  let recovered = 0;
  let keptWaiting = 0;

  // running → failed（不重跑、不重调 LLM）
  for (const task of running) {
    const reason = "Task interrupted by process restart";
    await store.update(task.id, { error: { code: "RECOVERED", message: reason } });
    await store.transition(task.id, "failed");
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
      await recordRecovery(store, task.id, {
        taskId: task.id,
        previousStatus: "waiting",
        status: "failed",
        reason: "missing_approval",
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
