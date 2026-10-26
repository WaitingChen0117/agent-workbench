import { NextResponse } from "next/server";

import { getTaskStore } from "@/lib/agent/task/task-store";
import { getSessionStore } from "@/lib/agent/session/session-store";

export const runtime = "nodejs";

/**
 * GET /api/agent/tasks/:taskId/session/summary
 * 轻量摘要：默认不返回完整 messages，只给出计数与当前 pending 的工具/审批。
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await params;

  if (!(await getTaskStore().get(taskId))) {
    return NextResponse.json({ error: "Task not found", taskId }, { status: 404 });
  }

  const store = getSessionStore();
  const session = await store.getByTaskId(taskId);
  if (!session) {
    return NextResponse.json(
      { error: "Session not found", taskId },
      { status: 404 },
    );
  }

  const messages = await store.getMessages(session.sessionId);
  const waiting = await store.getWaitingActions(session.sessionId);
  const pending = waiting[0];

  return NextResponse.json({
    sessionId: session.sessionId,
    taskId: session.taskId,
    status: session.status,
    messageCount: messages.length,
    pendingTool: pending?.toolName ?? null,
    pendingApprovalId: pending?.approvalId ?? null,
  });
}
