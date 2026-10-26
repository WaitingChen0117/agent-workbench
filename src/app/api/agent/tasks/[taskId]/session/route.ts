import { NextResponse } from "next/server";

import { getTaskStore } from "@/lib/agent/task/task-store";
import { getSessionStore } from "@/lib/agent/session/session-store";
import { sanitizeMessageContent } from "@/lib/agent/session/types";

export const runtime = "nodejs";

/**
 * GET /api/agent/tasks/:taskId/session
 * 返回该任务的 Session（含消息历史）。返回前再次脱敏，SQLite 本身即敏感边界，
 * 但 API 出口不信任上游，统一屏蔽潜在凭证。
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

  const messages = (await store.getMessages(session.sessionId)).map((m) => ({
    messageId: m.messageId,
    role: m.role,
    content: sanitizeMessageContent(m.content),
    createdAt: m.createdAt,
  }));

  return NextResponse.json({
    sessionId: session.sessionId,
    taskId: session.taskId,
    status: session.status,
    messageCount: messages.length,
    messages,
  });
}
