import type { AgentTrace, AgentTraceStep } from "@/lib/agent/trace/types";
import { SQLiteTraceStore } from "@/lib/agent/trace/sqlite-trace-store";

/**
 * TraceStore 抽象（Phase 10.6-C）
 *
 * Trace 由 Collector 从 Event 聚合而成（AgentTrace + steps）。此前仅内存态；
 * 现增加 SQLite 持久化以支持跨进程读取 / Replay。node:sqlite 为同步 API，
 * 故 TraceStore 保持同步接口（与现有同步 Collector 调用一致）。
 *
 * backend 选择只发生在 getTraceStore()：AGENT_TRACE_STORE=memory|sqlite，默认 memory。
 */
export interface TraceStore {
  putTrace(trace: AgentTrace): void;
  getByTaskId(taskId: string): AgentTrace | null;
  listByWorkflowExecutionId(executionId: string): AgentTraceStep[];
  listByWorkflowNodeId(executionId: string, nodeId: string): AgentTraceStep[];
  delete(taskId: string): void;
  // TTL cleanup：删除终态且 endedAt 早于 cutoff 的 Trace，返回删除数
  cleanupTerminalBefore(cutoffIso: string): number;
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

class MemoryTraceStore implements TraceStore {
  private readonly traces: Map<string, AgentTrace>;

  constructor() {
    const g = globalThis as typeof globalThis & {
      __agentTraceStore?: Map<string, AgentTrace>;
    };
    this.traces = g.__agentTraceStore ?? (g.__agentTraceStore = new Map());
  }

  putTrace(trace: AgentTrace): void {
    this.traces.set(trace.taskId, trace);
  }
  getByTaskId(taskId: string): AgentTrace | null {
    return this.traces.get(taskId) ?? null;
  }
  listByWorkflowExecutionId(executionId: string): AgentTraceStep[] {
    const steps: AgentTraceStep[] = [];
    for (const t of this.traces.values()) {
      for (const s of t.steps) if (s.executionId === executionId) steps.push(s);
    }
    return steps.sort((a, b) => a.sequence - b.sequence);
  }
  listByWorkflowNodeId(executionId: string, nodeId: string): AgentTraceStep[] {
    return this.listByWorkflowExecutionId(executionId).filter(
      (s) => s.nodeId === nodeId,
    );
  }
  delete(taskId: string): void {
    this.traces.delete(taskId);
  }
  cleanupTerminalBefore(cutoffIso: string): number {
    let n = 0;
    for (const [taskId, t] of [...this.traces.entries()]) {
      if (TERMINAL.has(t.status) && t.endedAt && t.endedAt < cutoffIso) {
        this.traces.delete(taskId);
        n += 1;
      }
    }
    return n;
  }
}

const globalRef = globalThis as typeof globalThis & {
  __agentTraceStoreImpl?: TraceStore;
};

export function getTraceStore(): TraceStore {
  if (globalRef.__agentTraceStoreImpl) return globalRef.__agentTraceStoreImpl;
  let store: TraceStore;
  if (process.env.AGENT_TRACE_STORE === "sqlite") {
    const dbPath =
      process.env.AGENT_TASK_DB_PATH ?? `${process.cwd()}/.data/agent.sqlite`;
    store = new SQLiteTraceStore(dbPath);
  } else {
    store = new MemoryTraceStore();
  }
  globalRef.__agentTraceStoreImpl = store;
  return store;
}
