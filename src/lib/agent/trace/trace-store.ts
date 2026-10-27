import type {
  AgentTrace,
  AgentTraceStep,
  TraceStatus,
} from "@/lib/agent/trace/types";
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
  type ListOptions,
  type PageResult,
} from "@/lib/agent/persistence/pagination";
import { SQLiteTraceStore } from "@/lib/agent/trace/sqlite-trace-store";

/**
 * TraceStore 抽象（Phase 10.6-C + 10.7-A 增量化）
 *
 * - createTrace：创建 Trace 头（幂等）
 * - appendStep：事件级增量追加/更新单个 step（按 stepId 幂等；sequence 由 Store 原子分配）
 * - updateSummary：更新 Trace 头状态/结束时间
 * - putTrace：兼容层（整条写入 = createTrace + 替换 steps），供既有调用/评测使用；
 *   新的 Collector 不再每事件整条重写。
 *
 * backend 选择只发生在 getTraceStore()：AGENT_TRACE_STORE=memory|sqlite，默认 memory。
 */
export interface TraceHeader {
  traceId: string;
  taskId: string;
  startedAt: string;
  status: TraceStatus;
}

export interface TraceStore {
  createTrace(header: TraceHeader): void;
  appendStep(taskId: string, step: AgentTraceStep): void;
  updateSummary(
    taskId: string,
    patch: { status?: TraceStatus; endedAt?: string },
  ): void;
  putTrace(trace: AgentTrace): void; // 兼容层
  getByTaskId(taskId: string): AgentTrace | null;
  listByWorkflowExecutionId(executionId: string): AgentTraceStep[];
  listByWorkflowNodeId(executionId: string, nodeId: string): AgentTraceStep[];
  listPage(options: ListOptions): PageResult<AgentTrace>;
  delete(taskId: string): void;
  cleanupTerminalBefore(cutoffIso: string): number;
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

interface MemState {
  headers: Map<string, AgentTrace>; // taskId -> trace (steps inline)
}

class MemoryTraceStore implements TraceStore {
  private readonly s: MemState;
  constructor() {
    const g = globalThis as typeof globalThis & { __agentTraceMem?: MemState };
    this.s = g.__agentTraceMem ?? (g.__agentTraceMem = { headers: new Map() });
  }

  createTrace(header: TraceHeader): void {
    if (this.s.headers.has(header.taskId)) return; // 幂等
    this.s.headers.set(header.taskId, { ...header, steps: [] });
  }
  appendStep(taskId: string, step: AgentTraceStep): void {
    const trace = this.s.headers.get(taskId);
    if (!trace) return;
    const idx = trace.steps.findIndex((x) => x.stepId === step.stepId);
    if (idx >= 0) {
      trace.steps[idx] = { ...step, sequence: trace.steps[idx].sequence };
    } else {
      const maxSeq = trace.steps.reduce((m, x) => Math.max(m, x.sequence), 0);
      trace.steps.push({ ...step, sequence: maxSeq + 1 });
    }
  }
  updateSummary(taskId: string, patch: { status?: TraceStatus; endedAt?: string }): void {
    const trace = this.s.headers.get(taskId);
    if (!trace) return;
    if (patch.status) trace.status = patch.status;
    if (patch.endedAt) trace.endedAt = patch.endedAt;
  }
  putTrace(trace: AgentTrace): void {
    this.s.headers.set(trace.taskId, {
      ...trace,
      steps: trace.steps.map((s, i) => ({ ...s, sequence: i + 1 })),
    });
  }
  getByTaskId(taskId: string): AgentTrace | null {
    const t = this.s.headers.get(taskId);
    if (!t) return null;
    return { ...t, steps: [...t.steps].sort((a, b) => a.sequence - b.sequence) };
  }
  listByWorkflowExecutionId(executionId: string): AgentTraceStep[] {
    const out: AgentTraceStep[] = [];
    for (const t of this.s.headers.values())
      for (const s of t.steps) if (s.executionId === executionId) out.push(s);
    return out.sort((a, b) => a.sequence - b.sequence);
  }
  listByWorkflowNodeId(executionId: string, nodeId: string): AgentTraceStep[] {
    return this.listByWorkflowExecutionId(executionId).filter((s) => s.nodeId === nodeId);
  }
  listPage(options: ListOptions): PageResult<AgentTrace> {
    const limit = clampLimit(options.limit);
    const cursor = decodeCursor<{ started: string; id: string }>(options.cursor);
    const all = [...this.s.headers.values()].sort(
      (a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : a.traceId < b.traceId ? 1 : -1),
    );
    const start = cursor
      ? all.findIndex((t) => t.startedAt < cursor.started || (t.startedAt === cursor.started && t.traceId < cursor.id)) 
      : 0;
    const from = start < 0 ? all.length : start;
    const items = all.slice(from, from + limit);
    const nextCursor =
      from + limit < all.length
        ? encodeCursor({ started: items[items.length - 1].startedAt, id: items[items.length - 1].traceId })
        : undefined;
    return { items: items.map((t) => ({ ...t, steps: [] })), nextCursor };
  }
  delete(taskId: string): void {
    this.s.headers.delete(taskId);
  }
  cleanupTerminalBefore(cutoffIso: string): number {
    let n = 0;
    for (const [taskId, t] of [...this.s.headers.entries()]) {
      if (TERMINAL.has(t.status) && t.endedAt && t.endedAt < cutoffIso) {
        this.s.headers.delete(taskId);
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
    const dbPath = process.env.AGENT_TASK_DB_PATH ?? `${process.cwd()}/.data/agent.sqlite`;
    store = new SQLiteTraceStore(dbPath);
  } else {
    store = new MemoryTraceStore();
  }
  globalRef.__agentTraceStoreImpl = store;
  return store;
}
