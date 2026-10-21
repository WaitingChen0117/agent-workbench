import { NextResponse } from "next/server";

import {
  AgentLoopLimitError,
  runAgent,
  type AgentMessage,
} from "@/lib/agent/loop";

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

    const result = await runAgent({ messages });

    return NextResponse.json({
      answer: result.answer,
      toolCalls: result.toolCalls,
      steps: result.steps,
    });
  } catch (error) {
    // Agent Loop 达到步数上限：返回明确的结构化错误，而不是 500 崩溃
    if (error instanceof AgentLoopLimitError) {
      console.error("[Agent] loop limit", error.message);

      return NextResponse.json(
        {
          error: "Agent loop limit reached",
          code: "AGENT_LOOP_LIMIT",
          steps: error.steps,
        },
        { status: 409 },
      );
    }

    console.error("[Agent] 执行失败", error);

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Agent 执行失败" },
      { status: 500 },
    );
  }
}
