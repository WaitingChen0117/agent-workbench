import { NextResponse } from "next/server";

import {
  createAndRunTask,
  createAndStartTask,
} from "@/lib/agent/task/runtime";
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

/**
 * POST /api/agent
 *
 * 默认（异步）：创建 Task 后立即返回 { taskId, status }，Agent 在后台执行，
 *   客户端通过 GET /api/agent/tasks/:taskId/stream 订阅事件。
 * 兼容（同步）：body 传 { "wait": true } 时 await 到结束，返回 { taskId, status, answer }，
 *   保持第三阶段行为不变。
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();

    const messages = parseMessages(body?.messages);

    if (messages.length === 0) {
      return NextResponse.json({ error: "messages 不能为空" }, { status: 400 });
    }

    const wait = body?.wait === true;

    // -------- 同步模式（兼容旧行为）--------
    if (wait) {
      const { task } = await createAndRunTask({ messages });

      if (task.status === "failed") {
        const status = task.error?.code === "AGENT_LOOP_LIMIT" ? 409 : 500;

        return NextResponse.json(
          { taskId: task.id, status: task.status, error: task.error },
          { status },
        );
      }

      return NextResponse.json({
        taskId: task.id,
        status: task.status,
        answer: task.answer,
        steps: task.currentStep,
      });
    }

    // -------- 异步模式（默认）--------
    const task = createAndStartTask({ messages });

    return NextResponse.json(
      { taskId: task.id, status: task.status },
      { status: 202 },
    );
  } catch (error) {
    console.error("[Agent] 执行失败", error);

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Agent 执行失败" },
      { status: 500 },
    );
  }
}
