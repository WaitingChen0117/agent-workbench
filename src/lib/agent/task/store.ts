import { randomUUID } from "node:crypto";

import { assertTransition } from "@/lib/agent/task/state-machine";
import type {
  AgentTask,
  AgentTaskEvent,
  TaskStatus,
} from "@/lib/agent/task/types";
import type { AgentMessage } from "@/lib/agent/loop";

/**
 * 内存版 Task Store（Map<string, AgentTask>）
 *
 * ⚠️ 仅用于本阶段的学习与验证。生产环境需要替换成持久化方案
 *    （Redis / PostgreSQL / SQLite 等），否则进程重启或多实例部署会丢任务。
 *
 * 为兼容 Next.js dev 模式下的模块热重载（HMR 会重新 import 模块，
 * 导致模块级变量被重置），把 Map 挂在 globalThis 上，保证同一进程内唯一。
 */
interface TaskStoreState {
  tasks: Map<string, AgentTask>;
  events: Map<string, AgentTaskEvent[]>;
}

const globalRef = globalThis as typeof globalThis & {
  __agentTaskStore?: TaskStoreState;
};

const state: TaskStoreState =
  globalRef.__agentTaskStore ??
  (globalRef.__agentTaskStore = {
    tasks: new Map(),
    events: new Map(),
  });

function nowIso(): string {
  return new Date().toISOString();
}

export interface CreateTaskInput {
  messages: AgentMessage[];
  maxSteps: number;
}

export function createTask(input: CreateTaskInput): AgentTask {
  const timestamp = nowIso();

  const task: AgentTask = {
    id: randomUUID(),
    status: "pending",
    messages: input.messages,
    currentStep: 0,
    maxSteps: input.maxSteps,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  state.tasks.set(task.id, task);
  state.events.set(task.id, []);

  return task;
}

export function getTask(id: string): AgentTask | undefined {
  return state.tasks.get(id);
}

// 更新任务字段（不含 status —— 状态变更必须走 transitionTask 以经过状态机校验）
type TaskPatch = Partial<
  Omit<AgentTask, "id" | "status" | "createdAt" | "updatedAt">
>;

export function updateTask(id: string, patch: TaskPatch): AgentTask {
  const task = state.tasks.get(id);

  if (!task) {
    throw new Error(`Task not found: ${id}`);
  }

  const updated: AgentTask = {
    ...task,
    ...patch,
    updatedAt: nowIso(),
  };

  state.tasks.set(id, updated);

  return updated;
}

// 唯一的状态变更入口：经过状态机校验，非法转换会抛 InvalidTaskTransitionError
export function transitionTask(id: string, to: TaskStatus): AgentTask {
  const task = state.tasks.get(id);

  if (!task) {
    throw new Error(`Task not found: ${id}`);
  }

  assertTransition(task.status, to);

  const updated: AgentTask = {
    ...task,
    status: to,
    updatedAt: nowIso(),
  };

  state.tasks.set(id, updated);

  return updated;
}

export function deleteTask(id: string): boolean {
  state.events.delete(id);
  return state.tasks.delete(id);
}

export function appendEvent(id: string, event: AgentTaskEvent): void {
  const events = state.events.get(id) ?? [];
  events.push(event);
  state.events.set(id, events);
}

export function getEvents(id: string): AgentTaskEvent[] {
  return state.events.get(id) ?? [];
}
