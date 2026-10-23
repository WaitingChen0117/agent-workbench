import type {
  AgentMetrics,
  AgentTrace,
  AgentTraceStep,
} from "@/lib/agent/trace/types";

/**
 * Metrics 完全从 Trace 派生，不单独维护，避免两套数据不一致。
 */
function durationMs(start?: string, end?: string): number | undefined {
  if (!start || !end) {
    return undefined;
  }
  return Date.parse(end) - Date.parse(start);
}

function sumDurations(steps: AgentTraceStep[]): number {
  return steps.reduce((total, step) => total + (step.durationMs ?? 0), 0);
}

export function computeMetrics(trace: AgentTrace): AgentMetrics {
  const toolSteps = trace.steps.filter((s) => s.type === "tool");
  const approvalSteps = trace.steps.filter((s) => s.type === "approval");
  const llmSteps = trace.steps.filter((s) => s.type === "llm");
  const agentSteps = trace.steps.filter((s) => s.type === "agent");

  const toolFailure = toolSteps.filter((s) => s.status === "failed").length;

  return {
    task: {
      durationMs: durationMs(trace.startedAt, trace.endedAt),
      status: trace.status,
    },
    agent: {
      stepCount: agentSteps.length,
      // retryCount：失败的工具调用数（Agent 需要重试/换路径的次数近似）
      retryCount: toolFailure,
    },
    tool: {
      toolCalls: toolSteps.length,
      toolSuccess: toolSteps.filter((s) => s.status === "completed").length,
      toolFailure,
      toolDurationMs: sumDurations(toolSteps),
    },
    approval: {
      approvalCount: approvalSteps.length,
      approvalWaitDurationMs: sumDurations(approvalSteps),
      approvalApproved: approvalSteps.filter((s) => s.status === "completed")
        .length,
      approvalRejected: approvalSteps.filter((s) => s.status === "cancelled")
        .length,
    },
    llm: {
      latencyMs: sumDurations(llmSteps),
      // token usage 当前 Provider 流不提供，保持 undefined，绝不伪造
      tokenUsage: undefined,
    },
  };
}
