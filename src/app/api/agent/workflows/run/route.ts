import { NextResponse } from "next/server";

import { validateWorkflow } from "@/lib/agent/workflow/validator";
import { createAndStartWorkflowTask } from "@/lib/agent/workflow/run";
import type { WorkflowDefinition } from "@/lib/agent/workflow/types";

export const runtime = "nodejs";

// POST /api/agent/workflows/run  body: { workflow: WorkflowDefinition, input?: unknown }
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const workflow = body?.workflow as WorkflowDefinition | undefined;

    if (!workflow || typeof workflow !== "object") {
      return NextResponse.json(
        { error: "workflow is required" },
        { status: 400 },
      );
    }

    // 执行前静态校验：非法 DAG / 缺节点等直接拒绝，不创建 Task
    const validation = validateWorkflow(workflow);
    if (!validation.valid) {
      return NextResponse.json(
        { error: "Invalid workflow", details: validation.errors },
        { status: 400 },
      );
    }

    const execution = createAndStartWorkflowTask({
      definition: workflow,
      input: body?.input,
    });

    return NextResponse.json(
      {
        executionId: execution.executionId,
        taskId: execution.taskId,
        status: execution.status,
      },
      { status: 202 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "workflow run failed" },
      { status: 500 },
    );
  }
}
