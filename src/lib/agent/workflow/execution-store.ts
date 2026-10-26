import type {
  WorkflowExecution,
  WorkflowNodeExecution,
  WorkflowStatus,
} from "@/lib/agent/workflow/types";
import { SQLiteWorkflowExecutionStore } from "@/lib/agent/workflow/sqlite-execution-store";

/**
 * WorkflowExecutionStore（Phase 10.5）
 *
 * 把 WorkflowExecution / NodeExecution / context 从进程内 Memory 升级为可持久化。
 * backend 选择只发生在 getWorkflowExecutionStore()，Engine / Runtime 不感知 memory / sqlite。
 */
export type WorkflowExecutionPatch = Partial<
  Pick<
    WorkflowExecution,
    "status" | "currentNodeId" | "endedAt" | "error" | "context" | "stepCount"
  >
>;

export interface WorkflowExecutionStore {
  create(execution: WorkflowExecution): Promise<WorkflowExecution>;
  get(executionId: string): Promise<WorkflowExecution | null>;
  getByTaskId(taskId: string): Promise<WorkflowExecution | null>;
  update(
    executionId: string,
    patch: WorkflowExecutionPatch,
  ): Promise<WorkflowExecution | null>;
  transition(
    executionId: string,
    to: WorkflowStatus,
  ): Promise<WorkflowExecution | null>;
  delete(executionId: string): Promise<void>;
  list(): Promise<WorkflowExecution[]>;
  // Node 执行态
  upsertNode(node: WorkflowNodeExecution): Promise<WorkflowNodeExecution>;
  getNode(
    executionId: string,
    nodeId: string,
  ): Promise<WorkflowNodeExecution | null>;
  listNodes(executionId: string): Promise<WorkflowNodeExecution[]>;
}

function nowIso(): string {
  return new Date().toISOString();
}

// PLACEHOLDER_MEMORY

interface MemoryState {
  executions: Map<string, WorkflowExecution>;
  nodes: Map<string, WorkflowNodeExecution>; // key `${executionId}:${nodeId}`
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

class MemoryWorkflowExecutionStore implements WorkflowExecutionStore {
  private readonly s: MemoryState;

  constructor() {
    const g = globalThis as typeof globalThis & {
      __workflowExecutionState?: MemoryState;
    };
    this.s =
      g.__workflowExecutionState ??
      (g.__workflowExecutionState = { executions: new Map(), nodes: new Map() });
  }

  async create(execution: WorkflowExecution): Promise<WorkflowExecution> {
    const stored = { ...execution, updatedAt: nowIso() };
    this.s.executions.set(stored.executionId, clone(stored));
    return clone(stored);
  }
  async get(executionId: string): Promise<WorkflowExecution | null> {
    const e = this.s.executions.get(executionId);
    return e ? clone(e) : null;
  }
  async getByTaskId(taskId: string): Promise<WorkflowExecution | null> {
    const e = [...this.s.executions.values()].find((x) => x.taskId === taskId);
    return e ? clone(e) : null;
  }
  async update(
    executionId: string,
    patch: WorkflowExecutionPatch,
  ): Promise<WorkflowExecution | null> {
    const cur = this.s.executions.get(executionId);
    if (!cur) return null;
    const next = { ...cur, ...patch, updatedAt: nowIso() };
    this.s.executions.set(executionId, clone(next));
    return clone(next);
  }
  async transition(
    executionId: string,
    to: WorkflowStatus,
  ): Promise<WorkflowExecution | null> {
    return this.update(executionId, { status: to });
  }
  async delete(executionId: string): Promise<void> {
    this.s.executions.delete(executionId);
    for (const key of [...this.s.nodes.keys()]) {
      if (key.startsWith(`${executionId}:`)) this.s.nodes.delete(key);
    }
  }
  async list(): Promise<WorkflowExecution[]> {
    return [...this.s.executions.values()].map(clone);
  }
  async upsertNode(node: WorkflowNodeExecution): Promise<WorkflowNodeExecution> {
    this.s.nodes.set(`${node.executionId}:${node.nodeId}`, clone(node));
    return clone(node);
  }
  async getNode(
    executionId: string,
    nodeId: string,
  ): Promise<WorkflowNodeExecution | null> {
    const n = this.s.nodes.get(`${executionId}:${nodeId}`);
    return n ? clone(n) : null;
  }
  async listNodes(executionId: string): Promise<WorkflowNodeExecution[]> {
    return [...this.s.nodes.values()]
      .filter((n) => n.executionId === executionId)
      .map(clone);
  }
}

const globalRef = globalThis as typeof globalThis & {
  __workflowExecutionStore?: WorkflowExecutionStore;
};

export function getWorkflowExecutionStore(): WorkflowExecutionStore {
  if (globalRef.__workflowExecutionStore) return globalRef.__workflowExecutionStore;
  let store: WorkflowExecutionStore;
  if (process.env.AGENT_WORKFLOW_EXECUTION_STORE === "sqlite") {
    const dbPath =
      process.env.AGENT_TASK_DB_PATH ?? `${process.cwd()}/.data/agent.sqlite`;
    store = new SQLiteWorkflowExecutionStore(dbPath);
  } else {
    store = new MemoryWorkflowExecutionStore();
  }
  globalRef.__workflowExecutionStore = store;
  return store;
}
