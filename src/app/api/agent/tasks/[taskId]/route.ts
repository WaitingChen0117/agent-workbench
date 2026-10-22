import { NextResponse } from "next/server";

import { getTask } from "@/lib/agent/task/store";

export const runtime = "nodejs";

// GET /api/agent/tasks/:taskId —— 查询任务状态
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await params;

  const task = getTask(taskId);

  if (!task) {
    return NextResponse.json(
      { error: "Task not found", taskId },
      { status: 404 },
    );
  }

  return NextResponse.json({
    id: task.id,
    status: task.status,
    currentStep: task.currentStep,
    maxSteps: task.maxSteps,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    answer: task.answer,
    error: task.error,
  });
}
