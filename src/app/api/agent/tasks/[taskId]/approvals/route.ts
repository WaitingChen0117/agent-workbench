import { NextResponse } from "next/server";

import { getTaskStore } from "@/lib/agent/task/task-store";
import { listApprovals, type AgentApproval } from "@/lib/agent/approvals";

export const runtime = "nodejs";

// 只暴露必要信息，不泄露文件全文等敏感内容
function sanitize(approval: AgentApproval) {
  const input = (approval.input ?? {}) as Record<string, unknown>;
  let summary: unknown = undefined;

  if (approval.toolName === "writeFile") {
    summary = {
      path: input.path,
      contentLength:
        typeof input.content === "string" ? input.content.length : undefined,
    };
  } else if (approval.toolName === "runCommand") {
    summary = { program: input.program, args: input.args, cwd: input.cwd };
  }

  return {
    id: approval.id,
    taskId: approval.taskId,
    toolName: approval.toolName,
    status: approval.status,
    createdAt: approval.createdAt,
    resolvedAt: approval.resolvedAt,
    input: summary,
  };
}

// GET /api/agent/tasks/:taskId/approvals —— 查询该任务的待审批/历史审批
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

  const approvals = listApprovals(taskId).map(sanitize);
  const pending = approvals.filter((a) => a.status === "pending");

  return NextResponse.json({ taskId, pending, approvals });
}
