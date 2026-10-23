import { NextResponse } from "next/server";

import { getTaskStore } from "@/lib/agent/task/task-store";
import { getApproval, resolveApproval } from "@/lib/agent/approvals";

export const runtime = "nodejs";

/**
 * POST /api/agent/tasks/:taskId/approvals/:approvalId
 * body: { action: "approve" | "reject" }
 *
 * approve → 恢复 Agent Loop（waiting → running）
 * reject  → 取消任务（waiting → cancelled）
 * 实际的状态流转与事件由 Task Runtime 的 Permission Gate 完成，这里只解析决策。
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ taskId: string; approvalId: string }> },
) {
  const { taskId, approvalId } = await params;

  if (!(await getTaskStore().get(taskId))) {
    return NextResponse.json(
      { error: "Task not found", taskId },
      { status: 404 },
    );
  }

  const approval = getApproval(approvalId);

  if (!approval || approval.taskId !== taskId) {
    return NextResponse.json(
      { error: "Approval not found", approvalId },
      { status: 404 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const action = (body as { action?: unknown }).action;

  if (action !== "approve" && action !== "reject") {
    return NextResponse.json(
      { error: "action must be 'approve' or 'reject'" },
      { status: 400 },
    );
  }

  if (approval.status !== "pending") {
    return NextResponse.json(
      { error: `Approval already ${approval.status}`, approvalId },
      { status: 409 },
    );
  }

  const resolved = resolveApproval(approvalId, action);

  return NextResponse.json({
    id: approvalId,
    taskId,
    status: resolved?.status,
  });
}
