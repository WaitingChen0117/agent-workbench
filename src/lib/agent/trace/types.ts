/**
 * Agent Trace 数据模型（第七阶段：Observability）
 *
 * Trace 是一个 Task 完整执行过程的聚合 / 可持久化视图，用于事后查看与 Replay。
 * 它由 Event 派生，不替代 Event（Event 是实时流，Trace 是落盘聚合）。
 */

export type TraceStepType = "agent" | "llm" | "tool" | "approval" | "error";

export type TraceStatus =
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface AgentTraceStep {
  stepId: string;
  traceId: string;
  sequence: number; // 按开始顺序递增，Replay 时据此排序
  type: TraceStepType;
  name?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status: TraceStatus;
  input?: unknown; // 已脱敏
  output?: unknown; // 已脱敏
  usage?: LlmUsage; // 仅在 Provider 提供时存在，绝不伪造
}

export interface AgentTrace {
  traceId: string;
  taskId: string;
  startedAt: string;
  endedAt?: string;
  status: TraceStatus;
  steps: AgentTraceStep[];
}

export interface AgentMetrics {
  task: { durationMs?: number; status: TraceStatus };
  agent: { stepCount: number; retryCount: number };
  tool: {
    toolCalls: number;
    toolSuccess: number;
    toolFailure: number;
    toolDurationMs: number;
  };
  approval: {
    approvalCount: number;
    approvalWaitDurationMs: number;
    approvalApproved: number;
    approvalRejected: number;
  };
  llm: { latencyMs: number; tokenUsage?: LlmUsage };
}
