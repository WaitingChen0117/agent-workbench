import { NextResponse } from "next/server";

import { getTask } from "@/lib/agent/task/store";
import { getTraceByTask } from "@/lib/agent/trace/store";
import { computeMetrics } from "@/lib/agent/trace/metrics";

export const runtime = "nodejs";

// GET /api/agent/tasks/:taskId/trace/summary —— Trace 概要指标
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await params;

  if (!getTask(taskId)) {
    return NextResponse.json(
      { error: "Task not found", taskId },
      { status: 404 },
    );
  }

  const trace = getTraceByTask(taskId);

  if (!trace) {
    return NextResponse.json(
      { error: "Trace not found", taskId },
      { status: 404 },
    );
  }

  const metrics = computeMetrics(trace);

  return NextResponse.json({
    duration: metrics.task.durationMs,
    status: trace.status,
    stepCount: metrics.agent.stepCount,
    toolCalls: metrics.tool.toolCalls,
    approvals: metrics.approval.approvalCount,
    failures: metrics.tool.toolFailure,
    // 无 token usage 时返回 null，绝不伪造
    tokenUsage: metrics.llm.tokenUsage ?? null,
  });
}
