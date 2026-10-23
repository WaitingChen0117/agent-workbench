import { NextResponse } from "next/server";

import { getTaskStore } from "@/lib/agent/task/task-store";
import { getTraceByTask } from "@/lib/agent/trace/store";
import { computeMetrics } from "@/lib/agent/trace/metrics";

export const runtime = "nodejs";

// GET /api/agent/tasks/:taskId/trace —— 完整 Trace（用于事后查看 / Replay）
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await params;

  if (!(await getTaskStore().get(taskId))) {
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

  // Replay：steps 按 sequence 排序
  const steps = [...trace.steps].sort((a, b) => a.sequence - b.sequence);

  return NextResponse.json({
    traceId: trace.traceId,
    taskId: trace.taskId,
    status: trace.status,
    startedAt: trace.startedAt,
    endedAt: trace.endedAt,
    steps,
    metrics: computeMetrics(trace),
  });
}
