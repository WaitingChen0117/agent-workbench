import { randomUUID } from "node:crypto";

import { assertTransition } from "@/lib/agent/task/state-machine";
import { SQLiteTaskStore } from "@/lib/agent/task/sqlite-task-store";
import type {
  AgentTask,
  AgentTaskEvent,
  TaskStatus,
} from "@/lib/agent/task/types";
import type { AgentMessage } from "@/lib/agent/loop";
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
  type ListOptions,
  type PageResult,
} from "@/lib/agent/persistence/pagination";
import { incrementPersistenceMetric } from "@/lib/agent/persistence/metrics";

/**
 * TaskStore 抽象（Phase 10.1）
 *
 * Runtime / API 只依赖这个异步接口，不再直接操作 globalThis / Map。
 * 这样后续可以把内存实现替换为 Redis / Database 等持久化方案，
 * 支持 Task Resume / Crash Recovery，而无需改动 Runtime。
 *
 * 接口统一为 async，提前对齐未来持久化的 IO 语义（即使内存实现是同步完成的）。
 */
export interface CreateTaskInput {
  messages: AgentMessage[];
  maxSteps: number;
}

// 更新任务字段（不含 status —— 状态变更必须走 transition 以经过状态机校验）
export type TaskPatch = Partial<
  Omit<AgentTask, "id" | "status" | "createdAt" | "updatedAt">
>;

export interface TaskStore {
  create(input: CreateTaskInput): Promise<AgentTask>;
  get(id: string): Promise<AgentTask | null>;
  update(id: string, patch: TaskPatch): Promise<AgentTask | null>;
  /** 唯一状态变更入口：非法转换抛错；同态为幂等 no-op；不存在返回 null */
  transition(id: string, to: TaskStatus): Promise<AgentTask | null>;
  delete(id: string): Promise<void>;
  list(): Promise<AgentTask[]>;
  listPage(options: ListOptions): Promise<PageResult<AgentTask>>;
  appendEvent(id: string, event: AgentTaskEvent): Promise<void>;
  getEvents(id: string): Promise<AgentTaskEvent[]>;
}

interface MemoryState {
  tasks: Map<string, AgentTask>;
  events: Map<string, AgentTaskEvent[]>;
}

const globalRef = globalThis as typeof globalThis & {
  __agentTaskStoreState?: MemoryState;
  __agentTaskStore?: TaskStore;
};

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 内存实现：Map 挂在 globalThis 上（兼容 HMR），API 为 async 以模拟未来持久化。
 */
export class MemoryTaskStore implements TaskStore {
  private readonly state: MemoryState;

  constructor() {
    this.state =
      globalRef.__agentTaskStoreState ??
      (globalRef.__agentTaskStoreState = {
        tasks: new Map(),
        events: new Map(),
      });
  }

  async create(input: CreateTaskInput): Promise<AgentTask> {
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
    this.state.tasks.set(task.id, task);
    this.state.events.set(task.id, []);
    incrementPersistenceMetric("taskCreates");
    return task;
  }

  async get(id: string): Promise<AgentTask | null> {
    return this.state.tasks.get(id) ?? null;
  }

  async update(id: string, patch: TaskPatch): Promise<AgentTask | null> {
    const task = this.state.tasks.get(id);
    if (!task) return null;
    const updated: AgentTask = { ...task, ...patch, updatedAt: nowIso() };
    this.state.tasks.set(id, updated);
    return updated;
  }

  async transition(id: string, to: TaskStatus): Promise<AgentTask | null> {
    const task = this.state.tasks.get(id);
    if (!task) return null;
    // 幂等：已处于目标状态直接返回（重复 cancel 不报错）
    if (task.status === to) return task;
    assertTransition(task.status, to);
    const updated: AgentTask = { ...task, status: to, updatedAt: nowIso() };
    this.state.tasks.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<void> {
    this.state.events.delete(id);
    this.state.tasks.delete(id);
  }

  async list(): Promise<AgentTask[]> {
    return [...this.state.tasks.values()];
  }

  async listPage(options: ListOptions): Promise<PageResult<AgentTask>> {
    const limit = clampLimit(options.limit);
    const cursor = decodeCursor<{ u: string; id: string }>("task", options.cursor);
    const sorted = [...this.state.tasks.values()].sort((a, b) =>
      a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? 1 : -1,
    );
    const filtered = cursor
      ? sorted.filter(
          (t) => t.updatedAt < cursor.u || (t.updatedAt === cursor.u && t.id < cursor.id),
        )
      : sorted;
    const items = filtered.slice(0, limit);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor:
        filtered.length > limit && last ? encodeCursor("task", { u: last.updatedAt, id: last.id }) : undefined,
    };
  }

  async appendEvent(id: string, event: AgentTaskEvent): Promise<void> {
    const events = this.state.events.get(id) ?? [];
    events.push(event);
    this.state.events.set(id, events);
  }

  async getEvents(id: string): Promise<AgentTaskEvent[]> {
    return this.state.events.get(id) ?? [];
  }
}

// 单例：同一进程唯一的 TaskStore（挂 globalThis 兼容 HMR）。
// Store 选择只发生在这里，Runtime 不感知 memory / sqlite。
export function getTaskStore(): TaskStore {
  if (globalRef.__agentTaskStore) {
    return globalRef.__agentTaskStore;
  }

  let store: TaskStore;
  if (process.env.AGENT_TASK_STORE === "sqlite") {
    const dbPath =
      process.env.AGENT_TASK_DB_PATH ?? `${process.cwd()}/.data/agent.sqlite`;
    store = new SQLiteTaskStore(dbPath);
  } else {
    store = new MemoryTaskStore();
  }

  globalRef.__agentTaskStore = store;
  return store;
}
