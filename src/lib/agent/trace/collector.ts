import { randomUUID } from "node:crypto";

import * as eventBus from "@/lib/agent/task/event-bus";
import type { AgentTaskEvent } from "@/lib/agent/task/types";
import { getTraceStore } from "@/lib/agent/trace/trace-store";
import type {
  AgentTrace,
  AgentTraceStep,
  TraceStatus,
  TraceStepType,
} from "@/lib/agent/trace/types";

/**
 * Trace Collector
 *
 * 架构：Event Bus → Trace Collector → Trace Store
 * 不在工具里手写 trace.start/end，而是订阅现有 Event，由事件对驱动 Step 的开合。
 * Phase 10.7-A：每次开/合 Step 仅 appendStep（增量），不再每事件整条重写 Trace。
 */

interface SpanState {
  seq: number;
  agent: Map<number, AgentTraceStep>;
  llm: Map<number, AgentTraceStep>;
  tools: Array<{ step: number; tool: string; span: AgentTraceStep }>;
  approvals: Map<string, AgentTraceStep>;
  nodes: Map<string, AgentTraceStep>;
  currentNode?: { workflowId?: string; executionId?: string; nodeId?: string };
  unsubscribe?: () => void;
}

const globalRef = globalThis as typeof globalThis & {
  __agentTraceSpans?: Map<string, SpanState>;
};

const spanStates: Map<string, SpanState> =
  globalRef.__agentTraceSpans ?? (globalRef.__agentTraceSpans = new Map());

function diff(start: string, end: string): number {
  return Date.parse(end) - Date.parse(start);
}

// 关闭一个 span 并增量持久化（幂等 upsert by stepId）
function closeSpan(
  trace: AgentTrace,
  span: AgentTraceStep,
  endedAt: string,
  status: TraceStatus,
) {
  span.endedAt = endedAt;
  span.durationMs = diff(span.startedAt, endedAt);
  span.status = status;
  getTraceStore().appendStep(trace.taskId, span);
}

/**
 * 开始为某个 Task 收集 Trace：初始化 Trace 头 + 订阅该 Task 的事件。
 * 需在 task.created 事件发布之前调用，才能捕获完整生命周期。
 */
export function startTrace(taskId: string): void {
  if (getTraceStore().getByTaskId(taskId)) {
    return; // 幂等
  }

  const trace: AgentTrace = {
    traceId: randomUUID(),
    taskId,
    startedAt: new Date().toISOString(),
    status: "running",
    steps: [],
  };
  getTraceStore().createTrace({
    traceId: trace.traceId,
    taskId: trace.taskId,
    startedAt: trace.startedAt,
    status: trace.status,
  });

  const spans: SpanState = {
    seq: 0,
    agent: new Map(),
    llm: new Map(),
    tools: [],
    approvals: new Map(),
    nodes: new Map(),
  };
  spanStates.set(taskId, spans);

  spans.unsubscribe = eventBus.subscribe(taskId, (event) =>
    handleEvent(trace, spans, event),
  );
}

function openStep(
  trace: AgentTrace,
  spans: SpanState,
  type: TraceStepType,
  startedAt: string,
  partial: Partial<AgentTraceStep>,
): AgentTraceStep {
  spans.seq += 1;
  const step: AgentTraceStep = {
    stepId: randomUUID(),
    traceId: trace.traceId,
    sequence: spans.seq,
    type,
    startedAt,
    status: "running",
    // 若当前处于某个 workflow node 内，自动打上归属标签
    ...(spans.currentNode ?? {}),
    ...partial,
  };
  trace.steps.push(step);
  getTraceStore().appendStep(trace.taskId, step); // 增量 append（打开即落盘）
  return step;
}

function finalize(
  trace: AgentTrace,
  spans: SpanState,
  endedAt: string,
  status: TraceStatus,
): void {
  for (const step of trace.steps) {
    if (!step.endedAt) {
      closeSpan(trace, step, endedAt, status);
    }
  }
  trace.endedAt = endedAt;
  trace.status = status;
  getTraceStore().updateSummary(trace.taskId, { status, endedAt });
  spans.unsubscribe?.();
  spanStates.delete(trace.taskId);
}

function handleEvent(
  trace: AgentTrace,
  spans: SpanState,
  event: AgentTaskEvent,
): void {
  const ts = event.timestamp;
  const data = (event.data ?? {}) as Record<string, unknown>;
  const step = Number(data.step);

  switch (event.type) {
    case "agent.step.started": {
      const s = openStep(trace, spans, "agent", ts, {
        name: `step ${step}`,
        input: { step },
      });
      spans.agent.set(step, s);
      break;
    }
    case "llm.requested": {
      const s = openStep(trace, spans, "llm", ts, { name: `llm (step ${step})` });
      spans.llm.set(step, s);
      break;
    }
    case "message.started": {
      const llm = spans.llm.get(step);
      if (llm && !llm.endedAt) {
        closeSpan(trace, llm, ts, "completed");
        spans.llm.delete(step);
      }
      break;
    }
    // PLACEHOLDER_2
    case "tool.started": {
      const llm = spans.llm.get(step);
      if (llm && !llm.endedAt) {
        closeSpan(trace, llm, ts, "completed");
        spans.llm.delete(step);
      }
      const s = openStep(trace, spans, "tool", ts, {
        name: String(data.tool),
        input: data.input,
      });
      spans.tools.push({ step, tool: String(data.tool), span: s });
      break;
    }
    case "tool.completed": {
      const tool = String(data.tool);
      const idx = spans.tools.findIndex(
        (t) => t.step === step && t.tool === tool && !t.span.endedAt,
      );
      if (idx >= 0) {
        const entry = spans.tools[idx];
        entry.span.output = data.result;
        closeSpan(trace, entry.span, ts, data.success === false ? "failed" : "completed");
        spans.tools.splice(idx, 1);
      }
      break;
    }
    case "approval.required": {
      const s = openStep(trace, spans, "approval", ts, {
        name: String(data.toolName),
        status: "waiting",
        input: { toolName: data.toolName, input: data.input },
      });
      spans.approvals.set(String(data.approvalId), s);
      trace.status = "waiting";
      getTraceStore().updateSummary(trace.taskId, { status: "waiting" });
      break;
    }
    case "approval.approved": {
      const s = spans.approvals.get(String(data.approvalId));
      if (s) {
        closeSpan(trace, s, ts, "completed");
        spans.approvals.delete(String(data.approvalId));
      }
      trace.status = "running";
      getTraceStore().updateSummary(trace.taskId, { status: "running" });
      break;
    }
    case "approval.rejected": {
      const s = spans.approvals.get(String(data.approvalId));
      if (s) {
        closeSpan(trace, s, ts, "cancelled");
        spans.approvals.delete(String(data.approvalId));
      }
      break;
    }
    case "agent.step.completed": {
      const llm = spans.llm.get(step);
      if (llm && !llm.endedAt) {
        closeSpan(trace, llm, ts, "completed");
        spans.llm.delete(step);
      }
      const a = spans.agent.get(step);
      if (a) {
        closeSpan(trace, a, ts, "completed");
        spans.agent.delete(step);
      }
      break;
    }
    case "task.failed": {
      openStep(trace, spans, "error", ts, {
        name: "error",
        endedAt: ts,
        durationMs: 0,
        status: "failed",
        output: data,
      });
      finalize(trace, spans, ts, "failed");
      break;
    }
    case "task.completed":
      finalize(trace, spans, ts, "completed");
      break;
    case "task.cancelled":
      finalize(trace, spans, ts, "cancelled");
      break;
    case "workflow.node.started": {
      spans.currentNode = {
        workflowId: data.workflowId as string | undefined,
        executionId: data.executionId as string | undefined,
        nodeId: data.nodeId as string | undefined,
      };
      const s = openStep(trace, spans, "workflow", ts, {
        name: `${String(data.nodeType ?? "node")}:${String(data.nodeId ?? "")}`,
      });
      if (data.nodeId) {
        spans.nodes.set(String(data.nodeId), s);
      }
      break;
    }
    case "workflow.node.completed":
    case "workflow.node.failed": {
      const s = data.nodeId
        ? spans.nodes.get(String(data.nodeId))
        : undefined;
      if (s) {
        closeSpan(
          trace,
          s,
          ts,
          event.type === "workflow.node.failed" ? "failed" : "completed",
        );
        spans.nodes.delete(String(data.nodeId));
      }
      spans.currentNode = undefined;
      break;
    }
  }
}

/**
 * 跨进程恢复 Trace 收集（Phase 10.6-C）：在新进程 resume 前调用，
 * 载入已持久化的 Trace 并继续订阅后续事件（sequence 从已有最大值续增）。
 */
export function resumeTrace(taskId: string): void {
  if (spanStates.has(taskId)) return; // 本进程已在收集
  const existing = getTraceStore().getByTaskId(taskId);
  if (!existing) {
    startTrace(taskId);
    return;
  }
  const maxSeq = existing.steps.reduce((m, s) => Math.max(m, s.sequence), 0);
  const spans: SpanState = {
    seq: maxSeq,
    agent: new Map(),
    llm: new Map(),
    tools: [],
    approvals: new Map(),
    nodes: new Map(),
  };
  spanStates.set(taskId, spans);
  spans.unsubscribe = eventBus.subscribe(taskId, (event) =>
    handleEvent(existing, spans, event),
  );
}
