import type { AgentTaskEvent } from "@/lib/agent/task/types";

/**
 * 内存版 Event Bus
 *
 * 职责单一：按 taskId 做发布 / 订阅，保证不同 Task 的事件相互隔离。
 * 不感知 HTTP、不感知 Agent Runtime —— 仅做事件分发。
 *
 * ⚠️ 仅内存实现，单进程有效。多实例 / 跨进程需替换为 Redis Pub/Sub 等。
 */
export type TaskEventListener = (event: AgentTaskEvent) => void;

interface EventBusState {
  // key = taskId，天然隔离不同 Task 的订阅者
  channels: Map<string, Set<TaskEventListener>>;
}

const globalRef = globalThis as typeof globalThis & {
  __agentEventBus?: EventBusState;
};

const state: EventBusState =
  globalRef.__agentEventBus ??
  (globalRef.__agentEventBus = {
    channels: new Map(),
  });

// 发布：只投递给该 taskId 的订阅者
export function publish(event: AgentTaskEvent): void {
  const listeners = state.channels.get(event.taskId);

  if (!listeners) {
    return;
  }

  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      // 单个订阅者出错不应影响其他订阅者或发布方
      console.error("[EventBus] listener error:", error);
    }
  }
}

// 订阅：返回一个取消订阅的函数，方便调用方清理
export function subscribe(
  taskId: string,
  listener: TaskEventListener,
): () => void {
  const listeners = state.channels.get(taskId) ?? new Set<TaskEventListener>();
  listeners.add(listener);
  state.channels.set(taskId, listeners);

  return () => unsubscribe(taskId, listener);
}

export function unsubscribe(
  taskId: string,
  listener: TaskEventListener,
): void {
  const listeners = state.channels.get(taskId);

  if (!listeners) {
    return;
  }

  listeners.delete(listener);

  // 没有订阅者时移除 channel，避免 Map 无限增长
  if (listeners.size === 0) {
    state.channels.delete(taskId);
  }
}

// 调试辅助：某个 Task 当前的订阅者数量（用于验证无泄漏）
export function listenerCount(taskId: string): number {
  return state.channels.get(taskId)?.size ?? 0;
}
