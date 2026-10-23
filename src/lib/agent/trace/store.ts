import type { AgentTrace } from "@/lib/agent/trace/types";

/**
 * 内存 Trace Store：Map<taskId, AgentTrace>
 *
 * 一个 Task 对应一个 Trace，按 taskId 查询最直接（Trace API 即以 taskId 为入口）。
 * Task 完成后 Trace 仍保留，可随时查询 / Replay。
 *
 * ⚠️ 内存实现，挂 globalThis 兼容 HMR；生产需持久化。
 */
interface TraceStoreState {
  traces: Map<string, AgentTrace>;
}

const globalRef = globalThis as typeof globalThis & {
  __agentTraceStore?: TraceStoreState;
};

const state: TraceStoreState =
  globalRef.__agentTraceStore ??
  (globalRef.__agentTraceStore = { traces: new Map() });

export function putTrace(trace: AgentTrace): void {
  state.traces.set(trace.taskId, trace);
}

export function getTraceByTask(taskId: string): AgentTrace | undefined {
  return state.traces.get(taskId);
}
