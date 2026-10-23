import { randomUUID } from "node:crypto";

import * as eventBus from "@/lib/agent/task/event-bus";
import { getTaskStore, type TaskStore } from "@/lib/agent/task/task-store";
import type { AgentTaskEvent } from "@/lib/agent/task/types";

/**
 * Task Resume / Crash Recovery
 *
 * 进程启动时扫描残留的 running / waiting 任务：进程重启后原来的 LLM / tool 执行
 * 与内存态 Approval 都已消失，为避免重复副作用或永久僵尸任务，统一安全收尾为 failed，
 * 并记录 task.recovered 事件（绝不重新执行 running，绝不自动批准 waiting）。
 *
 * recovery 是幂等的：只处理 running/waiting，terminal 状态全部跳过。
 */
export interface RecoveryResult {
  scanned: number;
  running: number;
  waiting: number;
  recovered: number;
  skipped: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function recoverTasks(
  store: TaskStore = getTaskStore(),
): Promise<RecoveryResult> {
  const all = await store.list();
  const running = all.filter((t) => t.status === "running");
  const waiting = all.filter((t) => t.status === "waiting");
  const candidates = [...running, ...waiting];

  for (const task of candidates) {
    const previousStatus = task.status;
    const reason =
      previousStatus === "waiting"
        ? "Approval state lost after process restart"
        : "Task interrupted by process restart";

    await store.update(task.id, { error: { code: "RECOVERED", message: reason } });
    await store.transition(task.id, "failed"); // running/waiting → failed 均为合法转换

    const event: AgentTaskEvent = {
      id: randomUUID(),
      taskId: task.id,
      type: "task.recovered",
      timestamp: nowIso(),
      data: { taskId: task.id, previousStatus, status: "failed", reason },
    };
    await store.appendEvent(task.id, event);
    eventBus.publish(event);
  }

  return {
    scanned: all.length,
    running: running.length,
    waiting: waiting.length,
    recovered: candidates.length,
    skipped: all.length - candidates.length,
  };
}

const globalRef = globalThis as typeof globalThis & {
  __agentRuntimeInitialized?: boolean;
};

/**
 * 进程级一次性初始化：执行 recovery。HMR / 重复调用不会重复 recover。
 * recovery 失败不抛出，避免拖垮 /api/agent；日志不含任何敏感信息。
 */
export async function initializeAgentRuntime(): Promise<RecoveryResult | null> {
  if (globalRef.__agentRuntimeInitialized) {
    return null;
  }
  globalRef.__agentRuntimeInitialized = true;

  try {
    const result = await recoverTasks();
    console.log(
      `[agent-recovery] scanned=${result.scanned} running=${result.running} waiting=${result.waiting} recovered=${result.recovered} skipped=${result.skipped}`,
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
