import type { AgentTrace } from "@/lib/agent/trace/types";
import { getTraceStore } from "@/lib/agent/trace/trace-store";

/**
 * Trace Store 兼容门面（Phase 10.6-C）。
 *
 * 历史上是内存 Map；现统一经 TraceStore 抽象（Memory / SQLite）。
 * 保持原有同步函数签名，Collector / API 无需改动调用方式。
 */
export function putTrace(trace: AgentTrace): void {
  getTraceStore().putTrace(trace);
}

export function getTraceByTask(taskId: string): AgentTrace | undefined {
  return getTraceStore().getByTaskId(taskId) ?? undefined;
}
