import { NextResponse } from "next/server";

import { createAndRunTask } from "@/lib/agent/task/runtime";
import type { AgentMessage } from "@/lib/agent/loop";

export const runtime = "nodejs";

// 过滤掉结构不合法的消息，保证传给 Agent 的数据类型安全
function parseMessages(value: unknown): AgentMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (item): item is AgentMessage =>
      typeof item === "object" &&
      item !== null &&
      (item.role === "user" || item.role === "assistant") &&
      typeof item.content === "string" &&
      item.content.trim() !== "",
  );
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const messages = parseMessages(body?.messages);

    if (messages.length === 0) {
      return NextResponse.json({ error: "messages 不能为空" }, { status: 400 });
    }

    // 创建并运行一个可追踪的 Task（pending → running → completed/failed）
    const { task } = await createAndRunTask({ messages });

    // 任务失败：映射成合适的 HTTP 状态码，但始终带上 taskId 与 status
    if (task.status === "failed") {
      const status = task.error?.code === "AGENT_LOOP_LIMIT" ? 409 : 500;

      return NextResponse.json(
        {
          taskId: task.id,
          status: task.status,
          error: task.error,
        },
        { status },
      );
    }

    return NextResponse.json({
      taskId: task.id,
      status: task.status,
      answer: task.answer,
      steps: task.currentStep,
    });
  } catch (error) {
    console.error("[Agent] 执行失败", error);

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Agent 执行失败" },
      { status: 500 },
    );
  }
}
