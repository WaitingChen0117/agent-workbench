import { NextResponse } from "next/server";

import { getWorkflowExecutionStore } from "@/lib/agent/workflow/execution-store";

export const runtime = "nodejs";

// GET /api/agent/workflows/:executionId —— 查询 Workflow 执行状态（从持久化 Store 读取）
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ executionId: string }> },
) {
  const { executionId } = await params;

  const execution = await getWorkflowExecutionStore().get(executionId);

  if (!execution) {
    return NextResponse.json(
      { error: "Execution not found", executionId },
      { status: 404 },
    );
  }

  return NextResponse.json({
    executionId: execution.executionId,
    workflowId: execution.workflowId,
    taskId: execution.taskId,
    status: execution.status,
    currentNodeId: execution.currentNodeId,
    startedAt: execution.startedAt,
    endedAt: execution.endedAt,
    error: execution.error,
    context: execution.context,
  });
}
